
import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import { AppError, DaemonShutdownError } from '../shared/errors';
import type { WriteQueue, WritePriority, WriteOp } from '../profiles';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonicalize(object[key])]));
  }
  return value;
}

export function computeIdempotencyKey(parts: {
  chatId: string;
  turnMessageId: string;
  toolCallId?: string;
  canonicalParams: unknown;
}): string {
  const canonical = JSON.stringify(canonicalize(parts.canonicalParams));
  return createHash('sha256')
    .update(`${parts.chatId}:${parts.turnMessageId}:${parts.toolCallId ?? ''}:${canonical}`)
    .digest('hex');
}

export class ReentrantMutationError extends AppError {
  constructor(attemptedLabel: string, runningLabel: string) {
    super(`MutationCoordinator: "${attemptedLabel}" was called re-entrantly from within the already-running op "${runningLabel}" — this would deadlock the single-threaded write pump. Internal Tier-1 projection steps must run inline, never via enqueue()/mutate()/selfHeal() again.`);
  }
}

/** A keyed mutation op. `id` is folded into the journal `scope` for recovery diagnostics; it
 *  carries no different locking semantics today (see module doc, point 2). */
export interface MutateOp<T> {
  id: string;
  label: string;
  idempotencyKey?: string;
  run(): Promise<T>;
}

export class MutationCoordinator {
  private readonly reentrancyGuard = new AsyncLocalStorage<string>();

  constructor(
    private readonly queue: WriteQueue,
    private readonly isShutdown: () => boolean = () => false,
  ) {}

  /** Plain append-only entry point (NarrativeStore/CuriosityQueue-shaped lanes). Structurally
   *  compatible with the existing `QueuePort` (capture/pipeline.ts) — a drop-in for `WriteQueue`. */
  enqueue<T>(priority: WritePriority, op: WriteOp<T>): Promise<T> {
    this.assertNotShutdown(op.label);
    this.assertNotReentrant(op.label);
    return this.queue.enqueue(priority, {
      label: op.label,
      scope: op.scope,
      idempotencyKey: op.idempotencyKey,
      run: () => this.runGuarded(op.label, op.run),
    });
  }

  /** Keyed read-modify-write entry point. See module doc point 2 for why this currently shares
   *  `enqueue()`'s serialization rather than sharding by `id`. */
  mutate<T>(priority: WritePriority, op: MutateOp<T>): Promise<T> {
    this.assertNotShutdown(op.label);
    this.assertNotReentrant(op.label);
    return this.queue.enqueue(priority, {
      label: op.label,
      scope: op.id,
      idempotencyKey: op.idempotencyKey,
      run: () => this.runGuarded(op.label, op.run),
    });
  }

  selfHeal<T>(label: string, run: () => Promise<T>): Promise<T> {
    const fullLabel = `self-heal:${label}`;
    this.assertNotShutdown(fullLabel);
    this.assertNotReentrant(fullLabel);
    return this.queue.enqueue('turn', {
      label: fullLabel,
      scope: 'self-heal',
      run: () => this.runGuarded(fullLabel, run),
    });
  }

  /** Resolves once the queue is idle (delegates to the underlying `WriteQueue.drain()`). NEVER
   *  gated by `isShutdown` — draining must stay possible for as long as shutdown itself needs it. */
  drain(): Promise<void> {
    return this.queue.drain();
  }

  /** Reject a late write before it ever touches the WriteQueue/stores. Checked before the
   *  reentrancy guard (the expected-during-shutdown case takes priority over the rarer
   *  programming-error case). */
  private assertNotShutdown(label: string): void {
    if (this.isShutdown()) {
      throw new DaemonShutdownError(label);
    }
  }

  private assertNotReentrant(label: string): void {
    const runningLabel = this.reentrancyGuard.getStore();
    if (runningLabel !== undefined) {
      throw new ReentrantMutationError(label, runningLabel);
    }
  }

  private runGuarded<T>(label: string, run: () => Promise<T>): Promise<T> {
    return this.reentrancyGuard.run(label, run);
  }
}
