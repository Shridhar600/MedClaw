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

export interface SessionWindow {
  /** Compaction summary of turns older than the verbatim tail (prepended as a system message). */
  summaryBlock: string;
  /** First archive line the verbatim tail replays from. `file` is a day-file basename. */
  verbatimFrom: Anchor;
  /** Real `usage.promptTokens` from the last provider response (the window-fill signal). */
  lastPromptTokens?: number;
  /** True when `lastPromptTokens` is a chars/4 estimate (provider omitted usage). */
  lastPromptTokensEstimated?: boolean;
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
  return nonEmptyLinesOf(filePath).length;
}

function nonEmptyLinesOf(filePath: string): string[] {
  try {
    if (!fs.lstatSync(filePath).isFile()) return [];
    return fs.readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
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
  const counts = files.map((f) => nonEmptyLinesOf(path.join(sessionsDir, f)).length);
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
    const lines = nonEmptyLinesOf(path.join(sessionsDir, f));
    const start = f === from.file ? from.line : 0;
    for (let i = start; i < lines.length; i++) {
      out.push({ file: f, line: i + 1, raw: lines[i] });
    }
  }
  return out;
}

/**
 * The EOF anchor of the newest day file in `sessionsDir`: `{ file: <basename>, line: <non-empty line
 * count> }`. `{file:'',line:0}` when the directory is missing or holds no `YYYY-MM-DD.jsonl` files.
 */
export function latestDayFileEof(sessionsDir: string): Anchor {
  const dayFiles = listDayFiles(sessionsDir);
  const latest = dayFiles[dayFiles.length - 1];
  if (!latest) return { file: '', line: 0 };
  return { file: latest, line: countDayFileLines(path.join(sessionsDir, latest)) };
}

/**
 * The window to boot with: the persisted window when present + valid, otherwise a fresh empty window
 * anchored at the latest day file's EOF (A-L6/N-7).
 */
export function resolveWindow(filePath: string, sessionsDir: string): SessionWindow {
  return loadWindow(filePath) ?? { summaryBlock: '', verbatimFrom: latestDayFileEof(sessionsDir) };
}

function isSessionWindow(v: unknown): v is SessionWindow {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.summaryBlock !== 'string') return false;
  const from = o.verbatimFrom;
  if (from === null || typeof from !== 'object') return false;
  const f = from as Record<string, unknown>;
  return typeof f.file === 'string' && typeof f.line === 'number';
}
