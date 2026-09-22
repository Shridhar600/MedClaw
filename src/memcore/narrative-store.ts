// src/memcore/narrative-store.ts
//
// The narrative lane: append-only daily logs at `memory/YYYY-MM-DD.md`. This is
// the lossless record of what the user said (CHAT-06) and the anchor target the
// structured ledger points back to (KNEE-01 cross-anchor). Writes are additive —
// a prior entry is never mutated or removed. The day-granularity date lives in
// the file header ONLY (amendment C6); individual entries carry a HH:MM time.
//
// A verbatim user quote is stored EXACTLY, blockquoted, and tagged with its
// language, so nothing is paraphrased away before the agent sees it.

import * as fs from 'fs';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'crypto';
import type { Hash } from 'crypto';
import type { Clock } from '../ports';
import { systemClock } from '../ports';
import { secureAppend, secureWriteViaTmp, secureMkdir, summarizeErrorForLog, quarantineToSideFile, resolveContainedPath, PathContainmentError } from '../security';
import { neutralizeStructuralHeadings } from './sanitize';

export interface NarrativeAppendResult {
  date: string;
  anchor: string;
  lineStart: number;
}

export interface NarrativeIndexChunk {
  id: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface NarrativeIndexDelta {
  hash: string;
  fingerprint?: NarrativeFileFingerprint;
  chunks: NarrativeIndexChunk[];
}

export interface NarrativeFileFingerprint {
  mtimeMs: number;
  size: number;
  ino: number;
}

interface NarrativeFileCache {
  fingerprint: NarrativeFileFingerprint;
  lineCount: number;
  endsWithNewline: boolean;
  hasLogHeading: boolean;
  hasLedgerHeading: boolean;
  tailSection: 'log' | 'ledger' | 'other';
  hash: Hash;
}

const LOG_HEADING = '## Log';
const LEDGER_HEADING = '## Ledger writes';
const SESSION_SUMMARY_HEADING = '## Session summary';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class NarrativeStore {
  private readonly fileCache = new Map<string, NarrativeFileCache>();
  private readonly pendingIndexDeltas = new Map<string, NarrativeIndexDelta[]>();

  constructor(private readonly rootDir: string, private readonly clock: Clock = systemClock) {
    secureMkdir(rootDir);
  }

  private filePath(date: string): string {
    this.validateDate(date);
    return resolveContainedPath(this.rootDir, 'memory', `${date}.md`);
  }

  private sessionSummaryPath(chatId: string, date: string): string {
    this.validateDate(date);
    return resolveContainedPath(this.rootDir, '.state', 'session-summaries', chatId, `${date}.md`);
  }

  private validateDate(date: string): void {
    if (!DATE_RE.test(date)) throw new PathContainmentError('invalid-component');
  }

  /**
   * Append a narrative entry. `date` (YYYY-MM-DD) overrides the clock-derived day
   * so the narrative and ledger lanes agree on the same day (F20). Returns the
   * on-disk anchor of the entry's primary line.
   */
  async append(entry: { text: string; language?: string; verbatim?: string; date?: string }): Promise<NarrativeAppendResult> {
    const now = this.clock.now();
    const date = entry.date ?? this.dayOf(now);
    const time = this.timeOf(now);

    const entryLines = [`- ${time} — ${neutralizeStructuralHeadings(entry.text)}`];
    if (entry.verbatim !== undefined && entry.verbatim !== '') {
      const verbatimLines = neutralizeStructuralHeadings(entry.verbatim).split(/\r\n|\n|\r/);
      entryLines.push(...verbatimLines.map((line, index) =>
        `  > ${line}${index === verbatimLines.length - 1 ? ` (lang: ${entry.language ?? 'en'})` : ''}`,
      ));
    }

    const entryText = `${entryLines.join('\n')}\n`;
    const cached = this.loadCache(date);
    let lineStart: number;
    let block: string;
    let indexedContent: string;
    let indexedStart: number;

    if (!cached || cached.lineCount === 0) {
      const header = `${this.freshHeader(date).join('\n')}\n`;
      block = `${header}${entryText}`;
      lineStart = this.freshHeader(date).length + 1;
      indexedContent = block.trimEnd();
      indexedStart = 1;
    } else {
      const needsLogHeading = !cached.hasLogHeading || cached.tailSection !== 'log';
      const separator = cached.lineCount > 0 && !cached.endsWithNewline ? '\n' : '';
      const heading = needsLogHeading ? `${LOG_HEADING}\n` : '';
      block = `${separator}${heading}${entryText}`;
      lineStart = cached.lineCount + 1 + (needsLogHeading ? 1 : 0);
      indexedContent = `${heading}${entryText}`.trimEnd();
      indexedStart = cached.lineCount + 1;
    }

    secureAppend(this.filePath(date), block);
    this.updateCacheAfterAppend(date, cached, block, indexedContent, indexedStart);
    const anchor = `memory/${date}.md#L${lineStart}`;
    return { date, anchor, lineStart };
  }

  /**
   * Record a ledger cross-reference under `## Ledger writes` (`- <entity> → <factId>`).
   * Lets a narrative day point at the structured facts captured that day (KNEE-01).
   */
  async appendLedgerAnchor(date: string, entity: string, factId: string): Promise<string> {
    const entryLine = `- ${entity} → ${factId}`;
    const cached = this.loadCache(date);
    let block: string;
    let lineStart: number;
    let indexedStart: number;
    let indexedContent: string;

    if (!cached || cached.lineCount === 0) {
      const header = `${this.freshHeader(date).join('\n')}\n`;
      block = `${header}${LEDGER_HEADING}\n${entryLine}\n`;
      indexedStart = 1;
      lineStart = this.freshHeader(date).length + 2;
      indexedContent = block.trimEnd();
    } else {
      const needsLedgerHeading = !cached.hasLedgerHeading || cached.tailSection !== 'ledger';
      const separator = cached.lineCount > 0 && !cached.endsWithNewline ? '\n' : '';
      const heading = needsLedgerHeading ? `${LEDGER_HEADING}\n` : '';
      block = `${separator}${heading}${entryLine}\n`;
      indexedStart = cached.lineCount + 1;
      lineStart = indexedStart + (needsLedgerHeading ? 1 : 0);
      indexedContent = `${heading}${entryLine}`;
    }

    secureAppend(this.filePath(date), block);
    this.updateCacheAfterAppend(date, cached, block, indexedContent, indexedStart);
    return `memory/${date}.md#L${lineStart}`;
  }

  /**
   * Append a compaction summary block under `## Session summary` in the chat-scoped state lane (C-29).
   * The bullets carry `sessions/<file>#L<n>` anchors back to verbatim day-file lines. Reuses the heading
   * if it already exists for that chat and day.
   */
  async appendSessionSummary(chatId: string, date: string, summary: string): Promise<string> {
    const fp = this.sessionSummaryPath(chatId, date);
    const entryLines = summary
      .split(/\r\n|\n|\r/)
      .filter((l) => l.length > 0)
      .map(neutralizeStructuralHeadings);
    const lines = this.readSummaryLines(fp, date);
    if (!lines.includes(SESSION_SUMMARY_HEADING)) {
      lines.push(SESSION_SUMMARY_HEADING);
    }
    const lineStart = lines.length + 1;
    lines.push(...entryLines);
    secureWriteViaTmp(fp, lines.join('\n') + '\n');
    return `.state/session-summaries/${chatId}/${date}.md#L${lineStart}`;
  }

  async read(date: string): Promise<string | null> {
    const fp = this.filePath(date);
    try {
      const raw = await fs.promises.readFile(fp);
      return this.decodeUtf8(fp, raw);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return null;
      console.warn(`[narrative-store] read failed for ${date}: ${summarizeErrorForLog(err)}`);
      return null;
    }
  }

  // ---- internals ---------------------------------------------------------

  private dayOf(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private timeOf(d: Date): string {
    return d.toISOString().slice(11, 16);
  }

  /**
   * Return the pending source delta for a day. The Gateway consumes this after
   * the source write and indexes only the newly appended lines.
   */
  takeIndexDelta(date: string): NarrativeIndexDelta | undefined {
    const pending = this.pendingIndexDeltas.get(date);
    if (!pending || pending.length === 0) return undefined;
    this.pendingIndexDeltas.delete(date);
    const last = pending[pending.length - 1];
    return {
      hash: last.hash,
      fingerprint: last.fingerprint,
      chunks: pending.flatMap(delta => delta.chunks),
    };
  }

  /** Load the source cache, reading the full file only on a cold miss or detected drift. */
  private loadCache(date: string): NarrativeFileCache | undefined {
    const fp = this.filePath(date);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fp);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      this.invalidateCache(date);
      if (nodeErr.code === 'ENOENT') return undefined;
      console.warn(`[narrative-store] degraded read for ${date}: ${summarizeErrorForLog(err)}`);
      throw err;
    }
    if (!stat.isFile()) {
      this.invalidateCache(date);
      throw new Error('narrative source is not a regular file');
    }

    const fingerprint = this.fingerprint(stat);
    const cached = this.fileCache.get(date);
    if (cached && this.sameFingerprint(cached.fingerprint, fingerprint)) {
      try {
        const fd = fs.openSync(fp, 'r');
        fs.closeSync(fd);
        return cached;
      } catch (err) {
        this.invalidateCache(date);
        console.warn(`[narrative-store] degraded read for ${date}: ${summarizeErrorForLog(err)}`);
        throw err;
      }
    }

    this.invalidateCache(date);
    return this.readCacheFromDisk(date, fp, fingerprint);
  }

