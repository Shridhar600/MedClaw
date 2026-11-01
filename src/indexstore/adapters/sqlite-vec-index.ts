import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { summarizeErrorForLog } from '../../security';
import type { VectorIndex, Chunk, ChunkWithScore, VectorStats } from '../../ports';

export class VectorDimensionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorDimensionMismatchError';
  }
}

/** Degrades the vector arm; RecallEngine must report it. */
export class VectorIndexUnavailableError extends Error {
  constructor(message = 'vector index is unavailable') {
    super(message);
    this.name = 'VectorIndexUnavailableError';
  }
}

export class VectorQueryFailedError extends Error {
  constructor() {
    super('vector index query failed');
    this.name = 'VectorQueryFailedError';
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
      // Optional; keyword-only fallback, never crash.
      console.warn('[sqlite-vec-index] sqlite-vec unavailable, vector ops disabled:', summarizeErrorForLog(e));
    }
    this.initSchema();
    const existingDimension = this.readExistingDimension();
    if (existingDimension !== null) {
      if (this.dimension !== null && this.dimension !== existingDimension) {
        throw new VectorDimensionMismatchError(
          `configured vector dimension ${this.dimension} != existing index dimension ${existingDimension}`,
        );
      }
      this.dimension = existingDimension;
    } else if (this.dimension !== null) {
      this.ensureVecTable(this.dimension);
    }
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    if (chunks.length === 0) return;

    // Validate the dimension before preparing vec statements; the table needs a known dimension.
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

    // One transaction for the whole batch.
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
          // Keep the vec0 mirror in lock-step with the row (delete-then-insert is idempotent).
          deleteVec.run(c.id);
          if (buf) insertVec.run(c.id, buf);
        }
      }
    });
    runBatch(chunks);
  }

  async *queryKnn(embedding: number[], k: number, filter?: Record<string, unknown>): AsyncIterable<ChunkWithScore> {
    if (k <= 0) return;
    if (!this.hasVec) throw new VectorIndexUnavailableError();
    // The live adapter may have no configured dimension; never adopt the query's length as truth.
    if (this.dimension === null) {
      const existingDimension = this.readExistingDimension();
      if (existingDimension !== null) this.dimension = existingDimension;
      else if (!this.vectorTableExists()) this.ensureVecTable(embedding.length);
      else throw new VectorIndexUnavailableError('vector index dimension is unavailable');
    }
    if (this.dimension !== null && embedding.length !== this.dimension) {
      throw new VectorDimensionMismatchError(
        `query embedding dimension ${embedding.length} != index dimension ${this.dimension}`,
      );
    }
    if (this.dimension === null) throw new VectorIndexUnavailableError('vector index dimension is unavailable');

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
      // A vec query error object can echo the embedding, so log a sanitized frame only.
      console.warn('[sqlite-vec-index] knn query failed:', summarizeErrorForLog(e));
      throw new VectorQueryFailedError();
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

  /** Not part of VectorIndex; used by lifecycle code. */
  close(): void {
    try {
      this.db.close();
    } catch (e) {
      console.warn('[sqlite-vec-index] close failed:', summarizeErrorForLog(e));
    }
  }

  // The memory store is the primary writer; this adapter mirrors the same chunks/chunks_vec0 tables.
  private initSchema(): void {
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        lane TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        start_line INTEGER NOT NULL DEFAULT 0,
        end_line INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
    `);
  }


  private ensureVecTable(dim: number): void {
    if (!this.hasVec) return;
    const existingDimension = this.readExistingDimension();
    if (existingDimension !== null && existingDimension !== dim) {
      this.dimension = existingDimension;
      throw new VectorDimensionMismatchError(
        `query embedding dimension ${dim} != index dimension ${existingDimension}`,
      );
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec0 USING vec0(chunk_id TEXT, embedding FLOAT[${dim}] distance_metric=cosine)`,
    );
    this.dimension = dim;
  }

  private vectorTableExists(): boolean {
    const row = this.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec0'").get() as { present: number } | undefined;
    return row?.present === 1;
  }

  private readExistingDimension(): number | null {
    if (this.vectorTableExists()) {
      const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec0'").get() as { sql: string | null } | undefined;
      const match = row?.sql?.match(/FLOAT\[(\d+)\]/i);
      const dimension = match ? Number.parseInt(match[1], 10) : NaN;
      if (Number.isInteger(dimension) && dimension > 0) return dimension;
    }
    try {
      const meta = this.db.prepare("SELECT value FROM meta WHERE key = 'embedding_dimension'").get() as { value: string } | undefined;
      const fromMeta = meta ? Number.parseInt(meta.value, 10) : NaN;
      if (Number.isInteger(fromMeta) && fromMeta > 0) return fromMeta;
    } catch {
      // Standalone adapter databases have no meta table; inspect sqlite_master instead.
    }
    if (!this.vectorTableExists()) return null;
    return null;
  }

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
