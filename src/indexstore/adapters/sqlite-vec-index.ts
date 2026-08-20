// src/indexstore/adapters/sqlite-vec-index.ts
//
// VectorIndex adapter over the sqlite-vec (vec0) substrate — the P2-liftable port seam
// (specs/16 §8). It opens its OWN better-sqlite3 connection (WAL permits multiple
// connections to one search.db) and imports better-sqlite3 + sqlite-vec DIRECTLY — never
// src/memory/ (the v2→legacy boundary forbids it). The DB path is injected by the
// composition layer (Gateway), which is allowed to know the concrete path.
//
// P1 scope: this is the port seam + shared contract, NOT a live write-path swap. P0's
// indexer remains the primary writer; the adapter's writes are exercised by the contract
// suite against a temp DB. It targets the same `chunks` + `chunks_vec0` tables idempotently
// and self-migrates the two columns the port carries beyond P0's schema (lane, created_at).

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { summarizeErrorForLog } from '../../security';
import type { VectorIndex, Chunk, ChunkWithScore, VectorStats } from '../../ports';

/** Thrown when an embedding's length does not match the index's fixed dimension (B3). */
export class VectorDimensionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorDimensionMismatchError';
  }
}

export interface SqliteVecIndexConfig {
  dbPath: string;
  /** Fix the vector dimension eagerly; otherwise it is fixed by the first embedded upsert. */
  dimension?: number;
}

