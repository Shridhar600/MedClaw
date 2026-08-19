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
import * as path from 'path';
import type { Clock } from '../ports';
import { systemClock } from '../ports';
import { secureWriteViaTmp, summarizeErrorForLog, quarantineToSideFile } from '../security';

export interface NarrativeAppendResult {
  date: string;
  anchor: string;
  lineStart: number;
}

const LOG_HEADING = '## Log';
const LEDGER_HEADING = '## Ledger writes';

export class NarrativeStore {
  constructor(private readonly rootDir: string, private readonly clock: Clock = systemClock) {}

  private filePath(date: string): string {
    return path.join(this.rootDir, 'memory', `${date}.md`);
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

    const entryLines = [`- ${time} — ${entry.text}`];
    if (entry.verbatim !== undefined && entry.verbatim !== '') {
      entryLines.push(`  > ${entry.verbatim} (lang: ${entry.language ?? 'en'})`);
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

  async read(date: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(this.filePath(date), 'utf-8');
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
   * Read the day file into lines. On a non-ENOENT read failure we degrade to a
   * fresh header but preserve any existing bytes as a quarantine note (D2), so a
   * transient read error can never silently truncate the lossless lane.
   */
  private readLines(date: string): string[] {
    const fp = this.filePath(date);
    let raw: string | null = null;
    try {
      raw = fs.readFileSync(fp, 'utf-8');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return this.freshHeader(date);
      console.warn(`[narrative-store] degraded read for ${date}: ${summarizeErrorForLog(err)}`);
      const salvaged = this.salvageRaw(fp);
      const header = this.freshHeader(date);
      // Salvaged bytes → 0600 side file; inline only a constant pointer (never the raw bytes).
      if (salvaged) header.push(quarantineToSideFile(this.filePath(date), salvaged));
      return header;
    }
    const lines = raw.split('\n');
    // Drop a single trailing empty element from the final newline so appends stay tight.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) return this.freshHeader(date);
    return lines;
  }

  private salvageRaw(fp: string): string | null {
    try {
      return fs.readFileSync(fp).toString('latin1');
    } catch {
      return null;
    }
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
