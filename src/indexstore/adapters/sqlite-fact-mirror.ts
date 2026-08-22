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
