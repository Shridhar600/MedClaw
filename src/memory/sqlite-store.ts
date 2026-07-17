import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as fs from 'fs';
import * as path from 'path';
import type { Chunk, SearchResult } from './types';
import { summarizeErrorForLog, secureMkdir, tightenFile } from '../security';

function serializeFloat32(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function hasNaN(values: number[] | Float32Array): boolean {
  for (let i = 0; i < values.length; i++) {
    if (isNaN(values[i])) return true;
  }
  return false;
}

export class SqliteStore {
  // `db` is mutable to allow the corruption-recovery path to reopen a fresh
  // handle. Reads from tests/runtime go through this field (public). Assigned
  // inside openDatabaseOrRecover (called from the constructor).
  db!: Database.Database;
  private hasVec = false;
  private vecDimensionFixed = false;

  constructor(
    dbPath: string,
    private readonly profileId: string = 'default',
  ) {
    this.openDatabaseOrRecover(dbPath);
  }

  // RES-P0-3: open the DB (and run schema init) inside a guard. A corrupt DB
  // file (garbage bytes / SQLite "file is not a database") only manifests at the
  // first PRAGMA/exec inside init(), not at construction — so the whole
  // open+vec-load+init sequence is wrapped. On a SqliteError we quarantine the
  // bad files (-wal/-shm siblings included) and open a fresh DB. The gateway
  // reindexes from Markdown via indexer.indexAll() at boot, so the fresh DB is
  // fully repopulated automatically. Never throws on corruption (resilience law:
  // try→catch→log→fallback→continue); only genuine non-SQLite errors re-throw.
  private openDatabaseOrRecover(dbPath: string): void {
    this.hasVec = false;
    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath);
      this.db = db;
      this.tryLoadVec(db);
      this.init();
      return;
    } catch (e) {
      // Identify a SQLite corruption-class error in an identity-stable way.
      // `instanceof Database.SqliteError` is NOT identity-stable: if this
      // module and the throwing `better-sqlite3` copy differ (e.g. under some
      // test-runner module layouts), the instanceof check returns false and
      // a corrupt DB would re-throw instead of recovering. Match on the
      // error name + SQLite corruption codes / messages instead. Logic bugs
      // in our own init SQL (generic SQLITE_ERROR) deliberately do NOT match,
      // so a programmer error never silently nukes a valid DB.
      if (!SqliteStore.isSqliteCorruptionError(e)) {
        throw e;
      }
      const reason = summarizeErrorForLog(e);
      // Quarantine FIRST, before any close(): a better-sqlite3 close() on a
      // corrupt handle checkpoints/deletes the -wal/-shm siblings, which would
      // erase the very quarantine evidence we want to preserve.
      this.quarantineCorruptDb(dbPath);
      try {
        db?.close();
      } catch {
        // The corrupt handle may be unusable; best-effort close.
      }
      console.error(
        `[sqlite-store] CORRUPTION DETECTED. DB file quarantined; opened a fresh DB. Reason: ${reason}`,
      );
      this.hasVec = false;
      // Bounded reopen-retry. Under heavier test load the fresh `new
      // Database(path)` + init() can transiently re-fail with a corruption-
      // class error (native better-sqlite3 / WAL-sibling timing after a
      // close() on the corrupt handle). Each attempt unlinks the path + any
      // -wal/-shm siblings first (quarantine already moved the original
      // corrupt file; this only clears post-close leftovers), then opens
      // fresh. Non-corruption errors re-throw immediately. A real corrupt
      // file is already quarantined, so this loop only ever opens a path that
      // does not yet exist — it cannot mask a genuine logic bug.
      let lastReopenError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          try {
            fs.unlinkSync(candidate);
          } catch {
            // already gone — expected
          }
        }
        try {
          db = new Database(dbPath);
          this.db = db;
          this.tryLoadVec(db);
          this.init();
          return;
        } catch (reopenError) {
          lastReopenError = reopenError;
          if (!SqliteStore.isSqliteCorruptionError(reopenError)) {
            throw reopenError;
          }
          // corruption-class transient error → retry (unlink + fresh open)
        }
      }
      throw lastReopenError;
    }
  }

  private tryLoadVec(db: Database.Database): void {
    try {
      sqliteVec.load(db);
      this.hasVec = true;
    } catch (e) {
      // sqlite-vec is optional (BM25-only fallback). Log sanitized; never crash.
      console.warn('[sqlite-store] sqlite-vec not available, vector search disabled:', summarizeErrorForLog(e));
    }
  }

  // Identity-stable SQLite corruption detection (see openDatabaseOrRecover).
  // Duck-typed, NOT `instanceof Error`/`instanceof Database.SqliteError`:
  // under some test-runner module layouts a SECOND copy of better-sqlite3 is
  //resolved (its Error base class lives in a different realm), so the thrown
  // object is `typeof === 'object'` but NOT `instanceof Error`. Matching on
  // the `.code` property / message text is realm-stable and matches SQLite's
  // own corruption errors regardless of which copy threw.
  private static isSqliteCorruptionError(e: unknown): boolean {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') {
      if ([
        'SQLITE_NOTADB',
        'SQLITE_CORRUPT',
        'SQLITE_CORRUPT_VFS',
        'SQLITE_IOERR_READ',
        'SQLITE_IOERR_SHORT_READ',
      ].includes(code)) {
        return true;
      }
    }
    const text = typeof e === 'object' && e !== null && 'message' in e && typeof (e as { message: unknown }).message === 'string'
      ? (e as { message: string }).message
      : String(e);
    return /(?:not a database|database disk image is malformed|file is not a database)/i.test(text);
  }

  // Quarantine the corrupt DB file plus its WAL/SHM siblings to
  // `<path>.corrupt-<stamp>`. Mirrors HeartbeatStore store.ts:150-176. Falls
  // back to unlink if rename is impossible (best-effort; the fresh DB needs the
  // original path available). Quarantined copies are tightened to 0o600.
  private quarantineCorruptDb(dbPath: string): void {
    secureMkdir(path.dirname(dbPath));
    const stamp = Date.now();
    for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (!fs.existsSync(candidate)) continue;
      const quarantined = `${candidate}.corrupt-${stamp}`;
      try {
        fs.renameSync(candidate, quarantined);
        tightenFile(quarantined);
      } catch {
        try {
          fs.unlinkSync(candidate);
        } catch {
          // Give up on this sibling; the fresh open below will overwrite the
          // main file regardless, so a leftover -wal/-shm is non-fatal.
        }
      }
    }
  }

  private init(): void {
    this.db.exec(`PRAGMA journal_mode=WAL;`);

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
      CREATE TABLE IF NOT EXISTS chunk_stats (
        chunk_id TEXT PRIMARY KEY,
        injected_count INTEGER DEFAULT 0,
        used_count INTEGER DEFAULT 0,
        last_used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        event_type TEXT,
        entity TEXT,
        value TEXT,
        ts TEXT
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    try {
      this.db.exec("ALTER TABLE file_hashes ADD COLUMN embedding_model TEXT");
    } catch {
      // Column already exists
    }

    // Migrate legacy vec_meta table (pre-consolidation) into meta, then drop it.
    const vecMetaExists = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vec_meta'",
    ).get();
    if (vecMetaExists) {
      this.db.exec('INSERT OR IGNORE INTO meta (key, value) SELECT key, value FROM vec_meta');
      this.db.exec('DROP TABLE vec_meta');
    }

    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();

    if (this.hasVec) {
      const dim = this.getStoredDimension();
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec0 USING vec0(chunk_id TEXT, embedding FLOAT[${dim}] distance_metric=cosine)`);
    }
  }

  private getStoredDimension(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'embedding_dimension'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 768;
  }

  private setStoredDimension(dim: number): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_dimension', ?)").run(String(dim));
  }

  ensureVecTable(dimension: number): void {
    if (!this.hasVec) return;
    this.vecDimensionFixed = true;
    const currentDim = this.getStoredDimension();
    if (currentDim !== dimension) {
      this.db.exec('DROP TABLE IF EXISTS chunks_vec0');
      this.setStoredDimension(dimension);
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec0 USING vec0(chunk_id TEXT, embedding FLOAT[${dimension}] distance_metric=cosine)`);
    }
  }

  getEmbeddingModel(): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'embedding_model'").get() as { value: string } | undefined;
    return row?.value;
  }

  setEmbeddingModel(model: string): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_model', ?)").run(model);
  }

  vectorSearch(queryEmbedding: Float32Array, topK: number): SearchResult[] {
    if (!this.hasVec) return [];

    const expectedDim = this.getStoredDimension();
    if (queryEmbedding.length !== expectedDim) {
      console.warn(`[sqlite-store] Query embedding dimension mismatch: got ${queryEmbedding.length}, expected ${expectedDim}`);
      return [];
    }

    try {
      const rows = this.db.prepare(`
        SELECT
          v.chunk_id,
          c.path,
          c.content,
          c.start_line,
          c.end_line,
          v.distance
        FROM chunks_vec0 v
        JOIN chunks c ON c.id = v.chunk_id
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `).all(serializeFloat32(queryEmbedding), topK) as Array<{
        chunk_id: string;
        path: string;
        content: string;
        start_line: number;
        end_line: number;
        distance: number;
      }>;

      return rows.map(r => ({
        chunkId: r.chunk_id,
        path: r.path,
        content: r.content,
        score: 1 / (1 + r.distance),
        startLine: r.start_line,
        endLine: r.end_line,
      }));
    } catch (e) {
      console.warn('[sqlite-store] Vector search error:', e);
      return [];
    }
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

    this.db.prepare("DELETE FROM chunks_fts WHERE id = ?").run(chunk.id);
    this.db.prepare(`
      INSERT INTO chunks_fts(id, path, content) VALUES (?, ?, ?)
    `).run(chunk.id, chunk.path, chunk.content);

    if (this.hasVec && chunk.embedding) {
      this.upsertVecChunk(chunk.id, chunk.embedding);
    }
  }

  private upsertVecChunk(chunkId: string, embedding: number[]): void {
    if (embedding.length === 0 || hasNaN(embedding)) {
      console.warn(`[sqlite-store] Skipping vec0 insert for ${chunkId}: empty or NaN embedding`);
      return;
    }
    const expectedDim = this.getStoredDimension();
    if (!this.vecDimensionFixed && embedding.length !== expectedDim) {
      this.db.exec('DROP TABLE IF EXISTS chunks_vec0');
      this.setStoredDimension(embedding.length);
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec0 USING vec0(chunk_id TEXT, embedding FLOAT[${embedding.length}] distance_metric=cosine)`);
      this.vecDimensionFixed = true;
    } else if (embedding.length !== expectedDim) {
      console.warn(`[sqlite-store] Skipping vec0 insert for ${chunkId}: dimension ${embedding.length}, expected ${expectedDim}`);
      return;
    }
    try {
      this.db.prepare("DELETE FROM chunks_vec0 WHERE chunk_id = ?").run(chunkId);
      this.db.prepare("INSERT INTO chunks_vec0(chunk_id, embedding) VALUES (?, ?)").run(chunkId, serializeFloat32(new Float32Array(embedding)));
    } catch (e) {
      console.warn(`[sqlite-store] Failed to insert vec0 for ${chunkId}:`, e);
    }
  }

  deleteByPath(filePath: string): void {
    if (this.hasVec) {
      const chunkIds = (this.db.prepare('SELECT id FROM chunks WHERE path = ?').all(filePath) as Array<{ id: string }>).map(r => r.id);
      for (const id of chunkIds) {
        this.db.prepare("DELETE FROM chunks_vec0 WHERE chunk_id = ?").run(id);
      }
    }
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

  replaceFileIndex(filePath: string, chunks: Chunk[], hash: string, embeddingModel?: string): void {
    const tx = this.db.transaction((pathToReplace: string, nextChunks: Chunk[], nextHash: string, model?: string) => {
      const oldIds = (this.db.prepare('SELECT id FROM chunks WHERE path = ?').all(pathToReplace) as Array<{ id: string }>).map(r => r.id);

      this.db.prepare('DELETE FROM chunks WHERE path = ?').run(pathToReplace);
      this.db.prepare('DELETE FROM chunks_fts WHERE path = ?').run(pathToReplace);

      if (this.hasVec) {
        for (const id of oldIds) {
          this.db.prepare('DELETE FROM chunks_vec0 WHERE chunk_id = ?').run(id);
        }
      }

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

        if (this.hasVec && chunk.embedding && chunk.embedding.length > 0 && !hasNaN(chunk.embedding)) {
          const dim = this.getStoredDimension();
          if (chunk.embedding.length === dim) {
            this.db.prepare('DELETE FROM chunks_vec0 WHERE chunk_id = ?').run(chunk.id);
            this.db.prepare('INSERT INTO chunks_vec0(chunk_id, embedding) VALUES (?, ?)').run(
              chunk.id, serializeFloat32(new Float32Array(chunk.embedding)),
            );
          } else {
            console.warn(`[sqlite-store] Skipping vec0 in replaceFileIndex for ${chunk.id}: dimension ${chunk.embedding.length}, expected ${dim}`);
          }
        }
      }

      const modelValue = model ?? null;
      this.db.prepare(`
        INSERT INTO file_hashes (path, hash, indexed_at, embedding_model)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          hash = excluded.hash,
          indexed_at = excluded.indexed_at,
          embedding_model = excluded.embedding_model
      `).run(pathToReplace, nextHash, new Date().toISOString(), modelValue);
    });

    tx(filePath, chunks, hash, embeddingModel);
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
