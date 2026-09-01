// src/profiles/write-queue.ts
//
// Per-profile single-writer queue. Every memory mutation funnels through one
// serialized promise-chain so two writes never interleave on the same profile
// (PLAT-03, amendment B2). Inbound-turn ops outrank background ops (a user is
// waiting; heartbeats/dreaming are not). Journal failures are advisory: they
// degrade recovery visibility but never block the source operation.

import * as fs from 'fs';
import * as readline from 'readline';
import type { IdGen } from '../ports';
import { uuidIdGen } from '../ports';
import { secureAppend, secureWriteViaTmp, summarizeErrorForLog } from '../security';

export type WritePriority = 'turn' | 'background';

/** A unit of work. `run()` MUST be IO-only — never an LLM call (amendment B2). */
export interface WriteOp<T> {
  label: string;
  /** PHI-free affected-lane name, for recovery diagnostics. */
  scope?: string;
  /** Opaque source-event identity used to join queue recovery with capture dedup. */
  idempotencyKey?: string;
  run(): Promise<T>;
}

export interface WriteQueueOptions {
  journalPath: string;
  /** Injected for testability; defaults to a crypto UUID generator. */
  idGen?: IdGen;
  /** Receives every begin record that has no matching commit at queue-idle. */
  onReconcile?: (record: JournalBeginRecord) => Promise<void> | void;
}

interface QueueItem {
  op: WriteOp<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export interface JournalBeginRecord {
  phase: 'begin';
  id: string;
  label: string;
  scope?: string;
  idempotencyKey?: string;
}

export interface JournalCommitRecord {
  phase: 'commit';
  id: string;
}

export type JournalRecord = JournalBeginRecord | JournalCommitRecord;

type ParsedJournalRecord = JournalRecord & {
  /** True when this record came from the pre-RR-6b tab-separated format. */
  legacy?: boolean;
};

/** Keep journal fields line-safe and bounded. Callers must supply labels/scopes without health content. */
function sanitizeJournalField(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').slice(0, 256);
}

function serializeJournal(records: JournalRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}

function serializeLegacyJournal(records: ParsedJournalRecord[]): string {
  return records
    .filter((record): record is JournalBeginRecord & { legacy?: boolean } => record.phase === 'begin')
    .map((record) => `${record.id}\t${sanitizeJournalField(record.label)}`)
    .join('\n') + (records.some((record) => record.phase === 'begin') ? '\n' : '');
}

function recordPhase(parsed: Record<string, unknown>): unknown {
  return parsed.phase ?? parsed.type ?? parsed.kind ?? parsed.event;
}

function parseJournalLine(line: string): ParsedJournalRecord {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const phase = recordPhase(parsed);
    if (phase === 'begin' && typeof parsed.id === 'string' && typeof parsed.label === 'string') {
      return {
        phase: 'begin',
        id: parsed.id,
        label: parsed.label,
        ...(typeof parsed.scope === 'string' ? { scope: parsed.scope } : {}),
        ...(typeof parsed.idempotencyKey === 'string' ? { idempotencyKey: parsed.idempotencyKey } : {}),
      };
    }
    if (phase === 'commit' && typeof parsed.id === 'string') return { phase: 'commit', id: parsed.id };
  } catch {
    // Fall through to the legacy line parser. A malformed line remains visible to reconciliation.
  }

  const sep = line.indexOf('\t');
  if (sep < 0) return { phase: 'begin', id: '', label: line.trim(), legacy: true };
  return { phase: 'begin', id: line.slice(0, sep), label: line.slice(sep + 1), legacy: true };
}

function unresolvedBegins(records: ParsedJournalRecord[]): JournalBeginRecord[] {
  const committed = new Set(
    records
      .filter((record): record is JournalCommitRecord => record.phase === 'commit')
      .map((record) => record.id),
  );
  return records.filter(
    (record): record is JournalBeginRecord => record.phase === 'begin' && !committed.has(record.id),
  );
}