function serializeFloat32(values: number[]): Buffer {
  const arr = Float32Array.from(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

interface ChunkRow {
  chunk_id: string;
  path: string;
  lane: string;
  content: string;
  start_line: number;
  end_line: number;
  created_at: string;
  distance: number;
}

export class SqliteVecIndex implements VectorIndex {
  private readonly db: Database.Database;
  private hasVec = false;
  private dimension: number | null;

  constructor(config: SqliteVecIndexConfig) {
    this.db = new Database(config.dbPath);
    this.dimension = config.dimension ?? null;
    try {
      sqliteVec.load(this.db);
      this.hasVec = true;
    } catch (e) {
      // sqlite-vec is optional (keyword-only fallback). Sanitized log; never crash.
      console.warn('[sqlite-vec-index] sqlite-vec unavailable, vector ops disabled:', summarizeErrorForLog(e));
    }
    this.initSchema();
    if (this.dimension !== null) this.ensureVecTable(this.dimension);
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;

    // Fix / validate the dimension BEFORE preparing vec statements (the vec0 table only
    // exists once a dimension is known).
    for (const c of chunks) {
      if (c.embedding && c.embedding.length > 0) this.assertDimension(c.embedding.length);
    }

    const upsertChunk = this.db.prepare(`
      INSERT INTO chunks (id, path, lane, content, start_line, end_line, created_at, embedding)
      VALUES (@id, @path, @lane, @content, @startLine, @endLine, @createdAt, @embedding)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        lane = excluded.lane,
        content = excluded.content,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        created_at = excluded.created_at,
        embedding = excluded.embedding
    `);
    const deleteVec = this.hasVec ? this.db.prepare('DELETE FROM chunks_vec0 WHERE chunk_id = ?') : null;
    const insertVec = this.hasVec ? this.db.prepare('INSERT INTO chunks_vec0 (chunk_id, embedding) VALUES (?, ?)') : null;

    // One transaction for the whole batch — atomic + avoids N round-trips of autocommit.
    const runBatch = this.db.transaction((rows: Chunk[]) => {
      for (const c of rows) {
        const hasEmbedding = !!c.embedding && c.embedding.length > 0;
        const buf = hasEmbedding ? serializeFloat32(c.embedding as number[]) : null;
        upsertChunk.run({
          id: c.id,
          path: c.path,
          lane: c.lane ?? '',
          content: c.content,
          startLine: c.startLine ?? 0,
          endLine: c.endLine ?? 0,
          createdAt: c.createdAt ?? '',
          embedding: buf,
        });
        if (insertVec && deleteVec) {
          // Keep the vec0 mirror in lock-step with the row (delete-then-insert = idempotent).
          deleteVec.run(c.id);
          if (buf) insertVec.run(c.id, buf);
        }
      }
    });
    runBatch(chunks);
  }

  async *queryKnn(embedding: number[], k: number, filter?: Record<string, unknown>): AsyncIterable<ChunkWithScore> {
    if (this.dimension !== null && embedding.length !== this.dimension) {
      throw new VectorDimensionMismatchError(
        `query embedding dimension ${embedding.length} != index dimension ${this.dimension}`,
      );
    }
    if (!this.hasVec || this.dimension === null || k <= 0) return;

    let rows: ChunkRow[];
    try {
      rows = this.db.prepare(`
        SELECT v.chunk_id, c.path, c.lane, c.content, c.start_line, c.end_line, c.created_at, v.distance
        FROM chunks_vec0 v
        JOIN chunks c ON c.id = v.chunk_id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `).all(serializeFloat32(embedding), k) as ChunkRow[];
    } catch (e) {
      // A vec query error object can echo the embedding — sanitized frame only.
      console.warn('[sqlite-vec-index] knn query failed:', summarizeErrorForLog(e));
      return;
    }

    for (const r of rows) {
      if (filter && !SqliteVecIndex.matchesFilter(r, filter)) continue;
      yield {
        id: r.chunk_id,
        path: r.path,
        lane: r.lane,
        content: r.content,
        startLine: r.start_line,
        endLine: r.end_line,
        createdAt: r.created_at,
        score: 1 / (1 + r.distance), // cosine distance -> bounded (0,1] similarity
      };
    }
  }

  async deleteByPath(targetPath: string): Promise<void> {
    const run = this.db.transaction((p: string) => {
      if (this.hasVec) {
        const ids = this.db.prepare('SELECT id FROM chunks WHERE path = ?').all(p) as Array<{ id: string }>;
        const deleteVec = this.db.prepare('DELETE FROM chunks_vec0 WHERE chunk_id = ?');
        for (const { id } of ids) deleteVec.run(id);
      }
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(p);
    });
    run(targetPath);
  }

  async stats(): Promise<VectorStats> {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
    return { totalChunks: row.n, dimension: this.dimension ?? 0 };
  }

  /** Release the underlying connection. Not part of VectorIndex, but needed for lifecycle/tests. */
  close(): void {
    try {
      this.db.close();
    } catch (e) {
      console.warn('[sqlite-vec-index] close failed:', summarizeErrorForLog(e));
    }
  }

  // ---- internals ---------------------------------------------------------

  private initSchema(): void {
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        content TEXT NOT NULL,
        start_line INTEGER NOT NULL DEFAULT 0,
        end_line INTEGER NOT NULL DEFAULT 0,
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    `);
    // The port's Chunk carries lane + createdAt, which P0's chunks table predates.
    // Self-migrate them so the adapter works over both a fresh temp DB and a live P0 db.
    this.ensureColumn('chunks', 'lane', "lane TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('chunks', 'created_at', "created_at TEXT NOT NULL DEFAULT ''");
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  }

  private ensureVecTable(dim: number): void {
    if (!this.hasVec) return;
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec0 USING vec0(chunk_id TEXT, embedding FLOAT[${dim}] distance_metric=cosine)`,
    );
    this.dimension = dim;
  }

  /** Fix the dimension on first embedded upsert, or reject a mismatch (B3). */
  private assertDimension(dim: number): void {
    if (this.dimension === null) {
      this.ensureVecTable(dim);
      return;
    }
    if (dim !== this.dimension) {
      throw new VectorDimensionMismatchError(
        `upsert embedding dimension ${dim} != index dimension ${this.dimension}`,
      );
    }
  }

  private static matchesFilter(row: ChunkRow, filter: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(filter)) {
      if (key === 'lane' && row.lane !== value) return false;
      if (key === 'path' && row.path !== value) return false;
    }
    return true;
  }
}
