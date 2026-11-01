import Database from 'better-sqlite3';
import { summarizeErrorForLog } from '../../security';
import type { FactMirror, FactRecord } from '../../ports';

export interface SqliteFactMirrorConfig {
  dbPath: string;
}

export function headWins(cand: FactRecord, cur: FactRecord | undefined): boolean {
  if (!cur) return true;
  const candActive = cand.status === 'active';
  const curActive = cur.status === 'active';
  if (candActive !== curActive) return candActive;
  if (cand.version !== cur.version) return cand.version > cur.version;
  if (cand.createdAt !== cur.createdAt) return cand.createdAt > cur.createdAt;
  return cand.id > cur.id;
}

interface FactRow {
  json: string;
}

export class SqliteFactMirror implements FactMirror {
  private readonly db: Database.Database;

  constructor(config: SqliteFactMirrorConfig) {
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initSchema();
  }

  async upsert(facts: FactRecord[]): Promise<void> {
    if (facts.length === 0) return;
    const stmt = this.upsertStmt();
    const run = this.db.transaction((rows: FactRecord[]) => {
      for (const f of rows) stmt.run(this.toParams(f));
    });
    run(facts);
  }

  async replaceType(type: string, facts: FactRecord[]): Promise<void> {
    const replace = this.db.transaction((scope: string, rows: FactRecord[]) => {
      this.db.prepare('DELETE FROM facts WHERE type = ?').run(scope);
      const stmt = this.upsertStmt();
      for (const f of rows) stmt.run(this.toParams(f));
    });
    replace(type, facts);
  }

  async replaceScope(type: string, entity: string, facts: FactRecord[]): Promise<void> {
    const replace = this.db.transaction((scopeType: string, scopeEntity: string, rows: FactRecord[]) => {
      this.db.prepare('DELETE FROM facts WHERE type = ? AND entity = ?').run(scopeType, scopeEntity);
      const stmt = this.upsertStmt();
      for (const f of rows) stmt.run(this.toParams(f));
    });
    replace(type, entity, facts);
  }

  async *queryActive(type?: string, entity?: string): AsyncIterable<FactRecord> {
    // v0 quarantine sentinels never surface.
    let sql = "SELECT json FROM facts WHERE status = 'active' AND version >= 1";
    const params: unknown[] = [];
    if (type !== undefined) {
      sql += ' AND type = ?';
      params.push(type);
    }
    if (entity !== undefined) {
      sql += ' AND entity = ?';
      params.push(entity);
    }
    const rows = this.db.prepare(sql).all(...params) as FactRow[];
    for (const r of rows) {
      const parsed = this.parseRow(r);
      if (parsed) yield parsed;
    }
  }

  async *queryPaused(type?: string): AsyncIterable<FactRecord> {
    let sql = "SELECT json FROM facts WHERE status = 'paused' AND version >= 1";
    const params: unknown[] = [];
    if (type !== undefined) {
      sql += ' AND type = ?';
      params.push(type);
    }
    const rows = this.db.prepare(sql).all(...params) as FactRow[];
    for (const r of rows) {
      const parsed = this.parseRow(r);
      if (parsed) yield parsed;
    }
  }

  async *queryEntityHeads(): AsyncIterable<FactRecord> {
    // One head per (type, entity); the window bounds the rows the JS reducer sees.
    const rows = this.db.prepare(`
      SELECT json FROM (
        SELECT f.json AS json,
          ROW_NUMBER() OVER (
            PARTITION BY f.type, f.entity
            ORDER BY
              CASE WHEN f.status = 'active' THEN 1 ELSE 0 END DESC,
              f.version DESC,
              f.created_at DESC,
              f.id DESC
          ) AS head_rank
        FROM facts f
        WHERE f.version >= 1
      )
      WHERE head_rank = 1
    `).all() as FactRow[];
    const byEntity = new Map<string, FactRecord>();
    for (const r of rows) {
      const parsed = this.parseRow(r);
      if (!parsed) continue;
      const key = `${parsed.type}::${parsed.entity}`;
      if (headWins(parsed, byEntity.get(key))) byEntity.set(key, parsed);
    }
    for (const h of byEntity.values()) yield h;
  }

  async rebuild(all: FactRecord[]): Promise<void> {
    const clearAndFill = this.db.transaction((rows: FactRecord[]) => {
      this.db.prepare('DELETE FROM facts').run();
      const stmt = this.upsertStmt();
      for (const f of rows) stmt.run(this.toParams(f));
    });
    clearAndFill(all);
  }

  /** Not part of FactMirror; used by lifecycle code. */
  close(): void {
    try {
      this.db.close();
    } catch (e) {
      console.warn('[sqlite-fact-mirror] close failed:', summarizeErrorForLog(e));
    }
  }

  // Owns `facts`; the sqlite-store owns chunks/chunks_fts/chunks_vec0/meta on the same file.
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT NOT NULL,
        profile_id TEXT,
        entity TEXT,
        type TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        supersedes TEXT,
        superseded_by TEXT,
        safety_relevant INTEGER NOT NULL DEFAULT 0,
        authority TEXT,
        confidence REAL,
        episode_id TEXT,
        created_at TEXT,
        json TEXT NOT NULL,
        PRIMARY KEY (type, id)
      );
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity, status);
      CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(type, status);
      CREATE INDEX IF NOT EXISTS idx_facts_entity_head
        ON facts(type, entity, status, version DESC, created_at DESC, id DESC);
    `);
  }


  private upsertStmt(): Database.Statement {
    return this.db.prepare(`
      INSERT INTO facts
        (id, profile_id, entity, type, version, status, supersedes, superseded_by,
         safety_relevant, authority, confidence, episode_id, created_at, json)
      VALUES
        (@id, @profileId, @entity, @type, @version, @status, @supersedes, @supersededBy,
         @safetyRelevant, @authority, @confidence, @episodeId, @createdAt, @json)
      ON CONFLICT(type, id) DO UPDATE SET
        profile_id = excluded.profile_id,
        entity = excluded.entity,
        type = excluded.type,
        version = excluded.version,
        status = excluded.status,
        supersedes = excluded.supersedes,
        superseded_by = excluded.superseded_by,
        safety_relevant = excluded.safety_relevant,
        authority = excluded.authority,
        confidence = excluded.confidence,
        episode_id = excluded.episode_id,
        created_at = excluded.created_at,
        json = excluded.json
    `);
  }

  private toParams(f: FactRecord): Record<string, unknown> {
    return {
      id: f.id,
      profileId: f.profileId,
      entity: f.entity,
      type: f.type,
      version: f.version,
      status: f.status,
      supersedes: f.supersedes ?? null,
      supersededBy: f.supersededBy ?? null,
      safetyRelevant: f.safetyRelevant ? 1 : 0,
      authority: f.authority,
      confidence: f.confidence,
      episodeId: f.episodeId ?? null,
      createdAt: f.createdAt,
      json: JSON.stringify(f),
    };
  }

  private parseRow(r: FactRow): FactRecord | null {
    // A mirror is rebuildable; never crash a read on a corrupt row.
    try {
      return JSON.parse(r.json) as FactRecord;
    } catch (e) {
      console.warn('[sqlite-fact-mirror] skipping unparseable fact row:', summarizeErrorForLog(e));
      return null;
    }
  }
}