async function readJournal(journalPath: string): Promise<{ records: ParsedJournalRecord[]; legacy: boolean } | null> {
  let input: fs.ReadStream | undefined;
  try {
    input = fs.createReadStream(journalPath, { encoding: 'utf8' });
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    const records: ParsedJournalRecord[] = [];
    let sawRecord = false;
    let allLegacy = true;
    try {
      for await (const line of reader) {
        const text = String(line);
        if (!text.trim()) continue;
        const record = parseJournalLine(text);
        records.push(record);
        sawRecord = true;
        if (!record.legacy) allLegacy = false;
      }
    } finally {
      reader.close();
    }
    return { records, legacy: sawRecord && allLegacy };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[write-queue] journal read failed: ${summarizeErrorForLog(err)}`);
    }
    return null;
  } finally {
    input?.destroy();
  }
}

export interface JournalReconcileResult {
  readable: boolean;
  uncommitted: number;
}

/** Detect begin-without-commit records without deleting or rewriting the append-only journal. */
export async function reconcileJournal(
  journalPath: string,
  onUncommitted?: (record: JournalBeginRecord) => Promise<void> | void,
): Promise<JournalReconcileResult> {
  const journal = await readJournal(journalPath);
  if (!journal) {
    return { readable: false, uncommitted: 0 };
  }
  const pending = unresolvedBegins(journal.records);
  for (const record of pending) {
    try {
      await onUncommitted?.(record);
    } catch (err) {
      console.warn(`[write-queue] journal reconciliation callback failed: ${summarizeErrorForLog(err)}`);
    }
  }
  return { readable: true, uncommitted: pending.length };
}

/**
 * Compatibility recovery entry point. Legacy tab-separated journals retain their old clear-on-success
 * behavior. RR-6b JSON journals are append-only: this function surfaces unresolved begins but leaves the
 * records in place, because a callback that only rebuilds projections cannot prove the source committed.
 */
export async function replayJournal(
  journalPath: string,
  onStuck: (label: string) => Promise<void> | void,
): Promise<void> {
  const journal = await readJournal(journalPath);
  if (!journal) return;

  if (!journal.legacy) {
    await reconcileJournal(journalPath, (record) => onStuck(record.label));
    return;
  }

  const remaining = [...journal.records];
  for (const record of unresolvedBegins(journal.records)) {
    try {
      await onStuck(record.label);
    } catch (err) {
      console.warn(`[write-queue] recovery of a stuck op failed: ${summarizeErrorForLog(err)}`);
      continue;
    }
    const idx = remaining.indexOf(record);
    if (idx >= 0) remaining.splice(idx, 1);
    try {
      secureWriteViaTmp(journalPath, serializeLegacyJournal(remaining));
    } catch (err) {
      console.warn(`[write-queue] journal rewrite during replay failed: ${summarizeErrorForLog(err)}`);
    }
  }
}

export class WriteQueue {
  private readonly journalPath: string;
  private readonly idGen: IdGen;
  private readonly turnQ: QueueItem[] = [];
  private readonly backgroundQ: QueueItem[] = [];
  private onReconcile: (record: JournalBeginRecord) => Promise<void> | void;
  private running = false;
  private drainWaiters: Array<() => void> = [];
  private idleReconcile?: Promise<void>;
  private journalDegraded = false;

  constructor(options: WriteQueueOptions) {
    this.journalPath = options.journalPath;
    this.idGen = options.idGen ?? uuidIdGen;
    this.onReconcile = options.onReconcile ?? ((record) => {
      console.warn(`[write-queue] uncommitted operation detected: ${sanitizeJournalField(record.label)}`);
    });
  }

  /** Replace the recovery callback after boot wiring has constructed the profile collaborators. */
  setReconciler(onReconcile: (record: JournalBeginRecord) => Promise<void> | void): void {
    this.onReconcile = onReconcile;
  }

  /** Enqueue an IO-only op. Resolves/rejects with the op's own result. */
  enqueue<T>(priority: WritePriority, op: WriteOp<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = { op: op as WriteOp<unknown>, resolve: resolve as (v: unknown) => void, reject };
      (priority === 'turn' ? this.turnQ : this.backgroundQ).push(item);
      this.schedulePump();
    });
  }

  /** Resolves after the queue is idle and its advisory journal reconciliation has completed. */
  drain(): Promise<void> {
    if (this.isIdle()) return this.idleReconcile ?? this.scheduleIdleReconcile();
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
    this.appendJournalRecord({
      phase: 'begin',
      id: journalId,
      label: sanitizeJournalField(item.op.label),
      ...(item.op.scope ? { scope: sanitizeJournalField(item.op.scope) } : {}),
      ...(item.op.idempotencyKey ? { idempotencyKey: sanitizeJournalField(item.op.idempotencyKey) } : {}),
    });
    try {
      const result = await item.op.run();
      // A commit is appended only after the source op succeeds. A commit-write failure is degraded and
      // never changes the source result, so a journal outage cannot fail health-data persistence.
      this.appendJournalRecord({ phase: 'commit', id: journalId });
      item.resolve(result);
    } catch (err) {
      // A source failure belongs to the source op. Its begin remains an unresolved recovery target.
      item.reject(err);
    }
  }

  private appendJournalRecord(record: JournalRecord): void {
    try {
      secureAppend(this.journalPath, serializeJournal([record]));
    } catch (err) {
      this.journalDegraded = true;
      console.warn(`[write-queue] journal append failed; source operation continues: ${summarizeErrorForLog(err)}`);
      this.persistJournalDegradedFlag();
    }
  }

  private persistJournalDegradedFlag(): void {
    try {
      secureWriteViaTmp(`${this.journalPath}.degraded`, JSON.stringify({ version: 1, degraded: true }));
    } catch (err) {
      console.warn(`[write-queue] journal degraded flag write failed: ${summarizeErrorForLog(err)}`);
    }
  }

  private scheduleIdleReconcile(): Promise<void> {
    const run = reconcileJournal(this.journalPath, this.onReconcile)
      .then(() => undefined)
      .catch((err) => {
        // Reconciliation is never allowed to reject a source or a drain waiter.
        console.warn(`[write-queue] queue-idle reconciliation failed: ${summarizeErrorForLog(err)}`);
      });
    this.idleReconcile = run;
    return run;
  }

  private flushDrainWaiters(): void {
    if (!this.isIdle()) return;
    const reconcile = this.scheduleIdleReconcile();
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    void reconcile.then(() => {
      for (const waiter of waiters) waiter();
    });
  }
}
