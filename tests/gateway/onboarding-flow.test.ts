import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import type { AppConfig } from '../../src/config/types';

describe('Gateway onboarding integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-gateway-onboarding-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(): AppConfig {
    return {
      providers: {
        main: { type: 'ollama', model: 'kimi-k2.5:cloud', baseUrl: 'http://localhost:11434/v1' },
        medical: { type: 'ollama', model: 'medgemma', baseUrl: 'http://localhost:11434/v1' },
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
            morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
            eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
          },
        },
      },
      agent: { maxIterations: 15, disclaimerEnabled: true },
    };
  }

  it('routes first test chat through onboarding before the agent loop', async () => {
    const config = makeConfig();
    fs.mkdirSync(config.memory.workspace, { recursive: true });
    fs.writeFileSync(path.join(config.memory.workspace, 'USER.md'), '# User Preferences\n', 'utf8');
    fs.writeFileSync(path.join(config.memory.workspace, 'HEALTH_PROFILE.md'), '# Health Profile\n', 'utf8');
    const gateway = new Gateway(config);
    const run = jest.fn().mockResolvedValue({ text: 'normal agent', trace: [{ role: 'assistant', content: 'normal agent' }] });
    const recordTurn = jest.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = { prepareHistory: jest.fn().mockResolvedValue([]), recordTurn };

    const response = await gateway.handleTestMessage('chat-1', 'hello');

    expect(response).toContain('Before we start');
    expect(run).not.toHaveBeenCalled();
    expect(recordTurn).toHaveBeenCalled();
  });

  it('uses normal agent loop after onboarding is confirmed', async () => {
    const config = makeConfig();
    fs.mkdirSync(config.memory.workspace, { recursive: true });
    fs.writeFileSync(path.join(config.memory.workspace, 'USER.md'), '# User Preferences\n', 'utf8');
    fs.writeFileSync(path.join(config.memory.workspace, 'HEALTH_PROFILE.md'), '# Health Profile\n', 'utf8');
    const gateway = new Gateway(config);
    const run = jest.fn().mockResolvedValue({ text: 'normal agent', trace: [{ role: 'assistant', content: 'normal agent' }] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = {
      prepareHistory: jest.fn().mockResolvedValue([]),
      recordTurn: jest.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).reconcileHeartbeatPolicies = jest.fn().mockResolvedValue(undefined);

    for (const input of [
      'hello',
      'Arjun',
      '31',
      'Asia/Kolkata',
      'Type 2 diabetes',
      'Metformin',
      'Penicillin',
      'Improve glucose control',
      'Morning reminders',
      'confirm',
    ]) {
      await gateway.handleTestMessage('chat-1', input);
    }
    const response = await gateway.handleTestMessage('chat-1', 'Can I eat daal chawal?');

    expect(response).toBe('normal agent');
    expect(run).toHaveBeenCalledWith('Can I eat daal chawal?', [], { chatId: 'chat-1' });
  });

  it('bypasses onboarding for urgent health messages without calling the agent loop', async () => {
    const config = makeConfig();
    fs.mkdirSync(config.memory.workspace, { recursive: true });
    fs.writeFileSync(path.join(config.memory.workspace, 'USER.md'), '# User Preferences\n', 'utf8');
    fs.writeFileSync(path.join(config.memory.workspace, 'HEALTH_PROFILE.md'), '# Health Profile\n', 'utf8');
    const gateway = new Gateway(config);
    const run = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = { prepareHistory: jest.fn().mockResolvedValue([]), recordTurn: jest.fn().mockResolvedValue(undefined) };

    const response = await gateway.handleTestMessage('chat-1', 'I have chest pain and cannot breathe');

    expect(response).toContain('emergency');
    expect(run).not.toHaveBeenCalled();
  });

  it('recovers corrupt onboarding state and still returns the onboarding prompt', async () => {
    const config = makeConfig();
    fs.mkdirSync(path.join(config.memory.workspace, '.redacted'), { recursive: true });
    fs.writeFileSync(path.join(config.memory.workspace, 'USER.md'), '# User Preferences\n', 'utf8');
    fs.writeFileSync(path.join(config.memory.workspace, 'HEALTH_PROFILE.md'), '# Health Profile\n', 'utf8');
    fs.writeFileSync(path.join(config.memory.workspace, '.redacted', 'onboarding.json'), '{bad-json', 'utf8');
    const gateway = new Gateway(config);
    const run = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = { prepareHistory: jest.fn().mockResolvedValue([]), recordTurn: jest.fn().mockResolvedValue(undefined) };

    const response = await gateway.handleTestMessage('chat-1', 'hello');

    expect(response).toContain('Before we start');
    expect(run).not.toHaveBeenCalled();
    expect(
      fs.readdirSync(path.join(config.memory.workspace, '.redacted')).some((name) =>
        name.startsWith('onboarding.json.corrupt-'),
      ),
    ).toBe(true);
  });

  it('does not append Telegram metadata to onboarding answers', async () => {
    const config = makeConfig();
    fs.mkdirSync(config.memory.workspace, { recursive: true });
    fs.writeFileSync(path.join(config.memory.workspace, 'USER.md'), '# User Preferences\n', 'utf8');
    fs.writeFileSync(path.join(config.memory.workspace, 'HEALTH_PROFILE.md'), '# Health Profile\n', 'utf8');
    const gateway = new Gateway(config);
    const sent: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run: jest.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = { prepareHistory: jest.fn().mockResolvedValue([]), recordTurn: jest.fn().mockResolvedValue(undefined) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn(async (_chatId: string, message: { text: string }) => sent.push(message.text)) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({ chatId: 'chat-1', text: 'hello', userId: 'user-1' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({ chatId: 'chat-1', text: 'Arjun', userId: 'user-1' });

    const state = JSON.parse(
      fs.readFileSync(path.join(config.memory.workspace, '.redacted', 'onboarding.json'), 'utf8'),
    );
    expect(state.answers.name).toBe('Arjun');
    expect(state.answers.name).not.toContain('User id');
    expect(sent[0]).toContain('Before we start');
  });

  it('routes a first media message through onboarding before the agent loop', async () => {
    const config = makeConfig();
    fs.mkdirSync(config.memory.workspace, { recursive: true });
    fs.writeFileSync(path.join(config.memory.workspace, 'USER.md'), '# User Preferences\n', 'utf8');
    fs.writeFileSync(path.join(config.memory.workspace, 'HEALTH_PROFILE.md'), '# Health Profile\n', 'utf8');
    const gateway = new Gateway(config);
    const run = jest.fn();
    const sent: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = { prepareHistory: jest.fn().mockResolvedValue([]), recordTurn: jest.fn().mockResolvedValue(undefined) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn(async (_chatId: string, message: { text: string }) => sent.push(message.text)) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      chatId: 'chat-1',
      text: '',
      mediaPath: 'reports/scan.png',
      userId: 'user-1',
    });

    expect(run).not.toHaveBeenCalled();
    expect(sent[0]).toContain('Before we start');
  });
});
