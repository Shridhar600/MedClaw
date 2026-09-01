// src/indexstore/session-index.ts
//
// SessionIndex adapter over SQLite FTS5 — verbatim `session_search` (PLAT-20, spec 14 §2) over the
// append-only day-file archive. This is the LOSSLESSNESS substrate: prune (D3) replaces in-window tool
// results with a marker, and the verbatim original is always retrievable here.
//
// Mirrors the `SqliteKeywordIndex` idiom: opens its OWN better-sqlite3 connection to the per-profile
// search.db (WAL + explicit busy_timeout) and imports better-sqlite3 DIRECTLY — never a gateway/legacy
// module (v2-core boundary). It owns its own `session_turns` (metadata) + `session_turns_fts` (content)
// tables, independent of the P0 chunk tables.
//
// Per-chat isolation (Wave-D panel X-1/X-2): every row carries a `chat_id`, and the primary key is
// `<chatId>#<file>#<line>` so two chats sharing a day-file basename never collide, and `search` filters
// by chat so one chat can never read another chat's health turns. In the per-chat layout the directory
// component is authoritative; a flat legacy archive falls back to the JSONL field for its scope.
//
// A-M1: plain contentful FTS5 + a companion metadata table (NOT external-content — the content lives in
// JSONL on disk). Anchors are the day-file `{file, line}` (physical non-empty line numbers), the same the
// SessionManager append path assigns, so a rebuilt row resolves to the exact JSONL line.

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { summarizeErrorForLog, tightenFile } from '../security';

export interface SqliteSessionIndexConfig {
  dbPath: string;
  /**
   * The day-file archive root. Enables rebuild-from-disk on empty / corruption / a durable dirty marker
   * (A-MF4 / D2.3 / H5). When omitted, the index still works for incremental indexing but cannot self-heal.
   */
  sessionsDir?: string;
}

export interface SessionHit {
  /** The chat the turn belongs to (per-chat isolation). */
  chatId: string;
  file: string;
  line: number;
  role: string;
  ts: string;
  /** The turn content, verbatim (PLAT-20: exact clinical text returned unchanged). */
  snippet: string;
}

export interface SessionSearchResult {
  hits: SessionHit[];
  /** `full` on a successful FTS query; `failed` when the store errored (never throws). */
  status: 'full' | 'keyword-only' | 'failed';
}

interface HitRow {
  chatId: string;
  file: string;
  line: number;
  role: string;
  ts: string;
  content: string;
}

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DEFAULT_LIMIT = 20;

export class SqliteSessionIndex {
  private readonly db: Database.Database;
  private readonly dbPath: string;
  private readonly sessionsDir?: string;
  private readonly dirtyMarkerPath: string;

  constructor(config: SqliteSessionIndexConfig) {
    this.dbPath = config.dbPath;
    this.dirtyMarkerPath = `${config.dbPath}.session-dirty`;
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.sessionsDir = config.sessionsDir;
    this.initSchema();
    // H10: better-sqlite3 creates search.db + its -wal/-shm siblings 0644 (world-readable PHI). Tighten
    // all three to 0600 after the WAL pragma + schema created them. Warn-and-continue (never crash).
    this.hardenDbFiles();
    // Rebuild-from-disk when the archive is present AND the index is untrustworthy: empty (post-migration
    // / dropped — A-MF4), a durable dirty marker from a swallowed incremental failure (H5), or FTS/metadata
    // parity is broken (a dropped derived table left stale metadata — H8). Never throws out of the ctor.
    try {
      if (this.sessionsDir && (this.isEmpty() || this.dirtyMarkerExists() || this.ftsParityBroken())) {
        this.resetDerivedTables();
        if (this.rebuildFromDayFiles()) this.clearDirtyMarker();
      }
    } catch (e) {
      console.warn('[session-index] boot rebuild skipped:', summarizeErrorForLog(e));
    }
  }

  /** Index (or re-index) one archive line for a chat. Idempotent per `<chatId>#<file>#<line>` (upsert). */
  indexTurn(chatId: string, file: string, line: number, role: string, ts: string, content: string): void {
    this.db.transaction(() => this.writeTurn(chatId, file, line, role, ts, content))();
  }

  /**
   * H5: record that an incremental index write was lost (a swallowed failure in the append path), durably,
   * so the NEXT construction rebuilds from the archive and closes the hole even though the db is non-empty.
   * Best-effort — a marker-write failure only forgoes the durable reconcile, never crashes the turn.
   */
  markDirty(): void {
    try {
      fs.writeFileSync(this.dirtyMarkerPath, new Date().toISOString());
      tightenFile(this.dirtyMarkerPath);
    } catch (e) {
      console.warn('[session-index] could not write dirty marker:', summarizeErrorForLog(e));
    }
  }

