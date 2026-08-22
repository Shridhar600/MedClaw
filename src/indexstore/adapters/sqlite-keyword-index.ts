// src/indexstore/adapters/sqlite-keyword-index.ts
//
// KeywordIndex adapter over SQLite FTS5 — the keyword arm of hybrid recall (P2 Task A2,
// specs/07 §6 Stage 2). Opens its OWN better-sqlite3 connection to the per-profile search.db
// (WAL + explicit busy_timeout, D6) and imports better-sqlite3 DIRECTLY — never src/memory/.
//
// Wraps the same P0-owned `chunks` + `chunks_fts` tables (M-3): in the live system the P0
// sqlite-store inits them first; standalone (contract tests) this adapter creates a compatible
// subset. bm25 `rank` is normalized to (0,1]; queries are OR-joined for recall breadth.

import Database from 'better-sqlite3';
import { summarizeErrorForLog } from '../../security';
import type { KeywordIndex, Chunk, ChunkWithScore } from '../../ports';

export interface SqliteKeywordIndexConfig {
  dbPath: string;
}

interface MatchRow {
  id: string;
  path: string;
  lane: string;
  content: string;
  start_line: number;
  end_line: number;
  created_at: string;
  rank: number;
}

export class SqliteKeywordIndex implements KeywordIndex {
  private readonly db: Database.Database;

  constructor(config: SqliteKeywordIndexConfig) {
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.initSchema();
  }

  async index(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const upsertChunk = this.db.prepare(`
      INSERT INTO chunks (id, path, lane, content, start_line, end_line, created_at)
      VALUES (@id, @path, @lane, @content, @startLine, @endLine, @createdAt)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path, lane = excluded.lane, content = excluded.content,
        start_line = excluded.start_line, end_line = excluded.end_line, created_at = excluded.created_at
    `);
    const deleteFts = this.db.prepare('DELETE FROM chunks_fts WHERE id = ?');
    const insertFts = this.db.prepare('INSERT INTO chunks_fts (id, path, content) VALUES (?, ?, ?)');
    const run = this.db.transaction((rows: Chunk[]) => {
      for (const c of rows) {
        upsertChunk.run({
          id: c.id,
          path: c.path,
          lane: c.lane ?? '',
          content: c.content,
          startLine: c.startLine ?? 0,
          endLine: c.endLine ?? 0,
          createdAt: c.createdAt ?? '',
        });
        deleteFts.run(c.id);
        insertFts.run(c.id, c.path, c.content);
      }
    });
    run(chunks);
  }

  async *match(query: string, k: number, filter?: Record<string, unknown>): AsyncIterable<ChunkWithScore> {
    if (k <= 0) return;
    const matchQuery = SqliteKeywordIndex.toFtsMatchQuery(query);
    if (!matchQuery) return; // empty / punctuation-only → no results, never an error

    // Over-fetch when a post-query metadata filter is present so it can still return up to k.
    const fetch = filter ? k * 5 : k;
    let rows: MatchRow[];
    try {
      rows = this.db.prepare(`
        SELECT c.id AS id, c.path AS path, c.lane AS lane, c.content AS content,
               c.start_line AS start_line, c.end_line AS end_line, c.created_at AS created_at,
               chunks_fts.rank AS rank
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.id
        WHERE chunks_fts MATCH ?
        ORDER BY chunks_fts.rank
        LIMIT ?
      `).all(matchQuery, fetch) as MatchRow[];
    } catch (e) {
      // A malformed FTS query or transient error must not crash a turn (resilience).
      console.warn('[sqlite-keyword-index] match failed:', summarizeErrorForLog(e));
      return;
    }

    let yielded = 0;
    for (const r of rows) {
      if (yielded >= k) break;
      if (filter && !SqliteKeywordIndex.matchesFilter(r, filter)) continue;
      yielded++;
      yield {
        id: r.id,
        path: r.path,
        lane: r.lane,
        content: r.content,
        startLine: r.start_line,
        endLine: r.end_line,
        createdAt: r.created_at,
        // fts5 bm25 `rank` is more-negative for better matches; |rank| grows with relevance.
        // Squash to (0,1] so it combines with cosine in scoreChunk (Stage 2).
        score: SqliteKeywordIndex.normalize(Math.abs(r.rank)),
      };
    }
  }

  async deleteByPath(targetPath: string): Promise<void> {
    const run = this.db.transaction((p: string) => {
      this.db.prepare('DELETE FROM chunks_fts WHERE path = ?').run(p);
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(p);
    });
    run(targetPath);
  }

  /** Release the underlying connection. Not part of KeywordIndex; needed for lifecycle/tests. */
  close(): void {
    try {
      this.db.close();
    } catch (e) {
      console.warn('[sqlite-keyword-index] close failed:', summarizeErrorForLog(e));
    }
  }

  // ---- internals ---------------------------------------------------------

  private initSchema(): void {
    // CREATE IF NOT EXISTS so this no-ops when the P0 store already owns these tables on a
    // shared search.db (M-3: store inits first). Standalone (contract), this creates the subset
    // the keyword arm needs (no `embedding` column — that is the vec adapter's / P0's concern).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        start_line INTEGER NOT NULL DEFAULT 0,
        end_line INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, path, content);
    `);
    // The port's Chunk carries lane + createdAt, which P0's chunks table predates.
    this.ensureColumn('chunks', 'lane', "lane TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('chunks', 'created_at', "created_at TEXT NOT NULL DEFAULT ''");
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  /** Tokenize like the P0 store (Unicode letters/numbers), quote each term, OR-join for recall. */
  private static toFtsMatchQuery(query: string): string | null {
    const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length === 0) return null;
    return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  }

  private static normalize(s: number): number {
    // s = |bm25 rank| ∈ [0, ∞); map monotonically to (0, 1].
    return s / (1 + s);
  }

  private static matchesFilter(row: MatchRow, filter: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(filter)) {
      if (key === 'lane' && row.lane !== value) return false;
      if (key === 'path' && row.path !== value) return false;
    }
    return true;
  }
}
