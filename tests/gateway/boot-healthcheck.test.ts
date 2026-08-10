import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppConfig } from '../../src/config/types';
import type { ReadinessResult } from '../../src/providers/healthcheck';

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

const mockCheckSystemReadiness = jest.fn();
const mockProbeChatCompletion = jest.fn();
jest.mock('../../src/providers/healthcheck', () => ({
  checkSystemReadiness: (...args: unknown[]) => mockCheckSystemReadiness(...args),
  probeChatCompletion: (...args: unknown[]) => mockProbeChatCompletion(...args),
}));

const mockCheckProviderBindAddresses = jest.fn();
jest.mock('../../src/security/bind-check', () => ({
  checkProviderBindAddresses: (...args: unknown[]) => mockCheckProviderBindAddresses(...args),
}));

const mockVerifyWorkspacePermissions = jest.fn();
jest.mock('../../src/security/perms-check', () => ({
  verifyWorkspacePermissions: (...args: unknown[]) => mockVerifyWorkspacePermissions(...args),
}));

jest.mock('../../src/onboarding/flow', () => ({
  OnboardingFlow: jest.fn().mockImplementation(() => ({
    isComplete: jest.fn().mockResolvedValue(true),
    handle: jest.fn().mockResolvedValue({ response: null }),
  })),
}));

import { Gateway } from '../../src/gateway/gateway';

function allReadyResult(): { providers: ReadinessResult[]; telegram: ReadinessResult } {
  return {
    providers: [
      { ready: true, checked: true, label: 'main provider', status: 'ok', details: ['model installed: test'], warnings: [] },
      { ready: true, checked: true, label: 'medical provider', status: 'ok', details: ['model installed: test'], warnings: [] },
      { ready: true, checked: true, label: 'embeddings provider', status: 'ok', details: ['model installed: test'], warnings: [] },
    ],
    telegram: { ready: true, checked: false, label: 'telegram', status: 'ok', details: ['disabled'], warnings: [] },
  };
}

function degradedResult(): { providers: ReadinessResult[]; telegram: ReadinessResult } {
  return {
    providers: [
      { ready: false, checked: true, label: 'main provider', status: 'fail', details: ['Ollama is not reachable'], warnings: [], reasonCode: 'unreachable', actionHint: 'Run `ollama serve` and retry.' },
      { ready: true, checked: true, label: 'medical provider', status: 'ok', details: ['model installed: test'], warnings: [] },
      { ready: true, checked: true, label: 'embeddings provider', status: 'ok', details: ['model installed: test'], warnings: [] },
    ],
    telegram: { ready: true, checked: false, label: 'telegram', status: 'ok', details: ['disabled'], warnings: [] },
  };
}

