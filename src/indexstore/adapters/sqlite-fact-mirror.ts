// src/indexstore/adapters/sqlite-fact-mirror.ts
//
// FactMirror adapter over SQLite — the rebuildable-from-Markdown mirror of the ledger that
// recall Stage 1 reads (P2 Task A1, specs/07 §4). Opens its OWN better-sqlite3 connection to
// the per-profile search.db (WAL permits multiple connections; explicit busy_timeout per D6)
// and imports better-sqlite3 DIRECTLY — never src/memory/ (the v2→legacy boundary forbids it).
// The DB path is injected by the composition layer (Gateway).
//
// Schema ownership (v2-M-3): this layer owns `facts` (+ chunk_stats/events in later A-tasks);
// the P0 sqlite-store owns chunks/chunks_fts/chunks_vec0/meta on the same file.

import Database from 'better-sqlite3';
import { summarizeErrorForLog } from '../../security';
import type { FactMirror, FactRecord } from '../../ports';

export interface SqliteFactMirrorConfig {
  dbPath: string;
}

/**
 * Deterministic entity-head tiebreak (F11): higher version wins; on a version tie the later
 * createdAt wins; on a createdAt tie the higher id wins. `cur` undefined ⇒ candidate wins.
 */
export function headWins(cand: FactRecord, cur: FactRecord | undefined): boolean {
  if (!cur) return true;
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

  async *queryActive(type?: string, entity?: string): AsyncIterable<FactRecord> {
    // Active head only; v0 quarantine sentinels (version < 1) are never surfaced (M-5).
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
    // Paused head only; v0 quarantine sentinels never surface (M-5). KNEE-08 substrate.
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
    // ONE head per entity: max version across all statuses (version >= 1 → excludes v0 sentinels,
    // M-5). The correlated MAX can match multiple rows on a version tie, so we resolve to a single
    // deterministic head (latest createdAt, then highest id) — pinned by the contract (F11). Bounded
    // by entity count (per-profile) — not a full-table slurp.
    const rows = this.db.prepare(`
      SELECT f.json AS json FROM facts f
      WHERE f.version >= 1
        AND f.version = (SELECT MAX(f2.version) FROM facts f2 WHERE f2.entity = f.entity AND f2.version >= 1)
    `).all() as FactRow[];
    const byEntity = new Map<string, FactRecord>();
    for (const r of rows) {
      const parsed = this.parseRow(r);
      if (parsed && headWins(parsed, byEntity.get(parsed.entity))) byEntity.set(parsed.entity, parsed);
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

  /** Release the underlying connection. Not part of FactMirror; needed for lifecycle/tests. */
  close(): void {
    try {
      this.db.close();
    } catch (e) {
      console.warn('[sqlite-fact-mirror] close failed:', summarizeErrorForLog(e));
    }
  }

  // ---- internals ---------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
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
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity, status);
      CREATE INDEX IF NOT EXISTS idx_facts_type ON facts(type, status);
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
      ON CONFLICT(id) DO UPDATE SET
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
    // The full record round-trips via the json column; a corrupt row degrades to skip + warn
    // (resilience — a mirror is always rebuildable from Markdown, never crash a read).
    try {
      return JSON.parse(r.json) as FactRecord;
    } catch (e) {
      console.warn('[sqlite-fact-mirror] skipping unparseable fact row:', summarizeErrorForLog(e));
      return null;
    }
  }
}
