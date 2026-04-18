import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { SessionManager } from '../../src/gateway/session';
import type { AppConfig } from '../../src/config/types';
import type { HeartbeatJob } from '../../src/scheduler/types';
import { HeartbeatStore } from '../../src/scheduler/store';
import { HeartbeatScheduler } from '../../src/scheduler/runtime';

describe('Gateway heartbeat integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-heartbeat-gateway-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
    return {
      providers: {
        main: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
        medical: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
        embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
      },
      channels: { telegram: { enabled: false, botToken: '' } },
      tools: { allow: ['*'], deny: [] },
      memory: {
        workspace: path.join(tmpDir, 'workspace'),
        search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
        bootstrapMaxChars: 20000,
      },
      sessions: {
        softResetAfterMinutes: 240,
        hardResetAfterMinutes: 1440,
        compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
      },
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        policy: {
          quietHours: { enabled: true, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 60,
          defaults: {
            morningCheckIn: { enabled: true, cron: '0 8 * * *', prompt: 'Morning check-in prompt.' },
            eveningSummary: { enabled: true, cron: '0 21 * * *', prompt: 'Evening summary prompt.' },
          },
        },
      },
      agent: { maxIterations: 15, disclaimerEnabled: true },
      ...overrides,
    };
  }

  it('scheduled jobs run through agent loop, send through channel, and persist session trace', async () => {
    const config = makeConfig();
    const gateway = new Gateway(config);
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'Heartbeat sent',
      trace: [{ role: 'assistant', content: 'Heartbeat sent' }],
      usedTools: [],
      healthResponse: false,
    });
    const sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;

    const job: HeartbeatJob = {
      id: 'job-1',
      title: 'Morning check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'Asia/Kolkata',
      prompt: 'Ask how the user is feeling today.',
      enabled: true,
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleScheduledJob(job);

    expect(send).toHaveBeenCalledWith('chat-1', { text: 'Heartbeat sent' });
    const sessionJsonl = path.join(tmpDir, 'sessions', 'active-chat-1.jsonl');
    const content = fs.readFileSync(sessionJsonl, 'utf8');
    expect(content).toContain('[Heartbeat Trigger]');
    expect(content).toContain('Job id: job-1');
    expect(content).toContain('Heartbeat sent');
  });

  it('scheduler startup is skipped cleanly when heartbeat.enabled is false', async () => {
    const config = makeConfig({
      heartbeat: {
        enabled: false,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        policy: {
          quietHours: { enabled: true, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 60,
          defaults: {
            morningCheckIn: { enabled: true, cron: '0 8 * * *', prompt: 'Morning check-in prompt.' },
            eveningSummary: { enabled: true, cron: '0 21 * * *', prompt: 'Evening summary prompt.' },
          },
        },
      },
    });
    const gateway = new Gateway(config);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).initializeScheduler();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gateway as any).scheduler).toBeUndefined();
  });

  it('re-synchronizes HEARTBEAT.md from persisted jobs on scheduler startup', async () => {
    const config = makeConfig();
    fs.mkdirSync(config.memory.workspace, { recursive: true });
    const store = new HeartbeatStore(config.heartbeat.storePath);
    await store.create({
      title: 'Persisted morning check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'Ask if meds were taken.',
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
    });

    const gateway = new Gateway(config);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).initializeScheduler();

    const heartbeatPath = path.join(config.memory.workspace, 'HEARTBEAT.md');
    const content = fs.readFileSync(heartbeatPath, 'utf8');
    expect(content).toContain('Morning check-in');
    expect(content).toContain('0 8 * * *');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).scheduler?.stop();
  });

  it('does not send a scheduled message when delivery policy suppresses it', async () => {
    const config = makeConfig();
    const gateway = new Gateway(config);
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'Heartbeat sent',
      trace: [{ role: 'assistant', content: 'Heartbeat sent' }],
      usedTools: [],
      healthResponse: false,
    });
    const scheduler = new HeartbeatScheduler(
      new HeartbeatStore(path.join(tmpDir, 'heartbeats', 'jobs.json')),
      async () => undefined,
      'Asia/Kolkata',
    );
    await scheduler.start();
    const job = await scheduler.createJob({
      title: 'Quiet-hour check-in',
      chatId: 'chat-1',
      cron: '0 23 * * *',
      prompt: 'Quiet-hours should suppress this.',
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = {
      prepareHistory: jest.fn().mockResolvedValue([]),
      recordTurn: jest.fn().mockResolvedValue(undefined),
      getLastActiveAt: jest.fn().mockReturnValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).scheduler = scheduler;

    const clock = jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-18T22:30:00+05:30').getTime());
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (gateway as any).handleScheduledJob(job);
    } finally {
      clock.mockRestore();
    }

    expect(run).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const refreshed = await scheduler.getStore().get(job.id);
    expect(refreshed?.lastOutcome).toBe('skipped-quiet-hours');
    await scheduler.stop();
  });

  it('records a scheduled no-op without sending a user-facing message', async () => {
    const config = makeConfig({
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        policy: {
          quietHours: { enabled: false, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 60,
          defaults: {
            morningCheckIn: { enabled: true, cron: '0 8 * * *', prompt: 'Morning check-in prompt.' },
            eveningSummary: { enabled: true, cron: '0 21 * * *', prompt: 'Evening summary prompt.' },
          },
        },
      },
    });
    const gateway = new Gateway(config);
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'HEARTBEAT_NOOP',
      trace: [{ role: 'assistant', content: 'HEARTBEAT_NOOP' }],
      usedTools: [],
      healthResponse: false,
    });
    const sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));
    const scheduler = new HeartbeatScheduler(
      new HeartbeatStore(path.join(tmpDir, 'heartbeats', 'jobs.json')),
      async () => undefined,
      'Asia/Kolkata',
    );
    await scheduler.start();
    const job = await scheduler.createJob({
      title: 'No-op check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'No-op prompt.',
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).scheduler = scheduler;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleScheduledJob(job);

    expect(send).not.toHaveBeenCalled();
    const refreshed = await scheduler.getStore().get(job.id);
    expect(refreshed?.lastOutcome).toBe('noop');
    const sessionJsonl = path.join(tmpDir, 'sessions', 'active-chat-1.jsonl');
    const content = fs.readFileSync(sessionJsonl, 'utf8');
    expect(content).toContain('[Heartbeat Trigger]');
    expect(content).toContain('HEARTBEAT_NOOP');
    await scheduler.stop();
  });

  it('creates policy-managed jobs on startup for the most recent real chat and registers them live', async () => {
    const config = makeConfig();
    fs.mkdirSync(path.join(config.memory.workspace, 'goals'), { recursive: true });
    fs.writeFileSync(
      path.join(config.memory.workspace, 'goals', 'walk.md'),
      '---\nstatus: active\ncron: "0 21 * * *"\nprompt: "Ask about the daily walk."\n---\n# Daily walk\n',
      'utf8',
    );

    const gateway = new Gateway(config);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run: jest.fn().mockResolvedValue({ text: 'ok', trace: [] }) };
    const sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));
    await sessions.recordTurn('chat-1', [{ role: 'user', content: 'Seed startup chat.' }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).initializeScheduler();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduler = (gateway as any).scheduler as HeartbeatScheduler;
    const jobs = await scheduler.listJobs();
    expect(jobs).toEqual(
      expect.arrayContaining([expect.objectContaining({ policyKey: 'goals:goals/walk.md', kind: 'goal', chatId: 'chat-1' })]),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((gateway as any).scheduler as any).tasks.size).toBeGreaterThan(0);

    const heartbeatPath = path.join(config.memory.workspace, 'HEARTBEAT.md');
    const content = fs.readFileSync(heartbeatPath, 'utf8');
    expect(content).toContain('Daily walk');
    expect(content).not.toContain('__startup__');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).scheduler?.stop();
  });

  it('reconciles policy-managed jobs after a scheduled turn updates workspace state', async () => {
    const config = makeConfig({
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        policy: {
          quietHours: { enabled: false, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 60,
          defaults: {
            morningCheckIn: { enabled: true, cron: '0 8 * * *', prompt: 'Morning check-in prompt.' },
            eveningSummary: { enabled: true, cron: '0 21 * * *', prompt: 'Evening summary prompt.' },
          },
        },
      },
    });
    const gateway = new Gateway(config);
    const sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = {
      run: jest.fn().mockImplementation(async () => {
        fs.mkdirSync(path.join(config.memory.workspace, 'medications'), { recursive: true });
        fs.writeFileSync(
          path.join(config.memory.workspace, 'medications', 'metformin.md'),
          '---\nstatus: active\ncron: "0 8,20 * * *"\nprompt: "Remind about Metformin."\n---\n# Metformin\n',
          'utf8',
        );
        return { text: 'Heartbeat sent', trace: [{ role: 'assistant', content: 'Heartbeat sent' }] };
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;
    await sessions.recordTurn('chat-1', [{ role: 'user', content: 'Seed policy chat.' }]);
    const sessionState = sessions.getOrCreateSessionState('chat-1');
    sessionState.lastActiveAt = new Date(Date.now() - (2 * 60 * 60 * 1000));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).initializeScheduler();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scheduledJob: HeartbeatJob = await (gateway as any).scheduler.createJob({
      title: 'Scheduled trigger',
      chatId: 'chat-1',
      cron: '0 9 * * *',
      timezone: 'Asia/Kolkata',
      prompt: 'Run and reconcile.',
      source: 'agent',
      kind: 'routine',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleScheduledJob(scheduledJob);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobs = await (gateway as any).scheduler.listJobs();
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ policyKey: 'medications:medications/metformin.md', kind: 'medication' }),
      ]),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).scheduler?.stop();
  });

  it('does not persist a false assistant turn when scheduled delivery fails', async () => {
    const config = makeConfig({
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        policy: {
          quietHours: { enabled: false, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 60,
          defaults: {
            morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'unused' },
            eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'unused' },
          },
        },
      },
    });
    const gateway = new Gateway(config);
    const sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));
    const scheduler = new HeartbeatScheduler(
      new HeartbeatStore(path.join(tmpDir, 'heartbeats', 'jobs.json')),
      async () => undefined,
      'Asia/Kolkata',
    );
    await scheduler.start();
    const job = await scheduler.createJob({
      title: 'Send-failure check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'This send should fail.',
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockRejectedValue(new Error('send failed')) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = {
      run: jest.fn().mockResolvedValue({
        text: 'Heartbeat sent',
        trace: [{ role: 'assistant', content: 'Heartbeat sent' }],
        usedTools: [],
        healthResponse: false,
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).scheduler = scheduler;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleScheduledJob(job)).rejects.toThrow('send failed');

    const sessionJsonl = path.join(tmpDir, 'sessions', 'active-chat-1.jsonl');
    expect(fs.existsSync(sessionJsonl)).toBe(false);
    const refreshed = await scheduler.getStore().get(job.id);
    expect(refreshed?.lastOutcome).toBe('error');
    await scheduler.stop();
  });

  it('renders job kind, source, and last outcome into HEARTBEAT.md', async () => {
    const config = makeConfig();
    fs.mkdirSync(config.memory.workspace, { recursive: true });
    const store = new HeartbeatStore(config.heartbeat.storePath);
    const created = await store.create({
      title: 'Medication reminder',
      chatId: 'chat-1',
      cron: '0 8,20 * * *',
      prompt: 'Take medication.',
      source: 'user',
      kind: 'medication',
      policyKey: 'medications:medications/metformin.md',
    });
    await store.update(created.id, {
      lastOutcome: 'sent',
      lastOutcomeAt: '2026-04-18T06:30:00.000Z',
    });

    const gateway = new Gateway(config);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run: jest.fn().mockResolvedValue({ text: 'ok', trace: [] }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).initializeScheduler();

    const heartbeatPath = path.join(config.memory.workspace, 'HEARTBEAT.md');
    const content = fs.readFileSync(heartbeatPath, 'utf8');
    expect(content).toContain('kind: medication');
    expect(content).toContain('source: system');
    expect(content).toContain('policyKey: medications:medications/metformin.md');
    expect(content).toContain('lastOutcome: sent');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).scheduler?.stop();
  });
});
