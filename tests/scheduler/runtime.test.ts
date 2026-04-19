import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeartbeatStore } from '../../src/scheduler/store';
import { HeartbeatScheduler } from '../../src/scheduler/runtime';

describe('HeartbeatScheduler', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-heartbeat-runtime-'));
    storePath = path.join(tmpDir, 'heartbeats', 'jobs.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers enabled jobs on start and triggers them through the callback', async () => {
    const store = new HeartbeatStore(storePath);
    const job = await store.create({
      title: 'Morning check-in',
      chatId: 'chat-1',
      cron: '* * * * *',
      prompt: 'Ask how the user is feeling.',
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
    });
    const trigger = jest.fn().mockResolvedValue(undefined);
    const scheduler = new HeartbeatScheduler(store, trigger);

    await scheduler.start();
    await scheduler.runNow(job.id);

    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    await scheduler.stop();
  });

  it('pause prevents runNow from executing the callback', async () => {
    const store = new HeartbeatStore(storePath);
    const job = await store.create({
      title: 'Evening check-in',
      chatId: 'chat-1',
      cron: '* * * * *',
      prompt: 'Ask for end-of-day summary.',
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:evening-summary',
    });
    const trigger = jest.fn().mockResolvedValue(undefined);
    const scheduler = new HeartbeatScheduler(store, trigger);
    await scheduler.start();

    await scheduler.pause(job.id);
    await scheduler.runNow(job.id);

    expect(trigger).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it('rejects invalid cron expressions', async () => {
    const store = new HeartbeatStore(storePath);
    const trigger = jest.fn().mockResolvedValue(undefined);
    const scheduler = new HeartbeatScheduler(store, trigger);

    await expect(
      scheduler.createJob({
        title: 'Bad cron',
        chatId: 'chat-1',
        cron: 'not-a-cron',
        prompt: 'Should fail.',
        source: 'user',
        kind: 'routine',
      }),
    ).rejects.toThrow('Invalid cron');
  });

  it('disables invalid persisted jobs instead of crashing startup', async () => {
    const store = new HeartbeatStore(storePath);
    await store.create({
      title: 'Invalid persisted job',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'Should be disabled on startup.',
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:invalid',
    });
    const persisted = await store.findByPolicyKey('defaults:invalid');
    expect(persisted).toBeDefined();
    await store.update(persisted!.id, { cron: 'not-a-cron' });

    const trigger = jest.fn().mockResolvedValue(undefined);
    const scheduler = new HeartbeatScheduler(store, trigger);

    await expect(scheduler.start()).resolves.toBeUndefined();

    const refreshed = await store.get(persisted!.id);
    expect(refreshed?.enabled).toBe(false);
    expect(refreshed?.lastOutcome).toBe('error');
    await scheduler.stop();
  });

  it('recovers one missed run on startup when recovery is enabled', async () => {
    const store = new HeartbeatStore(storePath);
    await store.create({
      title: 'Recoverable job',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'UTC',
      prompt: 'Recover this run.',
      source: 'system',
      kind: 'routine',
    });
    const trigger = jest.fn().mockResolvedValue(undefined);
    const scheduler = new HeartbeatScheduler(store, trigger, 'UTC', {
      recoveryEnabled: true,
      recoveryWindowMinutes: 60,
      now: () => new Date('2026-04-19T08:30:00.000Z'),
    });

    await scheduler.start();

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ title: 'Recoverable job' }));
    await scheduler.stop();
  });

  it('automatically wakes retry-wait jobs when nextRetryAt is due', async () => {
    jest.useFakeTimers();
    let now = new Date('2026-04-19T08:00:00.000Z');
    try {
      const store = new HeartbeatStore(storePath);
      let attempts = 0;
      const scheduler = new HeartbeatScheduler(
        store,
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('transient send failure');
          }
        },
        'UTC',
        {
          defaultMaxRetries: 1,
          retryBackoffMinutes: 5,
          now: () => now,
        },
      );
      await scheduler.start();
      const job = await scheduler.createJob({
        title: 'Retry wakeup',
        chatId: 'chat-1',
        cron: '0 8 * * *',
        timezone: 'UTC',
        prompt: 'Retry after transient failure.',
        source: 'system',
        kind: 'routine',
      });

      await scheduler.runNow(job.id);
      expect((await store.get(job.id))?.deliveryState).toBe('retry-wait');

      now = new Date('2026-04-19T08:05:00.000Z');
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(attempts).toBe(2);
      const refreshed = await store.get(job.id);
      expect(refreshed?.deliveryState).toBe('ready');
      await scheduler.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('automatically wakes snoozed jobs when snoozedUntil is due', async () => {
    jest.useFakeTimers();
    let now = new Date('2026-04-19T08:00:00.000Z');
    try {
      const store = new HeartbeatStore(storePath);
      const trigger = jest.fn().mockResolvedValue(undefined);
      const scheduler = new HeartbeatScheduler(store, trigger, 'UTC', { now: () => now });
      await scheduler.start();
      const job = await scheduler.createJob({
        title: 'Snooze wakeup',
        chatId: 'chat-1',
        cron: '0 8 * * *',
        timezone: 'UTC',
        prompt: 'Wake after snooze.',
        source: 'system',
        kind: 'routine',
      });

      await scheduler.updateJob(job.id, {
        deliveryState: 'snoozed',
        snoozedUntil: '2026-04-19T08:10:00.000Z',
      });

      now = new Date('2026-04-19T08:10:00.000Z');
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);

      expect(trigger).toHaveBeenCalledTimes(1);
      expect((await store.get(job.id))?.deliveryState).toBe('ready');
      await scheduler.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('automatically wakes rate-limited jobs when deferredUntil is due', async () => {
    jest.useFakeTimers();
    let now = new Date('2026-04-19T08:00:00.000Z');
    try {
      const store = new HeartbeatStore(storePath);
      const trigger = jest.fn().mockResolvedValue(undefined);
      const scheduler = new HeartbeatScheduler(store, trigger, 'UTC', {
        maxGlobalTriggersPerMinute: 1,
        now: () => now,
      });
      await scheduler.start();
      const first = await scheduler.createJob({
        title: 'First job',
        chatId: 'chat-1',
        cron: '0 8 * * *',
        timezone: 'UTC',
        prompt: 'Allowed.',
        source: 'system',
        kind: 'routine',
      });
      const second = await scheduler.createJob({
        title: 'Second job',
        chatId: 'chat-2',
        cron: '0 8 * * *',
        timezone: 'UTC',
        prompt: 'Deferred.',
        source: 'system',
        kind: 'routine',
      });

      await scheduler.runNow(first.id);
      await scheduler.runNow(second.id);
      expect((await store.get(second.id))?.deliveryState).toBe('retry-wait');

      now = new Date('2026-04-19T08:01:00.000Z');
      await jest.advanceTimersByTimeAsync(60 * 1000);

      expect(trigger).toHaveBeenCalledTimes(2);
      expect((await store.get(second.id))?.deliveryState).toBe('ready');
      await scheduler.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
