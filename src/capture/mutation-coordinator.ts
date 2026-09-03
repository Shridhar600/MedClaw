// src/capture/mutation-coordinator.ts
//
// MutationCoordinator — RR-STRUCT R-S3 (mini-plan v3 §3.6). The complete single-writer every
// model-facing mutation routes through. It is a thin wrapper over the RR-6b crash-safe
// `WriteQueue` (src/profiles/write-queue.ts): the queue already gives crash-safe begin/commit
// journaling and turn-priority serialization; this module adds the THREE properties the mini-
// plan requires on top of it:
//
//   1. No re-entrancy (Finding-4): the pump is single-threaded — a queue op whose `run()` calls
//      `enqueue()`/`mutate()` again would push a new item onto the SAME queue the pump's `while`
//      loop is currently blocked inside `await`-ing, and the loop never gets back around to serve
//      it (reproduced deadlock). Guarded here with `AsyncLocalStorage`, which correctly threads
//      through the ASYNC CONTINUATION of a running op (so a call nested many `await`s deep inside
//      `op.run()` is still caught) while NOT flagging a wholly separate, legitimately-concurrent
//      caller who happens to call `enqueue()` while another op is mid-flight (that caller has its
//      own call stack, not descended from the running op's `AsyncLocalStorage.run()`) — a naive
//      module-level boolean flag would have false-positived on ordinary concurrent callers.
//   2. A semantic `mutate()` entry point for keyed read-modify-write ops, alongside `run()`
//      (`enqueue()`) for append-only lanes. NOTE (disclosed design call, see report §1): the
//      underlying `WriteQueue` is a single GLOBAL pump, not sharded per key — so `mutate()` and
//      `enqueue()` share identical serialization semantics today; `mutate()` exists as the KEYED
//      semantic call site (its `id` flows into the journal `scope` for diagnostics) and as the
//      forward-compat seam if the queue is ever sharded per id for throughput.
//   3. A `selfHeal()` entry point: a distinctly-labeled NEW top-level op (self-heal must never be
//      invoked from inside a running op — the same re-entrancy guard applies to it).
//
// Tier-1 vs Tier-2 classification, idempotency-with-cached-result, and the `fallbackActiveFacts`
// read-side port live in the domain callers (CapturePipeline, ledger-tools, episode-tools,
// safety-tools, recall/engine.ts) — this module only guarantees the ONE lock + no-reentrancy +
// semantic entry points every one of them is built on.

import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import { AppError } from '../shared/errors';
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
 * RR-STRUCT R-S3 (mini-plan v3 §3.6 Finding-5): the idempotency key scheme —
 * `sha256(chatId : turnMessageId : toolCallId : canonicalParams)`. `turnMessageId` is the caller's
 * per-turn identity (the Telegram messageId for a chat turn; `${job.id}:${lastRunAt}` for a
 * heartbeat — a static `job.id` alone would drop tomorrow's recurring reminder as a duplicate of
 * today's; `test:${chatId}:${turnIndex}` for CLI/test). `toolCallId` (the provider's per-call id)
 * disambiguates two parallel calls to the SAME tool with identical arguments in one turn — WITHOUT
 * it, such calls collide and dedupe to one (a known, disclosed gap when a caller cannot supply
 * one). `canonicalParams` is deep-key-sorted before hashing so field order never changes the key.
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
 *  called from within the async continuation of an already-running coordinator op. The single-
 *  threaded pump would otherwise deadlock silently (Finding-4) — failing fast here turns a hang
 *  into a diagnosable programming error. */
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

  constructor(private readonly queue: WriteQueue) {}

  /** Plain append-only entry point (NarrativeStore/CuriosityQueue-shaped lanes). Structurally
   *  compatible with the existing `QueuePort` (capture/pipeline.ts) — a drop-in for `WriteQueue`. */
  enqueue<T>(priority: WritePriority, op: WriteOp<T>): Promise<T> {
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
    this.assertNotReentrant(fullLabel);
    return this.queue.enqueue('turn', {
      label: fullLabel,
      scope: 'self-heal',
      run: () => this.runGuarded(fullLabel, run),
    });
  }

  /** Resolves once the queue is idle (delegates to the underlying `WriteQueue.drain()`). */
  drain(): Promise<void> {
    return this.queue.drain();
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
