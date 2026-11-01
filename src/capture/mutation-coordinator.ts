// src/capture/mutation-coordinator.ts
//
// MutationCoordinator: the single writer every model-facing mutation routes through. It is a thin
// wrapper over the crash-safe `WriteQueue` (src/profiles/write-queue.ts), which already gives
// begin/commit journaling and turn-priority serialization. This module adds three properties:
//
//   1. No re-entrancy. The pump is single-threaded: a queue op whose `run()` calls
//      `enqueue()`/`mutate()` again would push an item onto the same queue the pump is blocked
//      awaiting, and the loop would never serve it (deadlock). Guarded with `AsyncLocalStorage`,
//      which follows the async continuation of a running op (a call nested many `await`s deep is
//      still caught) but does not flag a separate, legitimately concurrent caller. A module-level
//      boolean flag would false-positive on ordinary concurrent callers.
//   2. A semantic `mutate()` entry point for keyed read-modify-write ops, alongside `run()`
//      (`enqueue()`) for append-only lanes. The underlying `WriteQueue` is a single global pump,
//      not sharded per key, so the two share identical serialization today. `mutate()` is the keyed
//      call site (its `id` flows into the journal `scope` for diagnostics) and the seam for
//      sharding per id later.
//   3. A `selfHeal()` entry point: a distinctly labeled new top-level op. It must never be invoked
//      from inside a running op; the same re-entrancy guard applies.
//
// Tier-1 vs Tier-2 classification and idempotency-with-cached-result live in the domain callers
// (CapturePipeline, ledger-tools, episode-tools, safety-tools, recall/engine.ts). This module only
// guarantees the one lock, no re-entrancy and the semantic entry points they are built on.

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

/**
 * The idempotency key scheme:
 * `sha256(chatId : turnMessageId : toolCallId : canonicalParams)`. `turnMessageId` is the caller's
 * per-turn identity (the Telegram messageId for a chat turn; `${job.id}:${lastRunAt}` for a
 * heartbeat, since a static `job.id` alone would drop tomorrow's recurring reminder as a duplicate
 * of today's; `test:${chatId}:${turnIndex}` for CLI/test). `toolCallId` (the provider's per-call id)
 * disambiguates two parallel calls to the same tool with identical arguments in one turn; without
 * it such calls collide and dedupe to one (a known gap when a caller cannot supply one).
 * `canonicalParams` is deep-key-sorted before hashing so field order never changes the key.
 */
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

/** Thrown synchronously (before the op is ever enqueued) when `enqueue`/`mutate`/`selfHeal` is
 *  called from within the async continuation of an already-running coordinator op. The
 *  single-threaded pump would otherwise deadlock silently; failing fast turns a hang into a
 *  diagnosable programming error. */
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

  /**
   * `isShutdown` is a port injected by the composition root (`ProfileRuntime`, wired to
   * `runtime.isClosed()`), never a direct import of `src/gateway`, which would violate the
   * v2-core module boundary. It keys on closed (post-`closeStore()`), not merely "stopping": an
   * in-flight mutation that started before `stop()` began must still be allowed to enqueue and
   * drain (that is the point of `drainInFlightOperations`/`writeQueue.drain()` in `runtime.ts`'s
   * `drainAndClose`). Gating on "stopping" would strand such an op mid-drain. Defaults to "never
   * shut down" so existing call sites are unaffected.
   */
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

  /** A NEW top-level op that re-projects a Tier-1 view from its authoritative source after a read
   *  detected drift. MUST be called from OUTSIDE any running coordinator op (a read path, never
   *  from inside another op's `run()`) — the re-entrancy guard enforces this the same as
   *  `enqueue`/`mutate`. Always `turn`-priority: a foreground read is waiting on it. */
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
