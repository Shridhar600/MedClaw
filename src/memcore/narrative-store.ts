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
import type { Clock } from '../ports';
import { systemClock } from '../ports';
import { secureWriteViaTmp, secureMkdir, summarizeErrorForLog, quarantineToSideFile, resolveContainedPath, PathContainmentError } from '../security';
import { neutralizeStructuralHeadings } from './sanitize';

export interface NarrativeAppendResult {
  date: string;
  anchor: string;
  lineStart: number;
}

const LOG_HEADING = '## Log';
const LEDGER_HEADING = '## Ledger writes';
const SESSION_SUMMARY_HEADING = '## Session summary';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class NarrativeStore {
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

    const { lines, lineStart } = this.insertIntoLogSection(this.readLines(date), date, entryLines);
    const anchor = this.write(date, lines, lineStart);
    return { date, anchor, lineStart };
  }

  /**
   * Record a ledger cross-reference under `## Ledger writes` (`- <entity> → <factId>`).
   * Lets a narrative day point at the structured facts captured that day (KNEE-01).
   */
  async appendLedgerAnchor(date: string, entity: string, factId: string): Promise<string> {
    const entryLine = `- ${entity} → ${factId}`;
    const { lines, lineStart } = this.insertIntoLedgerSection(this.readLines(date), date, entryLine);
    return this.write(date, lines, lineStart);
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
   * Read the day file into lines. Only ENOENT is an empty day. Any other read
   * failure aborts the read-modify-write operation so the lossless lane cannot
   * be replaced with a fresh header.
   */
  private readLines(date: string): string[] {
    const fp = this.filePath(date);
    let rawBytes: Buffer;
    try {
      rawBytes = fs.readFileSync(fp);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return this.freshHeader(date);
      console.warn(`[narrative-store] degraded read for ${date}: ${summarizeErrorForLog(err)}`);
      throw err;
    }
    const raw = this.decodeUtf8(fp, rawBytes);
    const lines = raw.split('\n');
    // Drop a single trailing empty element from the final newline so appends stay tight.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) return this.freshHeader(date);
    return lines;
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

  /** Ensure the log heading exists, then splice the entry at the end of the Log section. */
  private insertIntoLogSection(lines: string[], date: string, entryLines: string[]): { lines: string[]; lineStart: number } {
    if (!lines.includes(LOG_HEADING)) {
      // A file that somehow lost its Log heading: re-establish it after the H1.
      const headerIdx = lines.findIndex(l => l.startsWith('# '));
      lines.splice(headerIdx >= 0 ? headerIdx + 1 : 0, 0, LOG_HEADING);
    }
    const ledgerIdx = lines.indexOf(LEDGER_HEADING);
    const insertAt = ledgerIdx >= 0 ? ledgerIdx : lines.length;
    lines.splice(insertAt, 0, ...entryLines);
    return { lines, lineStart: insertAt + 1 };
  }

  /** Ensure the ledger-writes heading exists (after the Log section), then append the anchor line. */
  private insertIntoLedgerSection(lines: string[], date: string, entryLine: string): { lines: string[]; lineStart: number } {
    if (!lines.includes(LEDGER_HEADING)) {
      lines.push(LEDGER_HEADING);
    }
    lines.push(entryLine);
    return { lines, lineStart: lines.length };
  }

  private write(date: string, lines: string[], lineStart: number): string {
    const content = lines.join('\n') + '\n';
    secureWriteViaTmp(this.filePath(date), content);
    return `memory/${date}.md#L${lineStart}`;
  }
}