  private readCacheFromDisk(
    date: string,
    fp: string,
    fingerprint: NarrativeFileFingerprint,
  ): NarrativeFileCache | undefined {
    let rawBytes: Buffer;
    try {
      rawBytes = fs.readFileSync(fp);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return undefined;
      console.warn(`[narrative-store] degraded read for ${date}: ${summarizeErrorForLog(err)}`);
      throw err;
    }
    const raw = this.decodeUtf8(fp, rawBytes);
    const cache = this.cacheFromBytes(raw, rawBytes, fingerprint);
    this.fileCache.set(date, cache);
    return cache;
  }

  private cacheFromBytes(raw: string, rawBytes: Buffer, fingerprint: NarrativeFileFingerprint): NarrativeFileCache {
    const lines = raw.split(/\r\n|\n|\r/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    let tailSection: NarrativeFileCache['tailSection'] = 'other';
    let hasLogHeading = false;
    let hasLedgerHeading = false;
    for (const line of lines) {
      if (line === LOG_HEADING) {
        hasLogHeading = true;
        tailSection = 'log';
      } else if (line === LEDGER_HEADING) {
        hasLedgerHeading = true;
        tailSection = 'ledger';
      } else if (/^##\s/.test(line)) {
        tailSection = 'other';
      }
    }
    return {
      fingerprint,
      lineCount: rawBytes.length === 0
        ? 0
        : rawBytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0)
          + (rawBytes[rawBytes.length - 1] === 0x0a ? 0 : 1),
      endsWithNewline: rawBytes.length > 0 && rawBytes[rawBytes.length - 1] === 0x0a,
      hasLogHeading,
      hasLedgerHeading,
      tailSection,
      hash: createHash('sha256').update(rawBytes),
    };
  }

