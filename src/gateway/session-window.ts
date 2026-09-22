// src/gateway/session-window.ts
//
// P2b (spec 14 §2) — the rolling CONTEXT window, persisted SEPARATELY from the append-only day-file
// archive. Disk = infinite verbatim JSONL day files (never rewritten); this file is just the pointer
// into that archive plus the compaction summary. On restart the window is loaded and the day-file tail
// is replayed from `verbatimFrom` (D1.5).
//
// Resilience (A-L6/N-7): an ABSENT or CORRUPT window file is NOT an error — it yields a fresh empty
// window pointing at the EOF of the latest existing day file (the archive is intact; only the in-context
// window restarts). `{file:'',line:0}` is used ONLY when no day files exist at all. `loadWindow` never
// throws and never logs window CONTENT (`summaryBlock` is a PHI session summary).

import * as fs from 'fs';
import * as path from 'path';
import { secureWriteViaTmp, summarizeErrorForLog } from '../security';

/**
 * A stable pointer into the append-only day-file archive: a day-file basename + a 1-based PHYSICAL
 * non-empty line number. Anchors are immutable once assigned (the disk is never rewritten — DD1), so
 * compaction summaries (D3) and window resume (D1.5) can always resolve them back to the JSONL line.
 */
export interface Anchor {
  file: string;
  line: number;
}

/** The durable EOF watermark for one archive lane. `byteLength` detects external appends/truncation. */
export interface ArchiveTail extends Anchor {
  byteLength: number;
}

export type WindowAnchorSource = 'watermark' | 'fallback';

export interface WindowAnchorResolution {
  anchor: Anchor;
  source: WindowAnchorSource;
}

export interface SessionWindow {
  /** Compaction summary of turns older than the verbatim tail (prepended as a system message). */
  summaryBlock: string;
  /** First archive line the verbatim tail replays from. `file` is a day-file basename. */
  verbatimFrom: Anchor;
  /** Summary copy waiting for the chat-scoped sink to commit. The value is PHI-bearing and stays 0600. */
  pendingSummary?: string;
  /** Real `usage.promptTokens` from the last provider response (the window-fill signal). */
  lastPromptTokens?: number;
  /** True when `lastPromptTokens` is a chars/4 estimate (provider omitted usage). */
  lastPromptTokensEstimated?: boolean;
  /** Optional C-38 durable EOF watermark; absent in pre-RR-9a window files. */
  archiveTail?: ArchiveTail;
}

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * The single shared day key (A-H3): UTC `YYYY-MM-DD`, matching `NarrativeStore`'s daily-log
 * convention. Used by the day-file namer, migration bucketing, and the nightly sweep so all three
 * agree on where a day boundary is — never local time (an IST-evening sweep must read the same UTC
 * file an IST-after-midnight turn wrote).
 */
export function dateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Atomically persist the window state at 0600 (tmp+rename). */
export function saveWindow(filePath: string, window: SessionWindow): void {
  secureWriteViaTmp(filePath, JSON.stringify(window));
}

/**
 * Load the window state. Returns `null` for an absent, unreadable, corrupt, or wrong-shape file — the
 * caller resolves the fresh-window default (see `resolveWindow`). Never throws; never logs content.
 */
export function loadWindow(filePath: string): SessionWindow | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      console.warn(`[session-window] read failed: ${summarizeErrorForLog(err)}`);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSessionWindow(parsed) ? parsed : null;
  } catch {
    // Corrupt JSON — a torn write. Sanitized, content-free note.
    console.warn('[session-window] corrupt window file ignored (using fresh window)');
    return null;
  }
}

/**
 * The physical non-empty line count of a JSONL day file — the anchor line count (A-H2). A malformed
 * line still occupies its slot, so an anchor's `line` is a stable physical position, immune to parse
 * errors (malformed lines are skipped only when reconstructing messages, never when counting slots).
 * This is the SINGLE definition of "day-file line count", shared by the day-file namer's anchor
 * tracking, `latestDayFileEof`, and (D2) the search-index rebuild. Returns 0 for an absent/unreadable
 * file.
 */
