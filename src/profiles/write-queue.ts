import * as fs from 'fs';
import type { IdGen } from '../ports';
import { uuidIdGen } from '../ports';
import { secureAppend, secureWriteViaTmp, summarizeErrorForLog } from '../security';

export type WritePriority = 'turn' | 'background';

/** A unit of work; `run()` must be IO-only, never an LLM call. */
export interface WriteOp<T> {
  label: string;
  /** PHI-free affected-lane name for recovery diagnostics. */
  scope?: string;
  /** Joins queue recovery with capture dedup. */
  idempotencyKey?: string;
  run(): Promise<T>;
}

export interface WriteQueueOptions {
  journalPath: string;
  /** ID generator; injected for testability. */
  idGen?: IdGen;
  /** Receives every begin with no matching commit at queue-idle. */
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

// Journal fields are line-safe and bounded; labels/scopes must not carry health content.
function sanitizeJournalField(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').slice(0, 256);
}

function serializeJournal(records: JournalRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}

function parseJournalLine(line: string): JournalRecord | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.phase === 'begin' && typeof parsed.id === 'string' && typeof parsed.label === 'string') {
      return {
        phase: 'begin',
        id: parsed.id,
        label: parsed.label,
        ...(typeof parsed.scope === 'string' ? { scope: parsed.scope } : {}),
        ...(typeof parsed.idempotencyKey === 'string' ? { idempotencyKey: parsed.idempotencyKey } : {}),
      };
    }
    if (parsed.phase === 'commit' && typeof parsed.id === 'string') return { phase: 'commit', id: parsed.id };
  } catch {
    // An unreadable line is dropped with the rest of the handled journal.
  }
  return null;
}

function unresolvedBegins(records: JournalRecord[]): JournalBeginRecord[] {
  const committed = new Set(
    records
      .filter((record): record is JournalCommitRecord => record.phase === 'commit')
      .map((record) => record.id),
  );
  return records.filter(
    (record): record is JournalBeginRecord => record.phase === 'begin' && !committed.has(record.id),
  );
}

export interface JournalReconcileResult {
  readable: boolean;
  uncommitted: number;
}

/** Empties the journal only if no op appended since the read (appends are synchronous). */
export async function reconcileJournal(
  journalPath: string,
  onUncommitted?: (record: JournalBeginRecord) => Promise<void> | void,
): Promise<JournalReconcileResult> {
  let bytes: Buffer;
  try {
    bytes = await fs.promises.readFile(journalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[write-queue] journal read failed: ${summarizeErrorForLog(err)}`);
    }
    return { readable: false, uncommitted: 0 };
  }
  const records = bytes.toString('utf8').split('\n').filter((line) => line.trim() !== '').map(parseJournalLine)
    .filter((record): record is JournalRecord => record !== null);
  const pending = unresolvedBegins(records);
  for (const record of pending) {
    try {
      await onUncommitted?.(record);
    } catch (err) {
      console.warn(`[write-queue] journal reconciliation callback failed: ${summarizeErrorForLog(err)}`);
    }
  }
  try {
    if (bytes.length > 0 && fs.statSync(journalPath).size === bytes.length) fs.truncateSync(journalPath, 0);
  } catch (err) {
    console.warn(`[write-queue] journal truncate failed: ${summarizeErrorForLog(err)}`);
  }
  return { readable: true, uncommitted: pending.length };
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
  private readonly idleReconciliations = new Set<Promise<void>>();
  private journalDegraded = false;
  private readonly reported = new Set<string>();

  constructor(options: WriteQueueOptions) {
    this.journalPath = options.journalPath;
    this.idGen = options.idGen ?? uuidIdGen;
    this.onReconcile = options.onReconcile ?? ((record) => {
      console.warn(`[write-queue] uncommitted operation detected: ${sanitizeJournalField(record.label)}`);
    });
  }

  setReconciler(onReconcile: (record: JournalBeginRecord) => Promise<void> | void): void {
    this.onReconcile = onReconcile;
  }

  enqueue<T>(priority: WritePriority, op: WriteOp<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = { op: op as WriteOp<unknown>, resolve: resolve as (v: unknown) => void, reject };
      (priority === 'turn' ? this.turnQ : this.backgroundQ).push(item);
      this.schedulePump();
    });
  }

  drain(): Promise<void> {
    return this.drainUntilIdle();
  }

  private async drainUntilIdle(): Promise<void> {
    let finished = false;
    while (!finished) {
      if (!this.isIdle()) {
        await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
        continue;
      }

      if (!this.idleReconcile) this.scheduleIdleReconcile();
      const reconciliations = [...this.idleReconciliations];
      if (reconciliations.length > 0) await Promise.all(reconciliations);
      finished = this.isIdle() && this.idleReconciliations.size === 0;
    }
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
      // Turns drain fully ahead, so a turn enqueued mid-flight jumps the backlog.
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
      // A journal outage must never fail health-data persistence.
      this.appendJournalRecord({ phase: 'commit', id: journalId });
      item.resolve(result);
    } catch (err) {
      // Its begin stays an unresolved recovery target.
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
    const run = reconcileJournal(this.journalPath, (record) => {
      if (this.reported.has(record.id)) return;
      this.reported.add(record.id);
      return this.onReconcile(record);
    })
      .then(() => undefined)
      .catch((err) => {
        // Reconciliation is never allowed to reject a source or a drain waiter.
        console.warn(`[write-queue] queue-idle reconciliation failed: ${summarizeErrorForLog(err)}`);
      });
    this.idleReconcile = run;
    this.idleReconciliations.add(run);
    void run.then(
      () => { this.idleReconciliations.delete(run); },
      () => { this.idleReconciliations.delete(run); },
    );
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
