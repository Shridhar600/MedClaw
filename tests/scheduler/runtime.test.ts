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

  it('a failing trigger persists a sanitized lastError (never the raw error message)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = new HeartbeatStore(storePath);
      const job = await store.create({
        title: 'Failing check-in',
        chatId: 'chat-1',
        cron: '* * * * *',
        prompt: 'Ask how the user is feeling.',
        source: 'system',
        kind: 'routine',
        policyKey: 'defaults:morning-check-in',
      });
      // Provider/agent error messages can echo user health content (PHI).
      const trigger = jest.fn().mockRejectedValue(new Error('glucose 300 spiking, chest pain reported'));
      const scheduler = new HeartbeatScheduler(store, trigger);

      await scheduler.start();
      await scheduler.runNow(job.id);

      const refreshed = await store.get(job.id);
      expect(refreshed?.lastError).toBeTruthy();
      expect(refreshed?.lastError).not.toContain('glucose');
      expect(refreshed?.lastError).not.toContain('chest pain');
      expect(refreshed?.lastError).toContain('Error');

      const logged = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(logged).not.toContain('glucose');
      await scheduler.stop();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('a storage failure while recording a trigger failure does not escape executeJob', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const store = new HeartbeatStore(storePath);
      const job = await store.create({
        title: 'Failing check-in',
        chatId: 'chat-1',
        cron: '* * * * *',
        prompt: 'Ask how the user is feeling.',
        source: 'system',
        kind: 'routine',
        policyKey: 'defaults:morning-check-in',
      });
      const trigger = jest.fn().mockRejectedValue(new Error('send failed'));
      const scheduler = new HeartbeatScheduler(store, trigger);
      await scheduler.start();

      // recordFailure's store.update now fails too — executeJob is invoked
      // fire-and-forget from cron ticks, so nothing may escape it.
      jest.spyOn(store, 'update').mockRejectedValue(new Error('disk full'));

      await expect(scheduler.runNow(job.id)).resolves.toBeUndefined();
      await scheduler.stop();
    } finally {
      errorSpy.mockRestore();
    }
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
    const job = await store.create({
      title: 'Recoverable job',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'UTC',
      prompt: 'Recover this run.',
      source: 'system',
      kind: 'routine',
    });
    const rawJobs = JSON.parse(fs.readFileSync(storePath, 'utf8')) as Array<Record<string, unknown>>;
    const jobIndex = rawJobs.findIndex((stored) => stored.id === job.id);
    rawJobs[jobIndex] = {
      ...rawJobs[jobIndex],
      createdAt: '2026-04-19T07:30:00.000Z',
      updatedAt: '2026-04-19T07:30:00.000Z',
    };
    fs.writeFileSync(storePath, `${JSON.stringify(rawJobs, null, 2)}\n`, 'utf8');
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
    jest.setSystemTime(new Date('2026-04-19T08:00:00.000Z'));
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
          now: () => new Date(Date.now()),
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
    jest.setSystemTime(new Date('2026-04-19T08:00:00.000Z'));
    try {
      const store = new HeartbeatStore(storePath);
      const trigger = jest.fn().mockResolvedValue(undefined);
      const scheduler = new HeartbeatScheduler(store, trigger, 'UTC', {
        now: () => new Date(Date.now()),
      });
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
    jest.setSystemTime(new Date('2026-04-19T08:00:00.000Z'));
    try {
      const store = new HeartbeatStore(storePath);
      const trigger = jest.fn().mockResolvedValue(undefined);
      const scheduler = new HeartbeatScheduler(store, trigger, 'UTC', {
        maxGlobalTriggersPerMinute: 1,
        now: () => new Date(Date.now()),
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

      await jest.advanceTimersByTimeAsync(60 * 1000);

      expect(trigger).toHaveBeenCalledTimes(2);
      expect((await store.get(second.id))?.deliveryState).toBe('ready');
      await scheduler.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  // ── CORR-M1: executeJob overlap guard ────────────────────────────────
  it('overlapping executeJob calls for the same job run the trigger ONCE; markRun runs ONCE; state stays coherent', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const store = new HeartbeatStore(storePath);
      const job = await store.create({
        title: 'Slow overlap job',
        chatId: 'chat-1',
        cron: '* * * * *',
        prompt: 'Slow.',
        source: 'system',
        kind: 'routine',
        policyKey: 'defaults:overlap',
      });

      let releaseTrigger!: () => void;
      const triggerGate = new Promise<void>((resolve) => {
        releaseTrigger = resolve;
      });

      const trigger = jest.fn().mockImplementation(async () => {
        // Block every invocation so a second executeJob overlaps it. With the
        // guard, only the first call enters; without it, both enter and we
        // see trigger called twice.
        await triggerGate;
      });

      // Wrap markRun to count calls while delegating to the real implementation.
      const markRunSpy = jest.spyOn(store, 'markRun');

      const scheduler = new HeartbeatScheduler(store, trigger, 'UTC');
      await scheduler.start();

      // Fire two overlapping executeJob calls (mirrors two cron ticks landing
      // before a slow LLM call settles). runNow → executeJob both times.
      const p1 = scheduler.runNow(job.id);
      // Let the first executeJob enter the trigger (await triggerGate).
      await Promise.resolve();
      await Promise.resolve();
      const p2 = scheduler.runNow(job.id);

      // Release the trigger gate and let both runNow calls settle.
      releaseTrigger();
      await p1;
      await p2;

      // The trigger ran exactly once (the second tick was skipped).
      expect(trigger).toHaveBeenCalledTimes(1);
      // markRun ran exactly once (no double-delivery state churn).
      expect(markRunSpy).toHaveBeenCalledTimes(1);

      // Final store state is coherent: enabled, ready, lastRunAt set.
      const refreshed = await store.get(job.id);
      expect(refreshed?.enabled).toBe(true);
      expect(refreshed?.deliveryState).toBe('ready');
      expect(refreshed?.lastRunAt).toBeTruthy();

      await scheduler.stop();
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
