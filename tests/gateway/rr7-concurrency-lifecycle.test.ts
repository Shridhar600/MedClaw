import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LLMProvider } from '../../src/providers/types';
import type { AppConfig } from '../../src/config/types';
import type { HeartbeatJob } from '../../src/scheduler/types';
import { Gateway } from '../../src/gateway/gateway';
import { SqliteChunkStats, SqliteKeywordIndex, SqliteVecIndex } from '../../src/indexstore';

const mockMainProvider: LLMProvider = {
  modelName: 'rr7-main',
  chat: jest.fn().mockResolvedValue({ type: 'text', text: 'ok' }),
  embed: jest.fn().mockResolvedValue([]),
};
const mockEmbeddingProvider: LLMProvider = {
  modelName: 'rr7-embedding',
  chat: jest.fn().mockResolvedValue({ type: 'text', text: 'ok' }),
  embed: jest.fn().mockResolvedValue([]),
};

jest.mock('../../src/providers/factory', () => ({
  createProvider: jest.fn((config: { model: string }) =>
    config.model === 'rr7-embedding' ? mockEmbeddingProvider : mockMainProvider),
}));

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockResolvedValue(undefined),
    indexFile: jest.fn().mockResolvedValue(undefined),
  })),
}));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeConfig(tmpDir: string): AppConfig {
  return {
    providers: {
      main: { type: 'ollama', model: 'rr7-main', baseUrl: 'http://127.0.0.1:9/v1' },
      medical: { type: 'ollama', model: 'rr7-main', baseUrl: 'http://127.0.0.1:9/v1' },
      embeddings: { type: 'ollama', model: 'rr7-embedding', baseUrl: 'http://127.0.0.1:9/v1' },
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
        quietHours: { enabled: false, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 0,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 5, disclaimerEnabled: false },
    profiles: {
      baseDir: path.join(tmpDir, 'profiles'),
      defaultProfileId: 'default',
    },
  };
}

function latestIndexer(): { indexFile: jest.Mock } {
  const ctor = jest.requireMock('../../src/memory/indexer').MemoryIndexer as jest.Mock;
  return ctor.mock.results[ctor.mock.results.length - 1].value as { indexFile: jest.Mock };
}

const scheduledJob: HeartbeatJob = {
  id: 'rr7-job',
  title: 'RR-7 check-in',
  chatId: 'chat-1',
  cron: '0 8 * * *',
  timezone: 'Asia/Kolkata',
  prompt: 'Check in.',
  enabled: true,
  source: 'system',
  kind: 'routine',
  deliveryState: 'ready',
  retryCount: 0,
  maxRetries: 3,
  createdAt: '2026-04-19T07:00:00.000Z',
  updatedAt: '2026-04-19T07:00:00.000Z',
};

describe('Gateway RR-7 concurrency and lifecycle', () => {
  let tmpDir: string;
  let gateway: Gateway | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr7-'));
    jest.clearAllMocks();
  });

  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* cleanup must not mask the assertion */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not hold a turn on a hung post-capture index and records a durable dirty watermark', async () => {
    gateway = new Gateway(makeConfig(tmpDir));
    await gateway.start();
    const indexer = latestIndexer();
    const indexEntered = deferred();
    const releaseIndex = deferred();
    indexer.indexFile.mockImplementation(async (relativePath: string) => {
      if (relativePath.startsWith('memory/')) {
        indexEntered.resolve();
        await releaseIndex.promise;
      }
    });
    (gateway as unknown as { handleOnboarding: jest.Mock }).handleOnboarding = jest.fn().mockResolvedValue(undefined);
    const agentRun = jest.fn().mockResolvedValue({
        text: 'turn complete',
        trace: [{ role: 'assistant', content: 'turn complete' }],
        usedTools: [],
        healthResponse: false,
      });
    (gateway as unknown as { agentLoop: unknown }).agentLoop = {
      run: agentRun,
    };

    let turn: Promise<string> | undefined;
    try {
      turn = gateway.handleTestMessage('chat-1', 'I have a persistent headache today');
      await indexEntered.promise;

      const day = new Date().toISOString().slice(0, 10);
      const workspace = (gateway as unknown as { resolvedMemoryWorkspace: string }).resolvedMemoryWorkspace;
      const narrativePath = path.join(workspace, 'memory', `${day}.md`);
      expect(fs.readFileSync(narrativePath, 'utf8')).toContain('I have a persistent headache today');

      const completion = await Promise.race([
        turn.then(() => 'completed'),
        nextEventLoopTurn().then(() => 'pending'),
      ]);
      expect(completion).toBe('completed');
      expect(agentRun).toHaveBeenCalledTimes(1);
      const store = (gateway as unknown as { store: { getFileHash(filePath: string): string | undefined } }).store;
      expect(store.getFileHash(`memory/${day}.md`)).toMatch(/^embedding-partial:/);
    } finally {
      releaseIndex.resolve();
      await turn?.catch(() => undefined);
    }
  });

  it('bounds and aborts the embedding adapter supplied to the indexer', async () => {
    gateway = new Gateway(makeConfig(tmpDir));
    await gateway.start();
    jest.useFakeTimers();
    let aborted = false;
    const signalProvider = mockEmbeddingProvider as LLMProvider & {
      embedWithSignal?: (text: string, signal: AbortSignal) => Promise<number[]>;
    };
    const originalEmbedWithSignal = signalProvider.embedWithSignal;
    signalProvider.embedWithSignal = (_text, signal) => new Promise<number[]>(() => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    });
    try {
      const ctor = jest.requireMock('../../src/memory/indexer').MemoryIndexer as jest.Mock;
      const boundedProvider = ctor.mock.calls[ctor.mock.calls.length - 1][1] as LLMProvider;
      const pending = boundedProvider.embed('stuck embedding');
      const rejected = expect(pending).rejects.toThrow('embedding timeout');
      await jest.advanceTimersByTimeAsync(500);
      await rejected;
      expect(aborted).toBe(true);
    } finally {
      signalProvider.embedWithSignal = originalEmbedWithSignal;
      jest.useRealTimers();
    }
  });

  it('sends emergency guidance before starting capture and does not wait for capture', async () => {
    gateway = new Gateway(makeConfig(tmpDir));
    const captureStarted = deferred();
    const releaseCapture = deferred();
    const order: string[] = [];
    (gateway as unknown as { capturePipeline: unknown }).capturePipeline = {
      ingest: jest.fn(async () => {
        order.push('capture');
        captureStarted.resolve();
        await releaseCapture.promise;
      }),
    };
    (gateway as unknown as { sessions: unknown }).sessions = {
      recordTurn: jest.fn(async () => { order.push('persist'); }),
    };
    (gateway as unknown as { channel: unknown }).channel = {
      send: jest.fn(async () => { order.push('send'); }),
    };

    let turn: Promise<string> | undefined;
    try {
      turn = (gateway as unknown as {
        handleMessage(message: { chatId: string; userId: string; text: string }): Promise<void>;
      }).handleMessage({ chatId: 'chat-1', userId: 'user-1', text: 'I have chest pain right now' })
        .then(() => 'completed');
      await captureStarted.promise;
      const completion = await Promise.race([
        turn.then(() => 'completed'),
        nextEventLoopTurn().then(() => 'pending'),
      ]);
      expect(completion).toBe('completed');
    } finally {
      releaseCapture.resolve();
      await turn?.catch(() => undefined);
    }
    expect(order).toEqual(['persist', 'send', 'capture']);
  });

  it('does not turn a post-delivery reconcile failure into a scheduled delivery failure', async () => {
    gateway = new Gateway(makeConfig(tmpDir));
    const send = jest.fn().mockResolvedValue(undefined);
    const recordOutcome = jest.fn().mockResolvedValue(undefined);
    const reconcile = jest.fn().mockRejectedValue(new Error('private health reconciliation detail'));
    (gateway as unknown as { channel: unknown }).channel = { send };
    (gateway as unknown as { sessions: unknown }).sessions = {
      getLastActiveAt: jest.fn().mockReturnValue(undefined),
      prepareHistory: jest.fn().mockResolvedValue([]),
      recordTurn: jest.fn().mockResolvedValue(undefined),
      recordPromptUsage: jest.fn().mockResolvedValue(undefined),
    };
    (gateway as unknown as { agentLoop: unknown }).agentLoop = {
      run: jest.fn().mockResolvedValue({
        text: 'Heartbeat sent',
        trace: [{ role: 'assistant', content: 'Heartbeat sent' }],
        usedTools: [],
        healthResponse: false,
      }),
    };
    (gateway as unknown as { scheduler: unknown }).scheduler = { recordOutcome };
    (gateway as unknown as { reconcileHeartbeatPolicies: jest.Mock }).reconcileHeartbeatPolicies = reconcile;

    await expect(
      (gateway as unknown as { handleScheduledJob(job: HeartbeatJob, invokedByScheduler: boolean): Promise<void> })
        .handleScheduledJob(scheduledJob, true),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledWith('rr7-job', 'sent');
    expect(reconcile).toHaveBeenCalledWith('chat-1');
  });

  it('retains and closes all recall SQLite adapters exactly once across repeated stop calls', async () => {
    const vecClose = jest.spyOn(SqliteVecIndex.prototype, 'close');
    const keywordClose = jest.spyOn(SqliteKeywordIndex.prototype, 'close');
    const statsClose = jest.spyOn(SqliteChunkStats.prototype, 'close');
    gateway = new Gateway(makeConfig(tmpDir));
    await gateway.start();

    const state = gateway as unknown as Record<string, unknown>;
    expect(state.vectorIndex).toBeDefined();
    expect(state.keywordIndex).toBeDefined();
    expect(state.chunkStats).toBeDefined();

    await gateway.stop();
    await gateway.stop();

    expect(vecClose).toHaveBeenCalledTimes(1);
    expect(keywordClose).toHaveBeenCalledTimes(1);
    expect(statsClose).toHaveBeenCalledTimes(1);
  });

  it('refuses a scheduled heartbeat after shutdown begins, before the compaction drain', async () => {
    gateway = new Gateway(makeConfig(tmpDir));
    const compactionStarted = deferred();
    const releaseCompaction = deferred();
    const schedulerStopStarted = deferred();
    const releaseSchedulerStop = deferred();
    const prepareHistory = jest.fn().mockResolvedValue([]);
    (gateway as unknown as { sessions: unknown }).sessions = {
      drainCompactions: async () => {
        compactionStarted.resolve();
        await releaseCompaction.promise;
      },
      getLastActiveAt: jest.fn().mockReturnValue(undefined),
      prepareHistory,
      recordTurn: jest.fn().mockResolvedValue(undefined),
      recordPromptUsage: jest.fn().mockResolvedValue(undefined),
    };
    (gateway as unknown as { scheduler: unknown }).scheduler = {
      stop: async () => {
        schedulerStopStarted.resolve();
        await releaseSchedulerStop.promise;
      },
      recordOutcome: jest.fn().mockResolvedValue(undefined),
    };
    (gateway as unknown as { channel: unknown }).channel = {
      disconnect: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
    };
    (gateway as unknown as { agentLoop: unknown }).agentLoop = {
      run: jest.fn().mockResolvedValue({
        text: 'late heartbeat',
        trace: [{ role: 'assistant', content: 'late heartbeat' }],
        usedTools: [],
        healthResponse: false,
      }),
    };
    (gateway as unknown as { reconcileHeartbeatPolicies: jest.Mock }).reconcileHeartbeatPolicies = jest.fn().mockResolvedValue(undefined);

    const stopPromise = gateway.stop();
    try {
      await Promise.race([schedulerStopStarted.promise, compactionStarted.promise]);
      await (gateway as unknown as { handleScheduledJob(job: HeartbeatJob, invokedByScheduler: boolean): Promise<void> })
        .handleScheduledJob(scheduledJob, true);
      expect(prepareHistory).not.toHaveBeenCalled();
    } finally {
      releaseSchedulerStop.resolve();
      releaseCompaction.resolve();
      await stopPromise;
    }
  });
});