describe('Gateway boot healthchecks + /status + security wiring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-boot-health-'));
    mockCheckSystemReadiness.mockReset();
    mockCheckProviderBindAddresses.mockReset();
    mockVerifyWorkspacePermissions.mockReset();
    mockCheckProviderBindAddresses.mockReturnValue({ localhostOnly: true, warnings: [] });
    mockVerifyWorkspacePermissions.mockReturnValue({ secure: true, warnings: [] });
    mockProbeChatCompletion.mockReset();
    // Default: the live completion probe passes (isolates the config-check tests
    // from the probe). Individual tests override it.
    mockProbeChatCompletion.mockResolvedValue({
      ready: true, checked: true, label: 'main provider', status: 'ok',
      details: ['live completion verified'], warnings: [],
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
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

  it('all-ready boot stores health and does not warn about failures', async () => {
    mockCheckSystemReadiness.mockResolvedValue(allReadyResult());
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());

    await gateway.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bootHealth = (gateway as any).bootHealth;
    expect(bootHealth).toBeDefined();
    expect(bootHealth.providers).toHaveLength(3);
    expect(bootHealth.providers.every((p: ReadinessResult) => p.ready)).toBe(true);

    const warnText = warn.mock.calls.flat().join('\n');
    expect(warnText).not.toContain('NOT ALL READY');

    await gateway.stop();
  });

  it('#3: /status reflects a live completion failure even when config checks pass', async () => {
    mockCheckSystemReadiness.mockResolvedValue(allReadyResult());
    mockProbeChatCompletion.mockResolvedValue({
      ready: false, checked: true, label: 'main provider', status: 'fail',
      details: ['live completion request was rejected by the model'], warnings: [],
      reasonCode: 'completion-failed', actionHint: 'Check subscription/API key.',
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());

    await gateway.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bootHealth = (gateway as any).bootHealth;
    const main = bootHealth.providers.find((p: ReadinessResult) => p.label === 'main provider');
    expect(main.ready).toBe(false);
    expect(main.reasonCode).toBe('completion-failed');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statusText = (gateway as any).buildBootStatusText();
    expect(statusText).toContain('main provider: FAIL');

    await gateway.stop();
  });

  it('Ollama-down boot warns loudly, does NOT throw, and stores degraded health', async () => {
    mockCheckSystemReadiness.mockResolvedValue(degradedResult());
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());

    await expect(gateway.start()).resolves.toBeUndefined();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bootHealth = (gateway as any).bootHealth;
    expect(bootHealth).toBeDefined();
    expect(bootHealth.providers[0].ready).toBe(false);

    const warnText = warn.mock.calls.flat().join('\n');
    expect(warnText).toContain('NOT ALL READY');
    expect(warnText).toContain('main provider');
    expect(warnText).toContain('ollama serve');

    await gateway.stop();
  });

  it('user messages still route after degraded boot', async () => {
    mockCheckSystemReadiness.mockResolvedValue(degradedResult());
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());
    await gateway.start();

    const send = jest.fn().mockResolvedValue(undefined);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'hello from agent',
      trace: [{ role: 'assistant', content: 'hello from agent' }],
      usedTools: [],
      healthResponse: false,
    });
    const sessions = {
      prepareHistory: jest.fn().mockResolvedValue([]),
      recordTurn: jest.fn().mockResolvedValue(undefined),
      getLastActiveAt: jest.fn().mockReturnValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send, disconnect };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({ chatId: 'chat-1', text: 'hi there' });

    expect(run).toHaveBeenCalledWith('hi there', expect.any(Array), { chatId: 'chat-1' });
    expect(send).toHaveBeenCalledWith('chat-1', { text: 'hello from agent' });

    await gateway.stop();
  });

  it('/status returns degraded text when a provider is down', async () => {
    mockCheckSystemReadiness.mockResolvedValue(degradedResult());
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());
    await gateway.start();

    const send = jest.fn().mockResolvedValue(undefined);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send, disconnect };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({ chatId: 'chat-1', text: '/status' });

    expect(send).toHaveBeenCalledTimes(1);
    const statusText = send.mock.calls[0][1].text;
    expect(statusText).toContain('System Health');
    expect(statusText).toContain('main provider');
    expect(statusText).toContain('FAIL');
    expect(statusText).toContain('telegram');

    await gateway.stop();
  });

  it('/status before healthcheck completes returns a sane message', async () => {
    mockCheckSystemReadiness.mockImplementation(() => new Promise(() => {}));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());

    const startPromise = gateway.start();

    const send = jest.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({ chatId: 'chat-1', text: '/status' });

    expect(send).toHaveBeenCalledTimes(1);
    const statusText = send.mock.calls[0][1].text;
    expect(statusText).toContain('not yet');

    mockCheckSystemReadiness.mockResolvedValue(allReadyResult());
    // let start complete
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = undefined;
    await startPromise.catch(() => {});
    await gateway.stop().catch(() => {});
  });

  it('/status works via handleTestMessage', async () => {
    mockCheckSystemReadiness.mockResolvedValue(allReadyResult());
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());
    await gateway.start();

    const result = await gateway.handleTestMessage('chat-1', '/status');
    expect(result).toContain('System Health');
    expect(result).toContain('main provider');

    await gateway.stop();
  });

  it('/status over the channel shows a bind-warning count but never the warning text (config-internals leak guard)', async () => {
    mockCheckSystemReadiness.mockResolvedValue(allReadyResult());
    mockCheckProviderBindAddresses.mockReturnValue({
      localhostOnly: false,
      warnings: ['main provider (https://api.example.com) is not localhost — health data may leave the machine'],
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());
    await gateway.start();

    const send = jest.fn().mockResolvedValue(undefined);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send, disconnect };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({ chatId: 'chat-1', text: '/status' });

    const statusText = send.mock.calls[0][1].text;
    expect(statusText).toContain('Security warnings: 1');
    // Provider baseUrls and warning bodies are config internals — they must
    // never reach a network channel.
    expect(statusText).not.toContain('api.example.com');
    expect(statusText).not.toContain('not localhost');

    await gateway.stop();
  });

  it('/status over the channel shows a perms-warning count but never the workspace path (filesystem-path leak guard)', async () => {
    mockCheckSystemReadiness.mockResolvedValue(allReadyResult());
    mockVerifyWorkspacePermissions.mockReturnValue({
      secure: false,
      warnings: ['Workspace /tmp/test has perms 755 (should be 0700 or stricter)'],
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());
    await gateway.start();

    const send = jest.fn().mockResolvedValue(undefined);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send, disconnect };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({ chatId: 'chat-1', text: '/status' });

    const statusText = send.mock.calls[0][1].text;
    expect(statusText).toContain('Security warnings: 1');
    // Absolute workspace paths point at the PHI tree — never over the channel.
    expect(statusText).not.toContain('/tmp/test');
    expect(statusText).not.toContain('perms');

    await gateway.stop();
  });

  it('security warnings still reach the local console in full', async () => {
    mockCheckSystemReadiness.mockResolvedValue(allReadyResult());
    mockCheckProviderBindAddresses.mockReturnValue({
      localhostOnly: false,
      warnings: ['main provider (https://api.example.com) is not localhost — health data may leave the machine'],
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());
    await gateway.start();

    const warned = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warned).toContain('not localhost');

    await gateway.stop();
  });

  it('security checks run against the resolved workspace path', async () => {
    mockCheckSystemReadiness.mockResolvedValue(allReadyResult());
    mockCheckProviderBindAddresses.mockReturnValue({ localhostOnly: true, warnings: [] });
    mockVerifyWorkspacePermissions.mockReturnValue({ secure: true, warnings: [] });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const config = makeConfig();
    const gateway = new Gateway(config);
    await gateway.start();

    expect(mockVerifyWorkspacePermissions).toHaveBeenCalled();
    const checkedPath = mockVerifyWorkspacePermissions.mock.calls[0][0];
    expect(typeof checkedPath).toBe('string');
    expect(checkedPath.length).toBeGreaterThan(0);

    await gateway.stop();
  });
});
