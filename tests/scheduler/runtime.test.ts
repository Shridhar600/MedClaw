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
});
