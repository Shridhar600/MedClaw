import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { SessionManager } from '../../src/gateway/session';
import type { AppConfig } from '../../src/config/types';
import type { HeartbeatJob } from '../../src/scheduler/types';
import { HeartbeatStore } from '../../src/scheduler/store';

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
    expect(content).toContain('Persisted morning check-in');
    expect(content).toContain('0 8 * * *');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).scheduler?.stop();
  });
});
