import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeartbeatStore } from '../../src/scheduler/store';

describe('HeartbeatStore', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-heartbeat-store-'));
    storePath = path.join(tmpDir, 'heartbeats', 'jobs.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists jobs to disk and reloads them', async () => {
    const store = new HeartbeatStore(storePath);
    const created = await store.create({
      title: 'Morning check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'Ask how the user is feeling today.',
      source: 'system',
    });

    const store2 = new HeartbeatStore(storePath);
    const jobs = await store2.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(created.id);
    expect(jobs[0].title).toBe('Morning check-in');
  });

  it('updates lastRunAt and lastError independently', async () => {
    const store = new HeartbeatStore(storePath);
    const created = await store.create({
      title: 'Evening check-in',
      chatId: 'chat-1',
      cron: '0 21 * * *',
      prompt: 'Ask for end-of-day summary.',
      source: 'system',
    });

    const runTime = '2026-04-18T11:00:00.000Z';
    await store.markRun(created.id, runTime);
    await store.markError(created.id, 'channel unavailable');

    const refreshed = await store.get(created.id);
    expect(refreshed).toBeDefined();
    expect(refreshed!.lastRunAt).toBe(runTime);
    expect(refreshed!.lastError).toBe('channel unavailable');
  });

  it('quarantines malformed jobs file and degrades to empty store', async () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '{ "broken": ', 'utf8');

    const store = new HeartbeatStore(storePath);
    await expect(store.list()).resolves.toEqual([]);

    const files = fs.readdirSync(path.dirname(storePath));
    expect(files.some((name) => name.startsWith('jobs.json.corrupt-'))).toBe(true);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it('degrades to empty store even when corrupt-file quarantine fails', async () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, '{ "broken": ', 'utf8');

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const store = new HeartbeatStore(storePath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (store as any).quarantineCorruptFile = () => {
        throw new Error('rename blocked');
      };
      await expect(store.list()).resolves.toEqual([]);
      expect(fs.existsSync(storePath)).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