  /**
   * Verbatim search over one chat's archive. Exact-phrase first (all tokens, adjacent — PLAT-20 "all
   * match"), OR-joined fallback for recall, ordered by recency. `chatId` scopes the result to that chat
   * (omit only for maintenance/tests). Never throws: a corrupt/dropped derived table is reset + rebuilt
   * from disk and retried once; any residual error degrades to an empty `failed` result (resilience).
   */
  search(query: string, opts?: { chatId?: string; limit?: number }): SessionSearchResult {
    const limit = opts?.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
    try {
      return { hits: this.runSearch(query, limit, opts?.chatId), status: 'full' };
    } catch (e) {
      if (this.sessionsDir && SqliteSessionIndex.isCorruptionError(e)) {
        try {
          // H8: a dropped/damaged derived table is not repaired by an upsert — reset both tables, then
          // rebuild the whole archive before retrying.
          this.resetDerivedTables();
          const complete = this.rebuildFromDayFiles();
          if (complete) this.clearDirtyMarker();
          return { hits: this.runSearch(query, limit, opts?.chatId), status: complete ? 'full' : 'failed' };
        } catch (e2) {
          console.warn('[session-index] search failed after rebuild:', summarizeErrorForLog(e2));
          return { hits: [], status: 'failed' };
        }
      }
      console.warn('[session-index] search failed:', summarizeErrorForLog(e));
      return { hits: [], status: 'failed' };
    }
  }

  /**
   * Re-index every day file under `sessionsDir` in ONE transaction (N-4: a crash mid-rebuild leaves the
   * index untouched, so the emptiness trigger can re-fire — no partial index). Line numbers are physical
   * non-empty positions (malformed lines occupy their slot but are not indexed), matching the append
   * path's anchor assignment. In a per-chat layout the containing directory supplies the chat scope; a
   * flat legacy file falls back to its embedded chatId. Idempotent via the `<chatId>#<file>#<line>` upsert.
   */
  rebuildFromDayFiles(sessionsDir?: string): boolean {
    const root = sessionsDir ?? this.sessionsDir;
    if (!root) return true;
    const listing = SqliteSessionIndex.listDayFilePaths(root);
    const files = listing.paths;
    let complete = listing.complete;
    this.db.transaction(() => {
      for (const fp of files) {
        const base = path.basename(fp);
        const subdir = SqliteSessionIndex.subdirChatId(root, fp);
        let lines: string[];
        try {
          lines = fs.readFileSync(fp, 'utf-8').split('\n').filter((l) => l.length > 0);
        } catch (e) {
          console.warn('[session-index] rebuild: unreadable day file skipped:', summarizeErrorForLog(e));
          complete = false;
          continue;
        }
        for (let i = 0; i < lines.length; i++) {
          const lineNo = i + 1; // 1-based physical non-empty line — the anchor the append path assigns
          let entry: { role?: unknown; content?: unknown; timestamp?: unknown; chatId?: unknown };
          try {
            entry = JSON.parse(lines[i]);
          } catch {
            continue; // malformed slot: not indexable, but lineNo already advanced (anchor stays aligned)
          }
          const content = entry.content;
          if (typeof content !== 'string' || content.length === 0) continue; // nothing textual to index
          const role = typeof entry.role === 'string' ? entry.role : '';
          const ts = typeof entry.timestamp === 'string' ? entry.timestamp : '';
          // A per-chat directory is the trust boundary. Never let a JSONL field reassign a line to a
          // different chat. Flat legacy archives have no directory scope, so use their embedded field.
          const chatId = subdir || (typeof entry.chatId === 'string' && entry.chatId.length > 0
            ? entry.chatId
            : undefined);
          if (!chatId) continue;
          this.writeTurn(chatId, base, lineNo, role, ts, content);
        }
      }
    })();
    if (!complete) this.markDirty();
    return complete;
  }

  /** C-12: reset stale derived anchors, rebuild from the append-only archive, then clear dirty state. */
  reconcileFromDayFiles(): boolean {
    this.resetDerivedTables();
    const complete = this.rebuildFromDayFiles();
    if (complete) this.clearDirtyMarker();
    return complete;
  }

  isEmpty(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM session_turns').get() as { c: number };
    return row.c === 0;
  }

  close(): void {
    try {
      this.db.close();
    } catch (e) {
      console.warn('[session-index] close failed:', summarizeErrorForLog(e));
    }
  }

  // ---- internals ---------------------------------------------------------

  private runSearch(query: string, limit: number, chatId?: string): SessionHit[] {
    const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length === 0) return []; // empty / punctuation-only → no results, not an error

