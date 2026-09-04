/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles';
import type { LLMProvider } from '../../src/providers/types';
import { LLMSemaphore } from '../../src/tools/semaphore';
import { ProfileRuntime } from '../../src/gateway/runtime';
import { DaemonShutdownError } from '../../src/shared/errors';
import {
  SqliteChunkStats,
  SqliteEventSink,
  SqliteFactMirror,
  SqliteKeywordIndex,
  SqliteSessionIndex,
  SqliteVecIndex,
} from '../../src/indexstore';
import { SqliteStore } from '../../src/memory/sqlite-store';

const mockMainProvider: LLMProvider = {
  modelName: 'rs4-main',
  chat: jest.fn().mockResolvedValue({ type: 'text', text: 'ok' }),
  embed: jest.fn().mockResolvedValue(new Array(768).fill(0.01)),
};
const mockEmbeddingProvider: LLMProvider = {
  modelName: 'rs4-embedding',
  chat: jest.fn().mockResolvedValue({ type: 'text', text: 'ok' }),
  embed: jest.fn().mockResolvedValue(new Array(768).fill(0.01)),
};

jest.mock('../../src/providers/factory', () => ({
  createProvider: jest.fn((config: { model: string }) =>
    config.model === 'rs4-embedding' ? mockEmbeddingProvider : mockMainProvider),
}));

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockResolvedValue(undefined),
    indexFile: jest.fn().mockResolvedValue(undefined),
  })),
}));

function makeConfig(tmpDir: string): AppConfig {
  const workspace = path.join(tmpDir, 'workspace');
  return {
    providers: {
      main: { type: 'ollama', model: 'rs4-main', baseUrl: 'http://127.0.0.1:9/v1' },
      medical: { type: 'ollama', model: 'rs4-main', baseUrl: 'http://127.0.0.1:9/v1' },
      embeddings: { type: 'ollama', model: 'rs4-embedding', baseUrl: 'http://127.0.0.1:9/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace,
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
    agent: { maxIterations: 15, disclaimerEnabled: true },
    profiles: {
      baseDir: path.join(tmpDir, 'profiles'),
      defaultProfileId: 'default',
    },
  };
}

async function makeRuntime(tmpDir: string): Promise<ProfileRuntime> {
  const config = makeConfig(tmpDir);
  const workspace = path.join(tmpDir, 'workspace');
  const dbPath = path.join(tmpDir, 'search.db');
  const semaphore = new LLMSemaphore();
  return ProfileRuntime.create({
    profileId: 'default' as ProfileId,
    workspace,
    dbPath,
    sessionsPath: path.join(tmpDir, 'sessions'),
    schedulerPaths: {
      storePath: config.heartbeat.storePath,
      auditLogPath: config.heartbeat.audit.path,
    },
    config,
    mainProvider: mockMainProvider,
    semaphore,
    canSchedule: false,
    runScheduledJob: jest.fn().mockResolvedValue(undefined),
    sideEffectLookup: jest.fn().mockResolvedValue([]),
  });
}

describe('RR-STRUCT R-S4 — ProfileRuntime lifecycle state machine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs4-lifecycle-'));
    fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('progresses running -> stopping -> closed, one-way, exposed via getLifecycleState()', async () => {
    const runtime = await makeRuntime(tmpDir);
    expect(runtime.getLifecycleState()).toBe('running');
    expect(runtime.isStopping()).toBe(false);
    expect(runtime.isClosed()).toBe(false);

    runtime.beginStopping();
    expect(runtime.getLifecycleState()).toBe('stopping');
    expect(runtime.isStopping()).toBe(true);
    expect(runtime.isClosed()).toBe(false);

    await runtime.drainAndClose();
    expect(runtime.getLifecycleState()).toBe('closed');
    expect(runtime.isStopping()).toBe(true); // isStopping() stays true once past running (existing contract)
    expect(runtime.isClosed()).toBe(true);

    // One-way: calling beginStopping() again after close must NOT regress the state.
    runtime.beginStopping();
    expect(runtime.getLifecycleState()).toBe('closed');
  });

  it('RED #1 — a late MutationCoordinator write after drainAndClose is a handled DaemonShutdownError, never a crash', async () => {
    const runtime = await makeRuntime(tmpDir);
    await runtime.drainAndClose();

    const attempt = async (): Promise<unknown> =>
      runtime.mutationCoordinator!.mutate('turn', { id: 'late', label: 'late-write', run: async () => 'x' });
    await expect(attempt()).rejects.toBeInstanceOf(DaemonShutdownError);
  });

  it('RED #1 — a late SessionManager.recordTurn after drainAndClose is a handled DaemonShutdownError, never a crash', async () => {
    const runtime = await makeRuntime(tmpDir);
    await runtime.drainAndClose();

    await expect(runtime.sessions!.recordTurn('late-chat', [
      { role: 'user', content: 'hello after close' },
      { role: 'assistant', content: 'hi' },
    ])).rejects.toBeInstanceOf(DaemonShutdownError);
  });

  it('RED #2 — an in-flight turn that started before stop() still drains its recordTurn before closeStore()', async () => {
    const runtime = await makeRuntime(tmpDir);
    let releaseOp!: () => void;
    const gate = new Promise<void>((resolve) => { releaseOp = resolve; });

    const opPromise = runtime.trackOperation(async () => {
      await gate;
      await runtime.sessions!.recordTurn('in-flight-chat', [
        { role: 'user', content: 'started before stop' },
        { role: 'assistant', content: 'ack' },
      ]);
    });

    const closePromise = runtime.drainAndClose();
    // Let drainAndClose reach (and block in) the in-flight-operations drain phase.
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.isClosed()).toBe(false); // still draining — our op has not released yet

    releaseOp();
    await Promise.all([opPromise, closePromise]);

    expect(runtime.isClosed()).toBe(true);
    // The write landed BEFORE the store closed (drain waited for it — no data loss).
    expect(runtime.sessions!.getHistory('in-flight-chat')).toHaveLength(2);
  });

  it('RED #4 — idempotent close: a second drainAndClose() after the first still leaves writes cleanly gated (no double-close, no throw)', async () => {
    const runtime = await makeRuntime(tmpDir);
    await runtime.drainAndClose();
    await expect(runtime.drainAndClose()).resolves.toBeUndefined();

    const attempt = async (): Promise<unknown> =>
      runtime.mutationCoordinator!.enqueue('turn', { label: 'still-gated', run: async () => 'x' });
    await expect(attempt()).rejects.toBeInstanceOf(DaemonShutdownError);
    await expect(runtime.sessions!.recordTurn('late-chat-2', [
      { role: 'user', content: 'still after double close' },
    ])).rejects.toBeInstanceOf(DaemonShutdownError);
  });
});

