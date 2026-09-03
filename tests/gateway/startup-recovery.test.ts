import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppConfig } from '../../src/config/types';
import type { HeartbeatJob } from '../../src/scheduler/types';

const mockSendMessage = jest.fn();
const mockBotOn = jest.fn();
const mockBotStart = jest.fn();
const mockBotStop = jest.fn();
const mockBotCatch = jest.fn();
const mockProvider = {
  chat: jest.fn().mockResolvedValue({ type: 'text', text: 'provider response' }),
  embed: jest.fn().mockResolvedValue([]),
};
const mockCreateProvider = jest.fn(() => mockProvider);
const mockProfileRuntimeCreate = jest.fn();
let capturedSideEffectLookup: ((entity: string) => Promise<string[]>) | undefined;

jest.mock('grammy', () => ({
  Bot: jest.fn(() => ({
    on: mockBotOn,
    api: { sendMessage: mockSendMessage },
    start: mockBotStart,
    stop: mockBotStop,
    catch: mockBotCatch,
    token: 'test-token',
  })),
}));

jest.mock('../../src/providers/factory', () => ({
  createProvider: mockCreateProvider,
}));

jest.mock('../../src/providers/healthcheck', () => ({
  checkSystemReadiness: jest.fn().mockResolvedValue({
    providers: [
      { ready: true, checked: true, label: 'main provider', status: 'ok', details: [], warnings: [] },
      { ready: true, checked: true, label: 'medical provider', status: 'ok', details: [], warnings: [] },
      { ready: true, checked: true, label: 'embeddings provider', status: 'ok', details: [], warnings: [] },
    ],
    telegram: { ready: true, checked: true, label: 'telegram', status: 'ok', details: [], warnings: [] },
  }),
  probeChatCompletion: jest.fn().mockResolvedValue({
    ready: true, checked: true, label: 'main provider', status: 'ok', details: [], warnings: [],
  }),
}));

jest.mock('../../src/gateway/runtime', () => ({
  ProfileRuntime: { create: mockProfileRuntimeCreate },
}));

describe('Gateway scheduler recovery wiring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-startup-recovery-'));
    jest.clearAllMocks();
    mockBotStart.mockResolvedValue(undefined);
    mockBotStop.mockResolvedValue(undefined);
    mockBotCatch.mockImplementation(() => undefined);
    mockBotOn.mockImplementation(() => undefined);
    mockSendMessage.mockResolvedValue(undefined);
    mockProvider.chat.mockResolvedValue({ type: 'text', text: 'provider response' });
    mockProvider.embed.mockResolvedValue([]);
    mockCreateProvider.mockClear();
    capturedSideEffectLookup = undefined;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(): AppConfig {
    return {
      providers: {
        main: { type: 'ollama', model: 'test-main' },
        medical: { type: 'ollama', model: 'test-medical' },
        embeddings: { type: 'ollama', model: 'test-embeddings' },
      },
      channels: { telegram: { enabled: true, botToken: 'test-token' } },
      tools: { allow: ['*'], deny: [] },
      memory: {
        workspace: path.join(tmpDir, 'workspace'),
        search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
        bootstrapMaxChars: 20_000,
      },
      sessions: {
        softResetAfterMinutes: 240,
        hardResetAfterMinutes: 1440,
        compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
      },
      heartbeat: {
        enabled: true,
        timezone: 'UTC',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        recovery: { enabled: true, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
        policy: {
          quietHours: { enabled: false, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 60,
          defaults: {
            morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
            eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
          },
        },
      },
      agent: { maxIterations: 5, disclaimerEnabled: false },
    };
  }

  function recoveryJob(): HeartbeatJob {
    const now = new Date().toISOString();
    return {
      id: 'recovered-job',
      title: 'Recovered check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'UTC',
      prompt: 'Recover this run.',
      enabled: true,
      source: 'system',
      kind: 'routine',
      deliveryState: 'ready',
      retryCount: 0,
      maxRetries: 3,
      createdAt: now,
      updatedAt: now,
    };
  }

  function installRuntime(config: AppConfig): void {
    const job = recoveryJob();
    const runtime: Record<string, unknown> = {
      profileId: 'default',
      workspace: config.memory.workspace,
      config,
      agentLoop: {},
      sessions: {
        getMostRecentChatId: jest.fn().mockReturnValue(undefined),
        getLastActiveAt: jest.fn().mockReturnValue(undefined),
      },
      turnCoordinator: {
        runHeartbeat: jest.fn(async (request: { egress: (text: string) => Promise<void>; afterDelivery: (result: { text: string }) => Promise<void> }) => {
          const result = { text: 'recovered heartbeat' };
          await request.egress(result.text);
          await request.afterDelivery(result);
          return { status: 'sent', result };
        }),
      },
      trackOperation: <T>(operation: () => Promise<T>): Promise<T> => operation(),
      trackBackgroundOperation: jest.fn(),
      beginStopping: jest.fn(),
      drainAndClose: jest.fn().mockResolvedValue(undefined),
    };
    runtime.initializeScheduler = async (options: { runScheduledJob: (job: HeartbeatJob) => Promise<void> }): Promise<void> => {
      runtime.scheduler = {
        listJobs: jest.fn().mockResolvedValue([]),
        recordOutcome: jest.fn().mockResolvedValue(undefined),
        recordFailure: jest.fn().mockResolvedValue(undefined),
      };
      await options.runScheduledJob(job);
    };
    mockProfileRuntimeCreate.mockImplementation(async (deps: {
      canSchedule?: boolean;
      runScheduledJob: (job: HeartbeatJob) => Promise<void>;
      sideEffectLookup?: (entity: string) => Promise<string[]>;
    }) => {
      // Reproduce the old construction-time recovery callback. On the fixed path
      // Gateway passes false and performs recovery after it owns the runtime.
      capturedSideEffectLookup = deps.sideEffectLookup;
      if (deps.canSchedule) await deps.runScheduledJob(job);
      return runtime;
    });
  }

  it('does not drop a recovered heartbeat while ProfileRuntime.create is in progress', async () => {
    const { Gateway } = await import('../../src/gateway/gateway');
    const config = makeConfig();
    installRuntime(config);
    const gateway = new Gateway(config);

    await gateway.start();
    try {
      expect(mockProfileRuntimeCreate).toHaveBeenCalledWith(expect.objectContaining({ canSchedule: false }));
      expect(mockSendMessage).toHaveBeenCalledWith(
        'chat-1',
        'recovered heartbeat',
        expect.anything(),
      );
      expect(mockCreateProvider).toHaveBeenCalledTimes(2);
      await capturedSideEffectLookup?.('medication-a');
      await capturedSideEffectLookup?.('medication-b');
      expect(mockCreateProvider).toHaveBeenCalledTimes(2);
    } finally {
      await gateway.stop();
    }
  });
});
