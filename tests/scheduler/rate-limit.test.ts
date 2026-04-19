import { HeartbeatRateLimiter } from '../../src/scheduler/rate-limit';

describe('HeartbeatRateLimiter', () => {
  it('defers when the global cap is reached', () => {
    const limiter = new HeartbeatRateLimiter({
      maxGlobalTriggersPerMinute: 2,
      maxPerChatTriggersPerMinute: 10,
    });

    expect(limiter.consume('chat-1', new Date('2026-04-19T08:00:00.000Z'))).toEqual({ action: 'allow' });
    expect(limiter.consume('chat-2', new Date('2026-04-19T08:00:10.000Z'))).toEqual({ action: 'allow' });

    expect(limiter.consume('chat-3', new Date('2026-04-19T08:00:20.000Z'))).toEqual({
      action: 'defer',
      scope: 'global',
      deferredUntil: '2026-04-19T08:01:00.000Z',
    });
  });

  it('defers when the per-chat cap is reached', () => {
    const limiter = new HeartbeatRateLimiter({
      maxGlobalTriggersPerMinute: 10,
      maxPerChatTriggersPerMinute: 2,
    });

    expect(limiter.consume('chat-1', new Date('2026-04-19T08:00:00.000Z'))).toEqual({ action: 'allow' });
    expect(limiter.consume('chat-1', new Date('2026-04-19T08:00:10.000Z'))).toEqual({ action: 'allow' });

    expect(limiter.consume('chat-1', new Date('2026-04-19T08:00:20.000Z'))).toEqual({
      action: 'defer',
      scope: 'chat',
      deferredUntil: '2026-04-19T08:01:00.000Z',
    });
  });

  it('returns a deferral timestamp instead of silently dropping work', () => {
    const limiter = new HeartbeatRateLimiter({
      maxGlobalTriggersPerMinute: 1,
      maxPerChatTriggersPerMinute: 1,
    });

    expect(limiter.consume('chat-1', new Date('2026-04-19T08:00:00.000Z'))).toEqual({ action: 'allow' });
    const decision = limiter.consume('chat-2', new Date('2026-04-19T08:00:20.000Z'));

    expect(decision.action).toBe('defer');
    if (decision.action !== 'defer') {
      throw new Error('expected defer decision');
    }
    expect(decision.deferredUntil).toBe('2026-04-19T08:01:00.000Z');
  });

  it('allows execution again after the one-minute window passes', () => {
    const limiter = new HeartbeatRateLimiter({
      maxGlobalTriggersPerMinute: 1,
      maxPerChatTriggersPerMinute: 1,
    });

    expect(limiter.consume('chat-1', new Date('2026-04-19T08:00:00.000Z'))).toEqual({ action: 'allow' });
    expect(limiter.consume('chat-1', new Date('2026-04-19T08:01:01.000Z'))).toEqual({ action: 'allow' });
  });
});
