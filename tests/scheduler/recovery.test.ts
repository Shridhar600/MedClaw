import type { HeartbeatJob } from '../../src/scheduler/types';
import { findMostRecentMissedRun } from '../../src/scheduler/recovery';

function makeJob(overrides: Partial<HeartbeatJob> = {}): HeartbeatJob {
  return {
    id: 'job-1',
    title: 'Morning check-in',
    chatId: 'chat-1',
    cron: '0 8 * * *',
    timezone: 'UTC',
    prompt: 'Ask how the user is feeling.',
    enabled: true,
    source: 'system',
    kind: 'routine',
    deliveryState: 'ready',
    retryCount: 0,
    maxRetries: 2,
    createdAt: '2026-04-19T07:00:00.000Z',
    updatedAt: '2026-04-19T07:00:00.000Z',
    ...overrides,
  };
}

describe('findMostRecentMissedRun', () => {
  it('returns an eligible missed run inside the recovery window', () => {
    const recoveredAt = findMostRecentMissedRun(
      makeJob(),
      {
        now: new Date('2026-04-19T08:30:00.000Z'),
        windowMinutes: 60,
      },
    );

    expect(recoveredAt).toBe('2026-04-19T08:00:00.000Z');
  });

  it('does not recover runs outside the recovery window', () => {
    const recoveredAt = findMostRecentMissedRun(
      makeJob(),
      {
        now: new Date('2026-04-19T08:30:00.000Z'),
        windowMinutes: 15,
      },
    );

    expect(recoveredAt).toBeUndefined();
  });

  it('does not recover a missed fire from before the job existed', () => {
    const recoveredAt = findMostRecentMissedRun(
      makeJob({ createdAt: '2026-04-19T08:10:00.000Z' }),
      {
        now: new Date('2026-04-19T08:30:00.000Z'),
        windowMinutes: 60,
      },
    );

    expect(recoveredAt).toBeUndefined();
  });

  it('recovers only the most recent missed fire when multiple runs were missed', () => {
    const recoveredAt = findMostRecentMissedRun(
      makeJob({ cron: '*/15 8 * * *' }),
      {
        now: new Date('2026-04-19T08:59:00.000Z'),
        windowMinutes: 120,
      },
    );

    expect(recoveredAt).toBe('2026-04-19T08:45:00.000Z');
  });

  it('does not flood replay when a dense schedule missed many runs', () => {
    const recoveredAt = findMostRecentMissedRun(
      makeJob({ cron: '*/5 * * * *' }),
      {
        now: new Date('2026-04-19T08:59:00.000Z'),
        windowMinutes: 180,
      },
    );

    expect(recoveredAt).toBe('2026-04-19T08:55:00.000Z');
  });
});
