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
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
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
      kind: 'routine',
      policyKey: 'defaults:evening-summary',
    });

    const runTime = '2026-04-18T11:00:00.000Z';
    await store.markRun(created.id, runTime);
    await store.markError(created.id, 'channel unavailable');

    const refreshed = await store.get(created.id);
    expect(refreshed).toBeDefined();
    expect(refreshed!.lastRunAt).toBe(runTime);
    expect(refreshed!.lastError).toBe('channel unavailable');
  });

  it('round-trips policy and outcome metadata through disk persistence', async () => {
    const store = new HeartbeatStore(storePath);
    const created = await store.create({
      title: 'Metformin reminder',
      chatId: 'chat-1',
      cron: '0 8,20 * * *',
      prompt: 'Take Metformin.',
      source: 'system',
      kind: 'medication',
      policyKey: 'medications:medications/metformin.md',
    });
    await store.update(created.id, {
      lastOutcome: 'sent',
      lastOutcomeAt: '2026-04-18T06:30:00.000Z',
    });

    const reloaded = new HeartbeatStore(storePath);
    const saved = await reloaded.get(created.id);
    expect(saved).toBeDefined();
    expect(saved!.kind).toBe('medication');
    expect(saved!.policyKey).toBe('medications:medications/metformin.md');
    expect(saved!.lastOutcome).toBe('sent');
    expect(saved!.lastOutcomeAt).toBe('2026-04-18T06:30:00.000Z');
  });

  it('round-trips durable runtime state through disk persistence', async () => {
    const store = new HeartbeatStore(storePath);
    const created = await store.create({
      title: 'Recovery reminder',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'Recover and check in.',
      source: 'system',
      kind: 'recovery',
      maxRetries: 4,
    });

    await store.update(created.id, {
      deliveryState: 'retry-wait',
      acknowledgedAt: '2026-04-19T12:00:00.000Z',
      retryCount: 2,
      maxRetries: 4,
      nextRetryAt: '2026-04-19T12:30:00.000Z',
      snoozedUntil: '2026-04-19T13:00:00.000Z',
      lastAttemptAt: '2026-04-19T11:45:00.000Z',
      lastDeliveredAt: '2026-04-19T11:15:00.000Z',
      deadLetterReason: 'max retries exhausted',
    });

    const reloaded = new HeartbeatStore(storePath);
    const saved = await reloaded.get(created.id);
    expect(saved).toBeDefined();
    expect(saved!.deliveryState).toBe('retry-wait');
    expect(saved!.acknowledgedAt).toBe('2026-04-19T12:00:00.000Z');
    expect(saved!.retryCount).toBe(2);
    expect(saved!.maxRetries).toBe(4);
    expect(saved!.nextRetryAt).toBe('2026-04-19T12:30:00.000Z');
    expect(saved!.snoozedUntil).toBe('2026-04-19T13:00:00.000Z');
    expect(saved!.lastAttemptAt).toBe('2026-04-19T11:45:00.000Z');
    expect(saved!.lastDeliveredAt).toBe('2026-04-19T11:15:00.000Z');
    expect(saved!.deadLetterReason).toBe('max retries exhausted');
  });

  it('normalizes legacy jobs that predate the phase 3c durable fields', async () => {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify([
        {
          id: 'job-legacy',
          title: 'Legacy reminder',
          chatId: 'chat-1',
          cron: '0 8 * * *',
          timezone: 'Asia/Kolkata',
          prompt: 'Legacy prompt.',
          enabled: true,
          source: 'system',
          kind: 'routine',
          createdAt: '2026-04-19T10:00:00.000Z',
          updatedAt: '2026-04-19T10:00:00.000Z',
        },
      ]),
      'utf8',
    );

    const store = new HeartbeatStore(storePath);
    const job = await store.get('job-legacy');

    expect(job).toBeDefined();
    expect(job!.deliveryState).toBe('ready');
    expect(job!.retryCount).toBe(0);
    expect(job!.maxRetries).toBe(0);
  });

  it('rejects duplicate policy keys', async () => {
    const store = new HeartbeatStore(storePath);
    await store.create({
      title: 'Morning check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'First.',
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
    });

    await expect(
      store.create({
        title: 'Duplicate morning check-in',
        chatId: 'chat-1',
        cron: '0 9 * * *',
        prompt: 'Second.',
        source: 'system',
        kind: 'routine',
        policyKey: 'defaults:morning-check-in',
      }),
    ).rejects.toThrow('Duplicate heartbeat policy key');
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
