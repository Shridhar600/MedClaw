import type { HeartbeatJob } from '../../src/scheduler/types';
import { determineRetryAction } from '../../src/scheduler/retry-policy';

function makeJob(overrides: Partial<HeartbeatJob> = {}): HeartbeatJob {
  return {
    id: 'job-1',
    title: 'Morning check-in',
    chatId: 'chat-1',
    cron: '0 8 * * *',
    timezone: 'Asia/Kolkata',
    prompt: 'Ask how the user is feeling.',
    enabled: true,
    source: 'system',
    kind: 'routine',
    deliveryState: 'ready',
    retryCount: 0,
    maxRetries: 2,
    createdAt: '2026-04-19T08:00:00.000Z',
    updatedAt: '2026-04-19T08:00:00.000Z',
    ...overrides,
  };
}

describe('determineRetryAction', () => {
  it('schedules a retry for eligible runtime failures', () => {
    const decision = determineRetryAction(
      makeJob(),
      {
        outcome: 'error',
        failedAt: '2026-04-19T08:00:00.000Z',
        errorMessage: 'send failed',
      },
      { backoffMinutes: 5 },
    );

    expect(decision.action).toBe('retry');
    if (decision.action !== 'retry') {
      throw new Error('expected retry action');
    }
    expect(decision.patch.deliveryState).toBe('retry-wait');
    expect(decision.patch.retryCount).toBe(1);
    expect(decision.patch.nextRetryAt).toBe('2026-04-19T08:05:00.000Z');
    expect(decision.patch.lastError).toBe('send failed');
  });

  it('does not retry suppressions or no-op outcomes', () => {
    const outcomes = ['noop', 'skipped-quiet-hours', 'skipped-recent-activity'] as const;

    for (const outcome of outcomes) {
      const decision = determineRetryAction(
        makeJob(),
        {
          outcome,
          failedAt: '2026-04-19T08:00:00.000Z',
          errorMessage: `${outcome} should not retry`,
        },
        { backoffMinutes: 5 },
      );

      expect(decision).toEqual({ action: 'none' });
    }
  });

  it('moves a job to dead-letter when retries are exhausted', () => {
    const decision = determineRetryAction(
      makeJob({ retryCount: 2, maxRetries: 2 }),
      {
        outcome: 'error',
        failedAt: '2026-04-19T08:00:00.000Z',
        errorMessage: 'send failed',
      },
      { backoffMinutes: 5 },
    );

    expect(decision.action).toBe('dead-letter');
    if (decision.action !== 'dead-letter') {
      throw new Error('expected dead-letter action');
    }
    expect(decision.patch.deliveryState).toBe('dead-letter');
    expect(decision.patch.retryCount).toBe(3);
    expect(decision.patch.nextRetryAt).toBeUndefined();
    expect(decision.patch.deadLetterReason).toContain('send failed');
  });

  it('uses the configured backoff minutes when scheduling the next retry', () => {
    const decision = determineRetryAction(
      makeJob({ retryCount: 1 }),
      {
        outcome: 'error',
        failedAt: '2026-04-19T08:00:00.000Z',
        errorMessage: 'gateway failed',
      },
      { backoffMinutes: 12 },
    );

    expect(decision.action).toBe('retry');
    if (decision.action !== 'retry') {
      throw new Error('expected retry action');
    }
    expect(decision.patch.retryCount).toBe(2);
    expect(decision.patch.nextRetryAt).toBe('2026-04-19T08:12:00.000Z');
  });
});