  private updateCacheAfterAppend(
    date: string,
    cached: NarrativeFileCache | undefined,
    block: string,
    indexedContent: string,
    indexedStart: number,
  ): void {
    const fp = this.filePath(date);
    const blockBytes = Buffer.from(block, 'utf8');
    const next = cached ?? {
      fingerprint: { mtimeMs: 0, size: 0, ino: 0 },
      lineCount: 0,
      endsWithNewline: false,
      hasLogHeading: false,
      hasLedgerHeading: false,
      tailSection: 'other' as const,
      hash: createHash('sha256'),
    };
    next.hash.update(blockBytes);
    next.lineCount += indexedContent.split(/\r\n|\n|\r/).length;
    next.endsWithNewline = blockBytes.length > 0 && blockBytes[blockBytes.length - 1] === 0x0a;
    for (const line of indexedContent.split(/\r\n|\n|\r/)) {
      if (line === LOG_HEADING) {
        next.hasLogHeading = true;
        next.tailSection = 'log';
      } else if (line === LEDGER_HEADING) {
        next.hasLedgerHeading = true;
        next.tailSection = 'ledger';
      } else if (/^##\s/.test(line)) {
        next.tailSection = 'other';
      }
    }

    let fingerprint: NarrativeFileFingerprint | undefined;
    try {
      const stat = fs.statSync(fp);
      if (!stat.isFile()) throw new Error('narrative source is not a regular file');
      fingerprint = this.fingerprint(stat);
      next.fingerprint = fingerprint;
      this.fileCache.set(date, next);
    } catch (err) {
      this.fileCache.delete(date);
      console.warn(`[narrative-store] append metadata unavailable for ${date}: ${summarizeErrorForLog(err)}`);
    }

    const hash = next.hash.copy().digest('hex');
    const delta: NarrativeIndexDelta = {
      hash,
      fingerprint,
      chunks: [{
        id: `memory/${date}.md:delta:${indexedStart}`,
        content: indexedContent,
        startLine: indexedStart,
        endLine: indexedStart + indexedContent.split(/\r\n|\n|\r/).length - 1,
      }],
    };
    const pending = this.pendingIndexDeltas.get(date) ?? [];
    pending.push(delta);
    this.pendingIndexDeltas.set(date, pending);
  }

  private readSummaryLines(fp: string, date: string): string[] {
    let rawBytes: Buffer;
    try {
      rawBytes = fs.readFileSync(fp);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return [`# ${date}`, SESSION_SUMMARY_HEADING];
      console.warn('[narrative-store] session-summary read failed:', summarizeErrorForLog(err));
      throw err;
    }
    const raw = this.decodeUtf8(fp, rawBytes);
    const lines = raw.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.length > 0 ? lines : [`# ${date}`, SESSION_SUMMARY_HEADING];
  }

  private decodeUtf8(fp: string, rawBytes: Buffer): string {
    if (!isUtf8(rawBytes)) {
      console.warn('[narrative-store] invalid UTF-8 content; preserving bytes in quarantine');
      quarantineToSideFile(fp, rawBytes);
      throw new Error('invalid-utf8');
    }
    return rawBytes.toString('utf8');
  }

  private freshHeader(date: string): string[] {
    return [`# ${date}`, LOG_HEADING];
  }

  private fingerprint(stat: fs.Stats): NarrativeFileFingerprint {
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
  }

  private sameFingerprint(left: NarrativeFileFingerprint, right: NarrativeFileFingerprint): boolean {
    return left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino;
  }

  private invalidateCache(date: string): void {
    this.fileCache.delete(date);
    this.pendingIndexDeltas.delete(date);
  }
}
