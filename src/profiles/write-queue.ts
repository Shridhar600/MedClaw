// src/profiles/write-queue.ts
//
// Per-profile single-writer queue. Every memory mutation funnels through one
// serialized promise-chain so two writes never interleave on the same profile
// (PLAT-03, amendment B2). Inbound-turn ops outrank background ops (a user is
// waiting; heartbeats/dreaming are not). A crash-safe PER-LINE journal
// (amendment A4) records each op's intent BEFORE it runs and clears only that
// op's line on success, so a boot after a crash can detect a half-applied write.
//
// Ops MUST be IO-only (B2): no LLM calls inside run(). The tool layer does any
// model lookup BEFORE enqueueing, so the critical section stays fast, bounded,
// and replay-safe.

import * as fs from 'fs';
import type { IdGen } from '../ports';
import { uuidIdGen } from '../ports';
import { secureAppend, secureWriteViaTmp, summarizeErrorForLog } from '../security';

export type WritePriority = 'turn' | 'background';

/** A unit of work. `run()` MUST be IO-only — never an LLM call (amendment B2). */
export interface WriteOp<T> {
  label: string;
  run(): Promise<T>;
}

export interface WriteQueueOptions {
  journalPath: string;
  /** Injected for testability; defaults to a crypto UUID generator. */
  idGen?: IdGen;
}

interface QueueItem {
  op: WriteOp<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface JournalRecord {
  id: string;
  label: string;
}

const JOURNAL_SEP = '\t';

/** Strip line/field separators so a label can never break the line-oriented journal format. */
function sanitizeLabel(label: string): string {
  return label.replace(/[\t\r\n]+/g, ' ');
}

function serializeJournal(records: JournalRecord[]): string {
  return records.map(r => `${r.id}${JOURNAL_SEP}${r.label}`).join('\n') + (records.length ? '\n' : '');
}

function parseJournal(content: string): JournalRecord[] {
  const records: JournalRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const sep = line.indexOf(JOURNAL_SEP);
    if (sep < 0) {
      // Legacy/garbled line with no id — treat the whole line as the label.
      records.push({ id: '', label: line.trim() });
      continue;
    }
    records.push({ id: line.slice(0, sep), label: line.slice(sep + 1) });
  }
  return records;
}

export class WriteQueue {
  private readonly journalPath: string;
  private readonly idGen: IdGen;
  private readonly turnQ: QueueItem[] = [];
  private readonly backgroundQ: QueueItem[] = [];
  private running = false;
  private drainWaiters: Array<() => void> = [];

  constructor(options: WriteQueueOptions) {
    this.journalPath = options.journalPath;
    this.idGen = options.idGen ?? uuidIdGen;
  }

  /** Enqueue an IO-only op. Resolves/rejects with the op's own result. */
  enqueue<T>(priority: WritePriority, op: WriteOp<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = { op: op as WriteOp<unknown>, resolve: resolve as (v: unknown) => void, reject };
      (priority === 'turn' ? this.turnQ : this.backgroundQ).push(item);
      this.schedulePump();
    });
  }

  /** Resolves once the queue is idle (test/shutdown hook). */
  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise(resolve => this.drainWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return !this.running && this.turnQ.length === 0 && this.backgroundQ.length === 0;
  }

  private schedulePump(): void {
    if (this.running) return;
    void this.pump();
  }

  private async pump(): Promise<void> {
    this.running = true;
    try {
      // Turn ops drain fully ahead of background ops; each iteration re-checks
      // the queues, so a turn op enqueued mid-flight jumps the pending backlog.
      let item: QueueItem | undefined;
      while ((item = this.turnQ.shift() ?? this.backgroundQ.shift()) !== undefined) {
        await this.execute(item);
      }
    } finally {
      this.running = false;
      this.flushDrainWaiters();
    }
  }

  private async execute(item: QueueItem): Promise<void> {
    const journalId = this.idGen.newId();
    // Record intent BEFORE running so a crash mid-op leaves a replayable line.
    this.appendJournalLine(journalId, item.op.label);
    try {
      const result = await item.op.run();
      // Success: clear only THIS op's line (keyed by id, so a duplicate-label
      // failed line from an earlier op is never cross-deleted).
      this.removeJournalLine(journalId);
      item.resolve(result);
    } catch (err) {
      // Failure: leave the line as an A4 replay target; do not wedge the queue.
      item.reject(err);
    }
  }

  private appendJournalLine(id: string, label: string): void {
    try {
      secureAppend(this.journalPath, `${id}${JOURNAL_SEP}${sanitizeLabel(label)}\n`);
    } catch (err) {
      // Journalling is best-effort — a write failure must never block the op.
      console.warn(`[write-queue] journal append failed: ${summarizeErrorForLog(err)}`);
    }
  }

  private removeJournalLine(id: string): void {
    try {
      const content = fs.readFileSync(this.journalPath, 'utf-8');
      const remaining = parseJournal(content).filter(r => r.id !== id);
      secureWriteViaTmp(this.journalPath, serializeJournal(remaining));
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return; // nothing journalled (append had failed)
      console.warn(`[write-queue] journal prune failed: ${summarizeErrorForLog(err)}`);
    }
  }

  private flushDrainWaiters(): void {
    if (!this.isIdle()) return;
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }
}

/**
 * Replay residual journal lines at boot (amendment A4). For each stuck op, call
 * `onStuck(label)` and only remove that line once the callback resolves, so a
 * crash mid-replay re-surfaces the unprocessed lines on the next boot. A missing
 * journal is a no-op. In P1 `onStuck` only logs; mirror rebuild lands in P2.
 */
export async function replayJournal(
  journalPath: string,
  onStuck: (label: string) => Promise<void> | void,
): Promise<void> {
  let content: string;
  try {
    content = await fs.promises.readFile(journalPath, 'utf-8');
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return;
    console.warn(`[write-queue] journal read failed: ${summarizeErrorForLog(err)}`);
    return;
  }

  const records = parseJournal(content);
  const remaining = [...records];
  for (const rec of records) {
    try {
      await onStuck(rec.label);
    } catch (err) {
      // Recovery failed — leave the line for the next boot rather than dropping it.
      console.warn(`[write-queue] recovery of a stuck op failed: ${summarizeErrorForLog(err)}`);
      continue;
    }
    const idx = remaining.indexOf(rec);
    if (idx >= 0) remaining.splice(idx, 1);
    try {
      secureWriteViaTmp(journalPath, serializeJournal(remaining));
    } catch (err) {
      console.warn(`[write-queue] journal rewrite during replay failed: ${summarizeErrorForLog(err)}`);
    }
  }
}
