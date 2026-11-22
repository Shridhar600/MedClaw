
import * as fs from 'fs';
import * as path from 'path';
import { secureWriteViaTmp, summarizeErrorForLog } from '../security';

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
  /** Durable EOF watermark; absent in older window files. */
  archiveTail?: ArchiveTail;
}

const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function dateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Atomically persist the window state at 0600 (tmp+rename). */
export function saveWindow(filePath: string, window: SessionWindow): void {
  secureWriteViaTmp(filePath, JSON.stringify(window));
}

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

export function countDayFileLines(filePath: string): number {
  let count = 0;
  forEachNonEmptyLine(filePath, () => { count += 1; });
  return count;
}

const READ_CHUNK_BYTES = 64 * 1024;

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

export function walkBackAnchor(sessionsDir: string, k: number): Anchor {
  const files = listDayFiles(sessionsDir);
  if (files.length === 0) return { file: '', line: 0 };
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

export function latestDayFileEof(sessionsDir: string): Anchor {
  const tail = latestDayFileTail(sessionsDir);
  return { file: tail.file, line: tail.line };
}

export function resolveWindow(filePath: string, sessionsDir: string): SessionWindow {
  const persisted = loadWindow(filePath);
  if (persisted && isValidAnchor(persisted.verbatimFrom, sessionsDir)) return persisted;

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
