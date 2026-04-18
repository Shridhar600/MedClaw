// src/memory/sqlite-store.ts
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Chunk, SearchResult } from './types';

export class SqliteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.init();
  }

  private init(): void {
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
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
        USING fts5(id UNINDEXED, path, content);
      CREATE TABLE IF NOT EXISTS file_hashes (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
    `);
  }

  upsertChunk(chunk: Chunk): void {
    const embeddingBuffer = chunk.embedding
      ? Buffer.from(new Float32Array(chunk.embedding).buffer)
      : null;

    this.db.prepare(`
      INSERT INTO chunks (id, path, content, start_line, end_line, embedding)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        content = excluded.content,
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        embedding = excluded.embedding
    `).run(chunk.id, chunk.path, chunk.content, chunk.startLine, chunk.endLine, embeddingBuffer);

    // Sync FTS index - delete existing and re-insert to handle updates
    this.db.prepare("DELETE FROM chunks_fts WHERE id = ?").run(chunk.id);
    this.db.prepare(`
      INSERT INTO chunks_fts(id, path, content) VALUES (?, ?, ?)
    `).run(chunk.id, chunk.path, chunk.content);
  }

  deleteByPath(filePath: string): void {
    this.db.prepare('DELETE FROM chunks WHERE path = ?').run(filePath);
    this.db.prepare("DELETE FROM chunks_fts WHERE path = ?").run(filePath);
    this.db.prepare('DELETE FROM file_hashes WHERE path = ?').run(filePath);
  }

  deleteIndexedPath(filePath: string): void {
    this.deleteByPath(filePath);
  }

  listIndexedPaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM file_hashes').all() as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  getChunksByPath(filePath: string): Chunk[] {
    const rows = this.db.prepare('SELECT id, path, content, start_line, end_line FROM chunks WHERE path = ?').all(filePath) as Array<{
      id: string; path: string; content: string; start_line: number; end_line: number;
    }>;
    return rows.map(r => ({ id: r.id, path: r.path, content: r.content, startLine: r.start_line, endLine: r.end_line }));
  }

  private toFtsMatchQuery(query: string): string | null {
    const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length === 0) {
      return null;
    }

    return tokens
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(' ');
  }

  keywordSearch(query: string, limit: number): SearchResult[] {
    const matchQuery = this.toFtsMatchQuery(query);
    if (!matchQuery) {
      return [];
    }

    const results = this.db.prepare(`
      SELECT
        chunks.id AS chunk_id,
        chunks.path AS path,
        chunks.content AS content,
        chunks.start_line AS start_line,
        chunks.end_line AS end_line,
        chunks_fts.rank AS score
      FROM chunks_fts
      JOIN chunks ON chunks.id = chunks_fts.id
      WHERE chunks_fts MATCH ?
      ORDER BY chunks_fts.rank
      LIMIT ?
    `).all(matchQuery, limit) as Array<{
      chunk_id: string;
      path: string;
      content: string;
      start_line: number;
      end_line: number;
      score: number;
    }>;
    return results.map(r => ({
      chunkId: r.chunk_id,
      path: r.path,
      content: r.content,
      score: Math.abs(r.score),
      startLine: r.start_line,
      endLine: r.end_line,
    }));
  }

  getAllChunksWithEmbeddings(): Array<Chunk & { embedding: number[] | undefined }> {
    const rows = this.db.prepare('SELECT id, path, content, start_line, end_line, embedding FROM chunks').all() as Array<{
      id: string; path: string; content: string; start_line: number; end_line: number; embedding: Buffer | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      path: r.path,
      content: r.content,
      startLine: r.start_line,
      endLine: r.end_line,
      embedding: r.embedding
        ? Array.from(
          new Float32Array(
            r.embedding.buffer,
            r.embedding.byteOffset,
            r.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
          ),
        )
        : undefined,
    }));
  }

  replaceFileIndex(filePath: string, chunks: Chunk[], hash: string): void {
    const tx = this.db.transaction((pathToReplace: string, nextChunks: Chunk[], nextHash: string) => {
      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(pathToReplace);
      this.db.prepare('DELETE FROM chunks_fts WHERE path = ?').run(pathToReplace);

      const chunkStmt = this.db.prepare(`
        INSERT INTO chunks (id, path, content, start_line, end_line, embedding)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          path = excluded.path,
          content = excluded.content,
          start_line = excluded.start_line,
          end_line = excluded.end_line,
          embedding = excluded.embedding
      `);
      const ftsDeleteStmt = this.db.prepare('DELETE FROM chunks_fts WHERE id = ?');
      const ftsInsertStmt = this.db.prepare('INSERT INTO chunks_fts(id, path, content) VALUES (?, ?, ?)');

      for (const chunk of nextChunks) {
        const embeddingBuffer = chunk.embedding
          ? Buffer.from(new Float32Array(chunk.embedding).buffer)
          : null;
        chunkStmt.run(chunk.id, chunk.path, chunk.content, chunk.startLine, chunk.endLine, embeddingBuffer);
        ftsDeleteStmt.run(chunk.id);
        ftsInsertStmt.run(chunk.id, chunk.path, chunk.content);
      }

      this.db.prepare(`
        INSERT INTO file_hashes (path, hash, indexed_at)
        VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          hash = excluded.hash,
          indexed_at = excluded.indexed_at
      `).run(pathToReplace, nextHash, new Date().toISOString());
    });

    tx(filePath, chunks, hash);
  }

  upsertFileHash(filePath: string, hash: string): void {
    this.db.prepare(`
      INSERT INTO file_hashes (path, hash, indexed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        hash = excluded.hash,
        indexed_at = excluded.indexed_at
    `).run(filePath, hash, new Date().toISOString());
  }

  getFileHash(filePath: string): string | undefined {
    const row = this.db.prepare('SELECT hash FROM file_hashes WHERE path = ?').get(filePath) as { hash: string } | undefined;
    return row?.hash;
  }

  close(): void {
    this.db.close();
  }
}