    // Exact-phrase first (adjacency ⇒ all tokens present, in order). Fall back to OR for recall.
    const phrase = `"${tokens.map(SqliteSessionIndex.escapeFts).join(' ')}"`;
    let hits = this.matchRows(phrase, limit, chatId);
    if (hits.length === 0 && tokens.length > 1) {
      const or = tokens.map((t) => `"${SqliteSessionIndex.escapeFts(t)}"`).join(' OR ');
      hits = this.matchRows(or, limit, chatId);
    }
    return hits;
  }

  private matchRows(matchQuery: string, limit: number, chatId?: string): SessionHit[] {
    const scope = chatId !== undefined ? 'AND m.chat_id = @chatId' : '';
    const rows = this.db.prepare(`
      SELECT m.chat_id AS chatId, m.file AS file, m.line AS line, m.role AS role, m.ts AS ts, f.content AS content
      FROM session_turns_fts f
      JOIN session_turns m ON m.id = f.id
      WHERE session_turns_fts MATCH @q ${scope}
      ORDER BY m.ts DESC, m.rowid DESC
      LIMIT @limit
    `).all({ q: matchQuery, chatId, limit }) as HitRow[];
    return rows.map((r) => ({ chatId: r.chatId, file: r.file, line: r.line, role: r.role, ts: r.ts, snippet: r.content }));
  }

  private writeTurn(chatId: string, file: string, line: number, role: string, ts: string, content: string): void {
    const id = `${chatId}#${file}#${line}`;
    this.db.prepare(`
      INSERT INTO session_turns (id, chat_id, file, line, role, ts) VALUES (@id, @chatId, @file, @line, @role, @ts)
      ON CONFLICT(id) DO UPDATE SET chat_id = excluded.chat_id, file = excluded.file, line = excluded.line,
        role = excluded.role, ts = excluded.ts
    `).run({ id, chatId, file, line, role, ts });
    this.db.prepare('DELETE FROM session_turns_fts WHERE id = ?').run(id);
    this.db.prepare('INSERT INTO session_turns_fts (id, content) VALUES (?, ?)').run(id, content);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_turns (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        role TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_turns_ts ON session_turns(ts);
      CREATE INDEX IF NOT EXISTS idx_session_turns_chat ON session_turns(chat_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS session_turns_fts USING fts5(id UNINDEXED, content);
    `);
  }

  // H8: drop + recreate both derived tables (used when a search hit corruption or a boot parity mismatch).
  private resetDerivedTables(): void {
    this.db.exec('DROP TABLE IF EXISTS session_turns_fts; DROP TABLE IF EXISTS session_turns;');
    this.initSchema();
  }

  // H8/C-11: metadata and derived FTS must have the same ids in both directions. Counts catch a lost
  // row; the anti-joins catch an orphan FTS row with equal counts.
  private ftsParityBroken(): boolean {
    try {
      const meta = (this.db.prepare('SELECT COUNT(*) AS c FROM session_turns').get() as { c: number }).c;
      const fts = (this.db.prepare('SELECT COUNT(*) AS c FROM session_turns_fts').get() as { c: number }).c;
      if (meta !== fts) return true;
      const missingFts = this.db.prepare(`
        SELECT 1 AS broken
        FROM session_turns m
        WHERE NOT EXISTS (SELECT 1 FROM session_turns_fts f WHERE f.id = m.id)
        LIMIT 1
      `).get() as { broken: number } | undefined;
      if (missingFts) return true;
      const orphanFts = this.db.prepare(`
        SELECT 1 AS broken
        FROM session_turns_fts f
        WHERE NOT EXISTS (SELECT 1 FROM session_turns m WHERE m.id = f.id)
        LIMIT 1
      `).get() as { broken: number } | undefined;
      return Boolean(orphanFts);
    } catch {
      return true;
    }
  }

  private hardenDbFiles(): void {
    for (const candidate of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      tightenFile(candidate);
    }
  }

  private dirtyMarkerExists(): boolean {
    try {
      return fs.existsSync(this.dirtyMarkerPath);
    } catch {
      return false;
    }
  }

  private clearDirtyMarker(): void {
    try {
      if (fs.existsSync(this.dirtyMarkerPath)) fs.rmSync(this.dirtyMarkerPath, { force: true });
    } catch {
      /* best-effort */
    }
  }

  // The immediate subdirectory of `root` a day file sits in (the no-registry per-chat layout), or '' when
  // the file is flat under root. Used only as a fallback when a JSONL entry lacks a chatId field.
  private static subdirChatId(root: string, fp: string): string {
    const rel = path.relative(root, fp);
    const parts = rel.split(path.sep);
    return parts.length > 1 ? parts[0] : '';
  }

  private static listDayFilePaths(root: string): { paths: string[]; complete: boolean } {
    const out: string[] = [];
    let complete = true;
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        complete = false;
        return; // unreadable dir — skip but retain the durable retry marker
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (DAY_FILE_RE.test(e.name)) {
          try {
            if (fs.lstatSync(full).isFile()) out.push(full);
          } catch {
            // Missing/replaced/non-regular day files are not part of the rebuild boundary.
          }
        }
      }
    };
    walk(root);
    return { paths: out.sort(), complete };
  }

  private static escapeFts(token: string): string {
    return token.replace(/"/g, '""');
  }

  private static isCorruptionError(e: unknown): boolean {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' &&
      ['SQLITE_NOTADB', 'SQLITE_CORRUPT', 'SQLITE_CORRUPT_VFS', 'SQLITE_IOERR_READ', 'SQLITE_IOERR_SHORT_READ'].includes(code)) {
      return true;
    }
    const text = typeof e === 'object' && e !== null && 'message' in e && typeof (e as { message: unknown }).message === 'string'
      ? (e as { message: string }).message
      : String(e);
    return /(?:not a database|database disk image is malformed|file is not a database|no such table)/i.test(text);
  }
}
