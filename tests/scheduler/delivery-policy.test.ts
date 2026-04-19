import type { HeartbeatJob } from '../../src/scheduler/types';
import { decideHeartbeatDelivery } from '../../src/scheduler/delivery-policy';

function makeJob(): HeartbeatJob {
  return {
    id: 'job-1',
    title: 'Morning check-in',
    chatId: 'chat-1',
    cron: '0 8 * * *',
    timezone: 'Asia/Kolkata',
    prompt: 'Prompt',
    enabled: true,
    source: 'system',
    kind: 'routine',
    deliveryState: 'ready',
    retryCount: 0,
    maxRetries: 2,
    policyKey: 'defaults:morning-check-in',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('decideHeartbeatDelivery', () => {
  it('skips delivery during quiet hours', () => {
    const decision = decideHeartbeatDelivery(makeJob(), {
      now: new Date('2026-04-18T22:30:00+05:30'),
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
      lastChatActivityAt: undefined,
      skipIfChatActiveWithinMinutes: 60,
    });
    expect(decision).toEqual({ action: 'skip', reason: 'skipped-quiet-hours' });
  });

  it('skips delivery when the chat was recently active', () => {
    const decision = decideHeartbeatDelivery(makeJob(), {
      now: new Date('2026-04-18T20:00:00+05:30'),
      quietHours: { enabled: true, start: '22:00', end: '07:00' },
      lastChatActivityAt: new Date('2026-04-18T19:30:00+05:30'),
      skipIfChatActiveWithinMinutes: 60,
    });
    expect(decision).toEqual({ action: 'skip', reason: 'skipped-recent-activity' });
  });
});
