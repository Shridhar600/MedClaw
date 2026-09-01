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
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
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
    const config = makeConfig({
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
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
      deliveryState: 'ready',
      retryCount: 0,
      maxRetries: config.heartbeat.retry.maxRetries,
      policyKey: 'defaults:morning-check-in',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleScheduledJob(job);

    expect(send).toHaveBeenCalledWith('chat-1', { text: 'Heartbeat sent' });
    const sessionJsonl = path.join(tmpDir, 'sessions', new Date().toISOString().slice(0, 10) + '.jsonl');
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
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
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
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
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
    const sessionJsonl = path.join(tmpDir, 'sessions', new Date().toISOString().slice(0, 10) + '.jsonl');
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
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
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

  it('persists the attempted heartbeat before scheduled delivery fails', async () => {
    const config = makeConfig({
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
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
      {
        defaultMaxRetries: config.heartbeat.retry.maxRetries,
        retryBackoffMinutes: config.heartbeat.retry.backoffMinutes,
        auditLogPath: config.heartbeat.audit.path,
      },
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

    const sessionJsonl = path.join(tmpDir, 'sessions', new Date().toISOString().slice(0, 10) + '.jsonl');
    expect(fs.existsSync(sessionJsonl)).toBe(true);
    expect(fs.readFileSync(sessionJsonl, 'utf8')).toContain('Heartbeat sent');
    const refreshed = await scheduler.getStore().get(job.id);
    expect(refreshed?.lastOutcome).toBe('error');
    await scheduler.stop();
  });

  it('moves a failed scheduled delivery into retry-wait and records audit events', async () => {
    const config = makeConfig({
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 2, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
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
      {
        defaultMaxRetries: config.heartbeat.retry.maxRetries,
        retryBackoffMinutes: config.heartbeat.retry.backoffMinutes,
        auditLogPath: config.heartbeat.audit.path,
      },
    );
    await scheduler.start();
    const job = await scheduler.createJob({
      title: 'Retryable send-failure check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'This send should fail once.',
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

    const refreshed = await scheduler.getStore().get(job.id);
    expect(refreshed?.deliveryState).toBe('retry-wait');
    expect(refreshed?.retryCount).toBe(1);
    expect(refreshed?.nextRetryAt).toBeDefined();

    const auditRaw = fs.readFileSync(config.heartbeat.audit.path, 'utf8');
    expect(auditRaw).toContain('"type":"send_failed"');
    expect(auditRaw).toContain('"type":"retry_scheduled"');
    await scheduler.stop();
  });

  it('scheduler-owned delivery failures enter retry flow', async () => {
    const config = makeConfig({
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 2, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
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
      async (job) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (gateway as any).handleScheduledJob(job, true);
      },
      'Asia/Kolkata',
      {
        defaultMaxRetries: config.heartbeat.retry.maxRetries,
        retryBackoffMinutes: config.heartbeat.retry.backoffMinutes,
        auditLogPath: config.heartbeat.audit.path,
      },
    );
    await scheduler.start();
    const job = await scheduler.createJob({
      title: 'Scheduler-owned failure',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'This send should fail through scheduler.',
      source: 'system',
      kind: 'routine',
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

    await scheduler.runNow(job.id);

    const refreshed = await scheduler.getStore().get(job.id);
    expect(refreshed?.deliveryState).toBe('retry-wait');
    expect(refreshed?.retryCount).toBe(1);
    const auditRaw = fs.readFileSync(config.heartbeat.audit.path, 'utf8');
    expect(auditRaw).toContain('"type":"send_failed"');
    expect(auditRaw).toContain('"type":"retry_scheduled"');
    await scheduler.stop();
  });

  it('dead-letters a job after repeated scheduled delivery failures', async () => {
    const config = makeConfig({
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 1, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
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
      {
        defaultMaxRetries: config.heartbeat.retry.maxRetries,
        retryBackoffMinutes: config.heartbeat.retry.backoffMinutes,
        auditLogPath: config.heartbeat.audit.path,
      },
    );
    await scheduler.start();
    const job = await scheduler.createJob({
      title: 'Dead-letter send-failure check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'This send should fail twice.',
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
    const retryJob = await scheduler.getStore().get(job.id);
    expect(retryJob?.deliveryState).toBe('retry-wait');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleScheduledJob(retryJob!)).rejects.toThrow('send failed');

    const refreshed = await scheduler.getStore().get(job.id);
    expect(refreshed?.deliveryState).toBe('dead-letter');
    // lastError/deadLetterReason are persisted to disk and must be PHI-safe:
    // summarizeErrorForLog keeps the error name but strips the message body.
    expect(refreshed?.deadLetterReason).toContain('Error');
    expect(refreshed?.deadLetterReason).not.toContain('send failed');

    const auditRaw = fs.readFileSync(config.heartbeat.audit.path, 'utf8');
    expect(auditRaw).toContain('"type":"dead_lettered"');
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
      deliveryState: 'retry-wait',
      retryCount: 2,
      maxRetries: 3,
      nextRetryAt: '2026-04-19T09:00:00.000Z',
      lastOutcome: 'sent',
      lastOutcomeAt: '2026-04-18T06:30:00.000Z',
    });
    await store.create({
      title: 'Escalated reminder',
      chatId: 'chat-1',
      cron: '0 9 * * *',
      timezone: 'UTC',
      prompt: 'Follow up again later.',
      source: 'system',
      kind: 'routine',
      maxRetries: 2,
    });
    const escalated = await store.list();
    const deadLetterJob = escalated.find((job) => job.title === 'Escalated reminder');
    await store.update(deadLetterJob!.id, {
      deliveryState: 'dead-letter',
      retryCount: 3,
      maxRetries: 2,
      deadLetterReason: 'retry budget exhausted',
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
    expect(content).toContain('deliveryState: retry-wait');
    expect(content).toContain('retryCount: 2/3');
    expect(content).toContain('nextRetryAt: 2026-04-19T09:00:00.000Z');
    expect(content).toContain('deliveryState: dead-letter');
    expect(content).toContain('deadLetterReason: retry budget exhausted');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).scheduler?.stop();
  });

  it('recovers one missed run on scheduler startup and audits it distinctly', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-19T08:30:00.000Z'));

    try {
      const config = makeConfig({
        heartbeat: {
          enabled: true,
          timezone: 'UTC',
          storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
          recovery: { enabled: true, windowMinutes: 60 },
          retry: { maxRetries: 2, backoffMinutes: 5 },
          rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
          audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
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
      const store = new HeartbeatStore(config.heartbeat.storePath);
      jest.setSystemTime(new Date('2026-04-19T07:00:00.000Z'));
      await store.create({
        title: 'Recovered morning check-in',
        chatId: 'chat-1',
        cron: '0 8 * * *',
        timezone: 'UTC',
        prompt: 'Recover missed run.',
        source: 'system',
        kind: 'routine',
      });
      jest.setSystemTime(new Date('2026-04-19T08:30:00.000Z'));

      const gateway = new Gateway(config);
      const send = jest.fn().mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).channel = { send };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).agentLoop = {
        run: jest.fn().mockResolvedValue({
          text: 'Recovered heartbeat sent',
          trace: [{ role: 'assistant', content: 'Recovered heartbeat sent' }],
          usedTools: [],
          healthResponse: false,
        }),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (gateway as any).initializeScheduler();

      expect(send).toHaveBeenCalledWith('chat-1', { text: 'Recovered heartbeat sent' });
      const auditRaw = fs.readFileSync(config.heartbeat.audit.path, 'utf8');
      expect(auditRaw).toContain('"type":"recovered_missed_run"');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (gateway as any).scheduler?.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it('defers scheduled execution when the rate limit is hit and records an audit event', async () => {
    const config = makeConfig({
      heartbeat: {
        enabled: true,
        timezone: 'UTC',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 2, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 1, maxPerChatTriggersPerMinute: 1 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
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
    const send = jest.fn().mockResolvedValue(undefined);
    const sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));
    const scheduler = new HeartbeatScheduler(
      new HeartbeatStore(path.join(tmpDir, 'heartbeats', 'jobs.json')),
      async (job) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (gateway as any).handleScheduledJob(job, true);
      },
      'UTC',
      {
        auditLogPath: config.heartbeat.audit.path,
        defaultMaxRetries: config.heartbeat.retry.maxRetries,
        recoveryEnabled: false,
        recoveryWindowMinutes: config.heartbeat.recovery.windowMinutes,
        retryBackoffMinutes: config.heartbeat.retry.backoffMinutes,
        maxGlobalTriggersPerMinute: config.heartbeat.rateLimit.maxGlobalTriggersPerMinute,
        maxPerChatTriggersPerMinute: config.heartbeat.rateLimit.maxPerChatTriggersPerMinute,
      },
    );
    await scheduler.start();
    const firstJob = await scheduler.createJob({
      title: 'First allowed job',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'UTC',
      prompt: 'First prompt.',
      source: 'system',
      kind: 'routine',
    });
    const secondJob = await scheduler.createJob({
      title: 'Deferred job',
      chatId: 'chat-1',
      cron: '5 8 * * *',
      timezone: 'UTC',
      prompt: 'Second prompt.',
      source: 'system',
      kind: 'routine',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
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

    await scheduler.runNow(firstJob.id);
    await scheduler.runNow(secondJob.id);

    expect(send).toHaveBeenCalledTimes(1);
    const deferred = await scheduler.getStore().get(secondJob.id);
    expect(deferred?.deliveryState).toBe('retry-wait');
    expect(deferred?.nextRetryAt).toBeDefined();

    const auditRaw = fs.readFileSync(config.heartbeat.audit.path, 'utf8');
    expect(auditRaw).toContain('"type":"rate_limited"');
    await scheduler.stop();
  });
});
