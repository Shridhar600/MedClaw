import * as fs from 'fs';
import * as path from 'path';
import { WriteQueue } from '../../src/profiles';
import { MutationCoordinator, ReentrantMutationError, computeIdempotencyKey } from '../../src/capture';
import { makeTestTemp } from '../helpers/test-temp';

describe('MutationCoordinator', () => {
  let root: string;
  let queue: WriteQueue;
  let coordinator: MutationCoordinator;

  beforeEach(() => {
    root = makeTestTemp('redacted-coordinator-');
    queue = new WriteQueue({ journalPath: path.join(root, 'write-queue.journal') });
    coordinator = new MutationCoordinator(queue);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('rejects a re-entrant mutate call from inside a running op instead of deadlocking', async () => {
    const outerRun = coordinator.mutate('turn', {
      id: 'outer',
      label: 'outer-op',
      run: async () => {
        await coordinator.mutate('turn', { id: 'inner', label: 'inner-op', run: async () => 'inner-result' });
        return 'outer-result';
      },
    });
    await expect(outerRun).rejects.toBeInstanceOf(ReentrantMutationError);
  });

  it('rejects a re-entrant enqueue call from inside a running selfHeal op', async () => {
    const heal = coordinator.selfHeal('probe', async () => {
      await coordinator.enqueue('turn', { label: 'nested', run: async () => undefined });
      return 'healed';
    });
    await expect(heal).rejects.toBeInstanceOf(ReentrantMutationError);
  });

  it('a mutation whose Tier-1 step runs INLINE (no enqueue) completes normally — proves the fix is not "never call anything", only "never enqueue again"', async () => {
    const tier1Calls: string[] = [];
    const result = await coordinator.mutate('turn', {
      id: 'ledger:medication',
      label: 'ledger-write',
      run: async () => {
        tier1Calls.push('fact-mirror-replaceType');
        return 'ledger-fact-id-1';
      },
    });
    expect(result).toBe('ledger-fact-id-1');
    expect(tier1Calls).toEqual(['fact-mirror-replaceType']);
  });

  it('does NOT false-positive on ordinary concurrent callers (not reentrancy — two independent top-level ops)', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const first = coordinator.mutate('turn', {
      id: 'a',
      label: 'first',
      run: async () => { await gate; order.push('first'); return 1; },
    });
    const second = coordinator.mutate('turn', {
      id: 'b',
      label: 'second',
      run: async () => { order.push('second'); return 2; },
    });
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(['first', 'second']);
  });

  it('selfHeal runs as a distinctly-labeled top-level op and is NOT itself reentrancy-blocked when called from outside any running op', async () => {
    const result = await coordinator.selfHeal('safety-projection', async () => 'healed-ok');
    expect(result).toBe('healed-ok');
  });

  it('drain delegates to the underlying WriteQueue', async () => {
    void coordinator.enqueue('background', { label: 'bg', run: async () => undefined });
    await expect(coordinator.drain()).resolves.toBeUndefined();
  });
});

describe('computeIdempotencyKey', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeIdempotencyKey({ chatId: 'chat-1', turnMessageId: 'msg-7', canonicalParams: { entity: 'metformin', dose: '500mg' } });
    const b = computeIdempotencyKey({ chatId: 'chat-1', turnMessageId: 'msg-7', canonicalParams: { entity: 'metformin', dose: '500mg' } });
    expect(a).toBe(b);
  });

  it('is insensitive to canonicalParams key ORDER (deep-sorted before hashing)', () => {
    const a = computeIdempotencyKey({ chatId: 'chat-1', turnMessageId: 'msg-7', canonicalParams: { dose: '500mg', entity: 'metformin' } });
    const b = computeIdempotencyKey({ chatId: 'chat-1', turnMessageId: 'msg-7', canonicalParams: { entity: 'metformin', dose: '500mg' } });
    expect(a).toBe(b);
  });

  it('a heartbeat replayed on a NEW lastRunAt is NOT dropped as a dup — a static job.id alone would collide across days', () => {
    const staticJobIdOnly = (): string => computeIdempotencyKey({
      chatId: 'chat-1', turnMessageId: 'job-daily-reminder', canonicalParams: { tool: 'ledger_record', entity: 'checkin' },
    });
    expect(staticJobIdOnly()).toBe(staticJobIdOnly());

    const keyForDay = (lastRunAt: string): string => computeIdempotencyKey({
      chatId: 'chat-1',
      turnMessageId: `job-daily-reminder:${lastRunAt}`,
      canonicalParams: { tool: 'ledger_record', entity: 'checkin' },
    });
    const day1 = keyForDay('2026-09-01T09:00:00.000Z');
    const day2 = keyForDay('2026-09-02T09:00:00.000Z');
    expect(day1).not.toBe(day2); // tomorrow's reminder is NOT dropped as a duplicate of today's
  });

  it('distinguishes parallel same-tool calls via toolCallId when arguments are otherwise identical', () => {
    const callA = computeIdempotencyKey({
      chatId: 'chat-1', turnMessageId: 'msg-9', toolCallId: 'call_A',
      canonicalParams: { entity: 'headache', type: 'symptom' },
    });
    const callB = computeIdempotencyKey({
      chatId: 'chat-1', turnMessageId: 'msg-9', toolCallId: 'call_B',
      canonicalParams: { entity: 'headache', type: 'symptom' },
    });
    expect(callA).not.toBe(callB);
  });

  it('WITHOUT a toolCallId, two identical-argument calls in the same turn collide (disclosed gap when a caller cannot supply one)', () => {
    const callA = computeIdempotencyKey({ chatId: 'chat-1', turnMessageId: 'msg-9', canonicalParams: { entity: 'headache' } });
    const callB = computeIdempotencyKey({ chatId: 'chat-1', turnMessageId: 'msg-9', canonicalParams: { entity: 'headache' } });
    expect(callA).toBe(callB);
  });
});