export function countDayFileLines(filePath: string): number {
  let count = 0;
  forEachNonEmptyLine(filePath, () => { count += 1; });
  return count;
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Visit non-empty LF-delimited physical lines without materializing the file. The line number is the
 * 1-based non-empty physical slot used by session anchors; malformed JSON is deliberately opaque here.
 */
function forEachNonEmptyLine(filePath: string, visit: (raw: string, line: number) => void): boolean {
  let fd: number | undefined;
  try {
    if (!fs.lstatSync(filePath).isFile()) return false;
    fd = fs.openSync(filePath, 'r');
    const parts: Buffer[] = [];
    let partBytes = 0;
    let line = 0;
    let position = 0;

    const finishLine = (): void => {
      if (partBytes === 0) return;
      line += 1;
      visit(Buffer.concat(parts, partBytes).toString('utf8'), line);
      parts.length = 0;
      partBytes = 0;
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Keep each chunk alive while a logical line spans the next read. Reusing one buffer would
      // overwrite the earlier slice before Buffer.concat() sees it.
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      let start = 0;
      while (start < bytesRead) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline < 0 || newline >= bytesRead) {
          const part = chunk.subarray(start, bytesRead);
          parts.push(part);
          partBytes += part.length;
          break;
        }
        if (newline > start) {
          const part = chunk.subarray(start, newline);
          parts.push(part);
          partBytes += part.length;
        }
        finishLine();
        start = newline + 1;
      }
    }
    finishLine();
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/** Sorted `YYYY-MM-DD.jsonl` basenames in `sessionsDir` (chronological). Empty on absent/unreadable dir. */
export function listDayFiles(sessionsDir: string): string[] {
  try {
    return fs.readdirSync(sessionsDir)
      .filter((f) => DAY_FILE_RE.test(f))
      .filter((f) => {
        try {
          return fs.lstatSync(path.join(sessionsDir, f)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** One physical archive line: its day-file basename, 1-based physical line number, and raw JSON text. */
export interface ArchiveLine {
  file: string;
  line: number;
  raw: string;
}

/**
 * The EOF-EXCLUSIVE anchor `k` non-empty archive lines back from the end — the anchor for which
 * `readLinesAfter` returns exactly the last `k` lines. `k ≤ 0` ⇒ the archive EOF (empty tail); `k` at
 * or beyond the archive size clamps to the archive start; an empty archive ⇒ `{file:'',line:0}`. When
 * the boundary falls exactly on a day-file edge it rolls to the NEXT file's start (line 0), so the tail
 * spans whole files cleanly.
 */
export function walkBackAnchor(sessionsDir: string, k: number): Anchor {
  const files = listDayFiles(sessionsDir);
  if (files.length === 0) return { file: '', line: 0 };
  // The recovery path may inspect the whole archive, but it keeps memory bounded: only one integer
  // count per day file is retained, never an archive-sized line array or string.
  const counts = files.map((f) => countDayFileLines(path.join(sessionsDir, f)));
  const total = counts.reduce((a, b) => a + b, 0);
  const pre = Math.max(0, total - k); // number of pre-tail lines to skip from the archive start
  let acc = 0;
  for (let i = 0; i < files.length; i++) {
    if (acc + counts[i] > pre) return { file: files[i], line: pre - acc };
    acc += counts[i];
  }
  const last = files.length - 1;
  return { file: files[last], line: counts[last] }; // pre === total (k ≤ 0): empty tail at EOF
}

/** Return the EOF-exclusive cursor immediately before a known physical archive line. */
export function anchorBefore(anchor: Anchor): Anchor {
  return { file: anchor.file, line: Math.max(0, anchor.line - 1) };
}

/**
 * Every non-empty archive line strictly AFTER `from` (exclusive) through EOF, in chronological order,
 * each with its physical `{file, line}` anchor and raw JSON text. Skips the first `from.line` lines of
 * `from.file` and every earlier day file. Malformed lines are RETAINED as raw (they occupy their
 * physical slot — anchor-stable per A-H2); the caller parses `raw` and skips failures.
 */
export function readLinesAfter(sessionsDir: string, from: Anchor): ArchiveLine[] {
  const out: ArchiveLine[] = [];
  for (const f of listDayFiles(sessionsDir)) {
    if (f < from.file) continue; // whole file precedes the tail
    const start = f === from.file ? from.line : 0;
    forEachNonEmptyLine(path.join(sessionsDir, f), (raw, line) => {
      if (line > start) out.push({ file: f, line, raw });
    });
  }
  return out;
}

/** The newest day file's current EOF watermark. Reads only that day file, not older archive files. */
export function latestDayFileTail(sessionsDir: string): ArchiveTail {
  const dayFiles = listDayFiles(sessionsDir);
  const latest = dayFiles[dayFiles.length - 1];
  if (!latest) return { file: '', line: 0, byteLength: 0 };
  const filePath = path.join(sessionsDir, latest);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { file: '', line: 0, byteLength: 0 };
    return { file: latest, line: countDayFileLines(filePath), byteLength: stat.size };
  } catch {
    return { file: '', line: 0, byteLength: 0 };
  }
}

/** Validate a watermark against the archive's newest file without reading older day files. */
export function isArchiveTailCurrent(sessionsDir: string, tail: ArchiveTail): boolean {
  const dayFiles = listDayFiles(sessionsDir);
  if (tail.file === '') return tail.line === 0 && tail.byteLength === 0 && dayFiles.length === 0;
  if (dayFiles[dayFiles.length - 1] !== tail.file) return false;
  try {
    const stat = fs.statSync(path.join(sessionsDir, tail.file));
    return stat.isFile()
      && Number.isInteger(tail.line)
      && tail.line >= 0
      && Number.isInteger(tail.byteLength)
      && tail.byteLength >= 0
      && stat.size === tail.byteLength;
  } catch {
    return false;
  }
}

/** Resolve the last `k` physical slots from a current watermark, or use the streaming recovery walk. */
export function deriveWindowAnchor(
  sessionsDir: string,
  k: number,
  tail?: ArchiveTail,
): WindowAnchorResolution {
  if (tail && isArchiveTailCurrent(sessionsDir, tail)) {
    if (k <= 0 || tail.file === '' || tail.line >= k) {
      return {
        anchor: tail.file === '' ? { file: '', line: 0 } : { file: tail.file, line: Math.max(0, tail.line - Math.max(0, k)) },
        source: 'watermark',
      };
    }
  }
  return { anchor: walkBackAnchor(sessionsDir, k), source: 'fallback' };
}

/**
 * The EOF anchor of the newest day file in `sessionsDir`: `{ file: <basename>, line: <non-empty line
 * count> }`. `{file:'',line:0}` when the directory is missing or holds no `YYYY-MM-DD.jsonl` files.
 */
export function latestDayFileEof(sessionsDir: string): Anchor {
  const tail = latestDayFileTail(sessionsDir);
  return { file: tail.file, line: tail.line };
}

/**
 * The window to boot with: the persisted window when present + valid, otherwise a fresh empty window
 * anchored at the latest day file's EOF (A-L6/N-7).
 */
export function resolveWindow(filePath: string, sessionsDir: string): SessionWindow {
  const persisted = loadWindow(filePath);
  if (persisted && isValidAnchor(persisted.verbatimFrom, sessionsDir)) return persisted;

  // A pending summary is source-side durable work. Preserve it even when a cursor is invalid so a
  // torn/stale window cannot discard a summary that still needs to reach its sink.
  return {
    summaryBlock: '',
    verbatimFrom: latestDayFileEof(sessionsDir),
    ...(persisted?.pendingSummary ? { pendingSummary: persisted.pendingSummary } : {}),
  };
}

function isSessionWindow(v: unknown): v is SessionWindow {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.summaryBlock !== 'string') return false;
  const from = o.verbatimFrom;
  if (from === null || typeof from !== 'object') return false;
  const f = from as Record<string, unknown>;
  if (typeof f.file !== 'string' || typeof f.line !== 'number') return false;
  if (!Number.isInteger(f.line) || f.line < 0) return false;
  if (f.file !== '' && !DAY_FILE_RE.test(f.file)) return false;
  if (f.file === '' && f.line !== 0) return false;
  if (o.pendingSummary !== undefined && typeof o.pendingSummary !== 'string') return false;
  if (o.archiveTail !== undefined && !isArchiveTailShape(o.archiveTail)) return false;
  return true;
}

function isArchiveTailShape(v: unknown): v is ArchiveTail {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.file !== 'string' || typeof o.line !== 'number' || typeof o.byteLength !== 'number') return false;
  if (!Number.isInteger(o.line) || o.line < 0 || !Number.isInteger(o.byteLength) || o.byteLength < 0) return false;
  if (o.file !== '' && !DAY_FILE_RE.test(o.file)) return false;
  return o.file !== '' || (o.line === 0 && o.byteLength === 0);
}

/**
 * Validate a persisted cursor against the archive it claims to point into. The cursor is an
 * EOF-exclusive physical slot, so line zero is valid only for an existing day file and line equal
 * to the physical non-empty count is valid at EOF. `{file:'',line:0}` is reserved for an empty archive.
 */
function isValidAnchor(anchor: Anchor, sessionsDir: string): boolean {
  if (!Number.isInteger(anchor.line) || anchor.line < 0) return false;
  const dayFiles = listDayFiles(sessionsDir);
  if (anchor.file === '') return anchor.line === 0 && dayFiles.length === 0;
  if (!DAY_FILE_RE.test(anchor.file)) return false;
  const filePath = path.join(sessionsDir, anchor.file);
  try {
    if (!fs.lstatSync(filePath).isFile()) return false;
  } catch {
    return false;
  }
  return anchor.line <= countDayFileLines(filePath);
}
