import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { SessionManager } from '../../src/gateway/session';
import type { AppConfig } from '../../src/config/types';

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('skip')),
  })),
}));

const mockBuildDesired = jest.fn().mockResolvedValue([]);
const mockReconcile = jest.fn().mockResolvedValue(undefined);
const mockSyncMarkdown = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/scheduler/policy-engine', () => ({
  buildDesiredHeartbeatJobs: (...args: unknown[]) => mockBuildDesired(...args),
}));
jest.mock('../../src/scheduler/reconciler', () => ({
  reconcilePolicyJobs: (...args: unknown[]) => mockReconcile(...args),
}));
jest.mock('../../src/scheduler/heartbeat-markdown', () => ({
  syncHeartbeatMarkdown: (...args: unknown[]) => mockSyncMarkdown(...args),
}));

const mockCheckSystemReadiness = jest.fn().mockResolvedValue({
  providers: [
    { ready: true, checked: true, label: 'main', status: 'ok', details: [], warnings: [] },
    { ready: true, checked: true, label: 'medical', status: 'ok', details: [], warnings: [] },
    { ready: true, checked: true, label: 'embeddings', status: 'ok', details: [], warnings: [] },
  ],
  telegram: { ready: true, checked: false, label: 'telegram', status: 'ok', details: ['disabled'], warnings: [] },
});
jest.mock('../../src/providers/healthcheck', () => ({
  checkSystemReadiness: (...args: unknown[]) => mockCheckSystemReadiness(...args),
}));
jest.mock('../../src/security/bind-check', () => ({
  checkProviderBindAddresses: () => ({ localhostOnly: true, warnings: [] }),
}));
jest.mock('../../src/security/perms-check', () => ({
  verifyWorkspacePermissions: () => ({ secure: true, warnings: [] }),
}));

describe('Gateway reconciler debounce', () => {
  let tmpDir: string;

  beforeEach(() => {
    jest.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-reconciler-debounce-'));
    mockBuildDesired.mockClear();
    mockReconcile.mockClear();
    mockSyncMarkdown.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
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
            morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
            eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
          },
        },
      },
      agent: { maxIterations: 15, disclaimerEnabled: true },
    };
  }

  function setupGatewayWithScheduler() {
    const config = makeConfig();
    const gateway = new Gateway(config);
    const sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));
    const mockScheduler = {
      listJobs: jest.fn().mockResolvedValue([]),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).scheduler = mockScheduler;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).resolvedMemoryWorkspace = config.memory.workspace;
    return { gateway, config };
  }

  it('burst of messages triggers exactly one reconcile after debounce window', async () => {
    const { gateway } = setupGatewayWithScheduler();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gw = gateway as any;
    await gw.debouncedReconcile('chat-1');
    await gw.debouncedReconcile('chat-1');
    await gw.debouncedReconcile('chat-1');
    await gw.debouncedReconcile('chat-1');
    await gw.debouncedReconcile('chat-1');

    expect(mockReconcile).not.toHaveBeenCalled();

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();

    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it('two different chatIds get independent debounce timers', async () => {
    const { gateway } = setupGatewayWithScheduler();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gw = gateway as any;
    await gw.debouncedReconcile('chat-A');
    await gw.debouncedReconcile('chat-B');

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();

    expect(mockReconcile).toHaveBeenCalledTimes(2);

    const chatIds = mockBuildDesired.mock.calls.map((call: unknown[]) => (call[0] as { chatId: string }).chatId);
    expect(chatIds).toContain('chat-A');
    expect(chatIds).toContain('chat-B');
  });

  it('re-scheduling within the window resets the timer for that chatId', async () => {
    const { gateway } = setupGatewayWithScheduler();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gw = gateway as any;
    await gw.debouncedReconcile('chat-1');

    jest.advanceTimersByTime(20_000);
    expect(mockReconcile).not.toHaveBeenCalled();

    await gw.debouncedReconcile('chat-1');

    jest.advanceTimersByTime(20_000);
    expect(mockReconcile).not.toHaveBeenCalled();

    jest.advanceTimersByTime(10_001);
    await Promise.resolve();

    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });

  it('startup reconcile is immediate (not debounced)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const config = makeConfig();
    fs.mkdirSync(path.join(config.memory.workspace, 'goals'), { recursive: true });
    fs.writeFileSync(
      path.join(config.memory.workspace, 'goals', 'walk.md'),
      '---\nstatus: active\ncron: "0 21 * * *"\nprompt: "Ask about the daily walk."\n---\n# Daily walk\n',
      'utf8',
    );

    const gateway = new Gateway(config);
    const disconnect = jest.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined), disconnect };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run: jest.fn().mockResolvedValue({ text: 'ok', trace: [] }) };
    const sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));
    await sessions.recordTurn('chat-1', [{ role: 'user', content: 'Seed startup chat.' }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).initializeScheduler();

    expect(mockReconcile).toHaveBeenCalled();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).scheduler?.stop();
    await gateway.stop();
  });

  it('debounce timers do not keep the process alive (unref)', async () => {
    const { gateway } = setupGatewayWithScheduler();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gw = gateway as any;
    await gw.debouncedReconcile('chat-1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timers = (gateway as any).reconcileTimers as Map<string, ReturnType<typeof setTimeout>>;
    const timer = timers.get('chat-1');
    expect(timer).toBeDefined();
    // Sinon fake timers implement hasRef(); an unref'd timeout reports false.
    // This pins the actual unref() contract, not just the timer's existence.
    expect((timer as unknown as { hasRef(): boolean }).hasRef()).toBe(false);
  });

  it('stop() clears pending debounce timers', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const config = makeConfig();
    const gateway = new Gateway(config);
    await gateway.start();

    const mockScheduler = {
      listJobs: jest.fn().mockResolvedValue([]),
      stop: jest.fn().mockResolvedValue(undefined),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).scheduler = mockScheduler;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).debouncedReconcile('chat-1');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timersBefore = (gateway as any).reconcileTimers as Map<string, ReturnType<typeof setTimeout>>;
    expect(timersBefore.size).toBeGreaterThan(0);

    await gateway.stop();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const timersAfter = (gateway as any).reconcileTimers as Map<string, ReturnType<typeof setTimeout>>;
    expect(timersAfter.size).toBe(0);
  });
});