describe('RR-STRUCT R-S4 — bounded hard-stop', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs4-bound-'));
    fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('RED #3 — a hung in-flight operation (a promise that never resolves) does not stall shutdown; drainAndClose completes within the budget, warns, and closes every store', async () => {
    const runtime = await makeRuntime(tmpDir);

    const vecSpy = jest.spyOn(SqliteVecIndex.prototype, 'close');
    const storeSpy = jest.spyOn(SqliteStore.prototype, 'close');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    // A deterministic "hung op": a promise that NEVER resolves on its own, matching the brief's
    // required technique (manual deferred + fake timers — never a real wall-clock sleep).
    runtime.trackOperation(() => new Promise<void>(() => { /* never resolves */ }));

    jest.useFakeTimers();
    try {
      const closePromise = runtime.drainAndClose();
      // Advance well past the drain budget so the bounded race's setTimeout fires.
      await jest.advanceTimersByTimeAsync(60_000);
      await closePromise;
    } finally {
      jest.useRealTimers();
    }

    expect(runtime.isClosed()).toBe(true);
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(vecSpy).toHaveBeenCalledTimes(1);
    // A sanitized warning must name that shutdown proceeded with an operation still in flight —
    // never the raw content of the hung operation (there is none here; asserting presence only).
    const warnedAboutBudget = warnSpy.mock.calls.some((call) =>
      call.some((arg) => typeof arg === 'string' && /drain budget|shutdown/i.test(arg)));
    expect(warnedAboutBudget).toBe(true);
  }, 20_000);

  it('RED #3b — the SAME (non-hung) fast path still closes all 7 handles in the documented order within budget (no regression from the bound)', async () => {
    const runtime = await makeRuntime(tmpDir);
    const closeOrder: string[] = [];
    jest.spyOn(SqliteVecIndex.prototype, 'close').mockImplementation(() => { closeOrder.push('vectorIndex'); });
    jest.spyOn(SqliteKeywordIndex.prototype, 'close').mockImplementation(() => { closeOrder.push('keywordIndex'); });
    jest.spyOn(SqliteChunkStats.prototype, 'close').mockImplementation(() => { closeOrder.push('chunkStats'); });
    jest.spyOn(SqliteSessionIndex.prototype, 'close').mockImplementation(() => { closeOrder.push('sessionIndex'); });
    jest.spyOn(SqliteFactMirror.prototype, 'close').mockImplementation(() => { closeOrder.push('factMirror'); });
    jest.spyOn(SqliteEventSink.prototype, 'close').mockImplementation(() => { closeOrder.push('eventSink'); });
    jest.spyOn(SqliteStore.prototype, 'close').mockImplementation(() => { closeOrder.push('store'); });

    await runtime.drainAndClose();

    expect(closeOrder).toEqual([
      'vectorIndex', 'keywordIndex', 'chunkStats', 'sessionIndex', 'factMirror', 'eventSink', 'store',
    ]);
  });
});
