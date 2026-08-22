// src/indexstore/adapters/sqlite-chunk-stats.ts
//
// ChunkStatsWriter adapter over SQLite — recall usage telemetry (P2 Task A3, specs/07 §6 Stage 4).
// The `chunk_stats` schema existed since P0 but nothing ever wrote it; this closes that. Own
// better-sqlite3 connection to the per-profile search.db (WAL + busy_timeout); mirror-layer owned.

import Database from 'better-sqlite3';
import { summarizeErrorForLog } from '../../security';
import type { ChunkStatsWriter, ChunkStat } from '../../ports';

export interface SqliteChunkStatsConfig {
  dbPath: string;
}

interface StatRow {
  chunk_id: string;
  injected_count: number;
  used_count: number;
  last_used_at: string | null;
}

export class SqliteChunkStats implements ChunkStatsWriter {
  private readonly db: Database.Database;

  constructor(config: SqliteChunkStatsConfig) {
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_stats (
        chunk_id TEXT PRIMARY KEY,
        injected_count INTEGER DEFAULT 0,
        used_count INTEGER DEFAULT 0,
        last_used_at TEXT
      );
    `);
  }

  async bumpInjected(chunkIds: string[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO chunk_stats (chunk_id, injected_count, used_count)
      VALUES (?, 1, 0)
      ON CONFLICT(chunk_id) DO UPDATE SET injected_count = injected_count + 1
    `);
    const run = this.db.transaction((ids: string[]) => { for (const id of ids) stmt.run(id); });
    run(chunkIds);
  }

  async bumpUsed(chunkIds: string[], at: string): Promise<void> {
    if (chunkIds.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO chunk_stats (chunk_id, injected_count, used_count, last_used_at)
      VALUES (@id, 0, 1, @at)
      ON CONFLICT(chunk_id) DO UPDATE SET used_count = used_count + 1, last_used_at = @at
    `);
    const run = this.db.transaction((ids: string[]) => { for (const id of ids) stmt.run({ id, at }); });
    run(chunkIds);
  }

  async get(chunkId: string): Promise<ChunkStat | null> {
    const r = this.db.prepare('SELECT chunk_id, injected_count, used_count, last_used_at FROM chunk_stats WHERE chunk_id = ?').get(chunkId) as StatRow | undefined;
    if (!r) return null;
    return {
      chunkId: r.chunk_id,
      injectedCount: r.injected_count,
      usedCount: r.used_count,
      lastUsedAt: r.last_used_at ?? undefined,
    };
  }

  /** Release the underlying connection. Not part of the port; needed for lifecycle/tests. */
  close(): void {
    try {
      this.db.close();
    } catch (e) {
      console.warn('[sqlite-chunk-stats] close failed:', summarizeErrorForLog(e));
    }
  }
}
