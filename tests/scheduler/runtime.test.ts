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
      }),
    ).rejects.toThrow('Invalid cron');
  });
});
