/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { EffectiveConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles';
import type { LLMProvider } from '../../src/providers/types';
import { LLMSemaphore } from '../../src/tools/semaphore';
import { Gateway } from '../../src/gateway/gateway';
import { withoutOwnerIdentity } from '../helpers/test-config';
import { bindGatewayOwner } from '../helpers/gateway-owner-deps';
import { ProfileRuntime } from '../../src/gateway/runtime';
import { SqliteChunkStats, SqliteEventSink, SqliteFactMirror, SqliteKeywordIndex, SqliteSessionIndex, SqliteVecIndex } from '../../src/indexstore';
import { SqliteStore } from '../../src/memory/sqlite-store';


const mockMainProvider: LLMProvider = {
  modelName: 'runtime-test-main',
  chat: jest.fn().mockResolvedValue({ type: 'text', text: 'ok' }),
  embed: jest.fn().mockResolvedValue(new Array(768).fill(0.01)),
};
const mockEmbeddingProvider: LLMProvider = {
  modelName: 'runtime-test-embedding',
  chat: jest.fn().mockResolvedValue({ type: 'text', text: 'ok' }),
  embed: jest.fn().mockResolvedValue(new Array(768).fill(0.01)),
};

jest.mock('../../src/providers/factory', () => ({
  createProvider: jest.fn((config: { model: string }) =>
    config.model === 'runtime-test-embedding' ? mockEmbeddingProvider : mockMainProvider),
}));

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockResolvedValue(undefined),
    indexFile: jest.fn().mockResolvedValue(undefined),
  })),
}));

function makeConfig(tmpDir: string): EffectiveConfig {
  const workspace = path.join(tmpDir, 'workspace');
  return {
  schemaVersion: 2,
    providers: {
      main: { type: 'ollama', model: 'runtime-test-main', baseUrl: 'http://127.0.0.1:9/v1' },
      medical: { type: 'ollama', model: 'runtime-test-main', baseUrl: 'http://127.0.0.1:9/v1' },
      embeddings: { type: 'ollama', model: 'runtime-test-embedding', baseUrl: 'http://127.0.0.1:9/v1' },
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
      enabled: true,
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

describe('ProfileRuntime Seam Tests (R-S1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-profile-runtime-'));
    fs.mkdirSync(path.join(tmpDir, 'workspace'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('ProfileRuntime.create builds and exposes live handles', async () => {
    const config = makeConfig(tmpDir);
    const workspace = path.join(tmpDir, 'workspace');
    const dbPath = path.join(tmpDir, 'search.db');
    const semaphore = new LLMSemaphore();
    const runtime = await ProfileRuntime.create({
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
      canSchedule: true,
      runScheduledJob: jest.fn().mockResolvedValue(undefined),
      canAddressChat: () => true,
      sideEffectLookup: jest.fn().mockResolvedValue([]),
    });

    try {
      expect(runtime.store).toBeDefined();
      expect(runtime.sessions).toBeDefined();
      expect(runtime.agentLoop).toBeDefined();
      expect(runtime.scheduler).toBeDefined();
      expect(runtime.registry).toBeDefined();
      expect(runtime.factMirror).toBeDefined();
      expect(runtime.writeQueue).toBeDefined();
      expect(runtime.capturePipeline).toBeDefined();
      expect(runtime.promptMode).toBe('per-turn');
    } finally {
      await runtime.drainAndClose();
    }
  });

  it('drainAndClose drains then closes every SQLite handle exactly once in order and is idempotent', async () => {
    const config = makeConfig(tmpDir);
    const workspace = path.join(tmpDir, 'workspace');
    const dbPath = path.join(tmpDir, 'search.db');
    const semaphore = new LLMSemaphore();

    const closeOrder: string[] = [];
    const vecSpy = jest.spyOn(SqliteVecIndex.prototype, 'close').mockImplementation(() => { closeOrder.push('vectorIndex'); });
    const kwSpy = jest.spyOn(SqliteKeywordIndex.prototype, 'close').mockImplementation(() => { closeOrder.push('keywordIndex'); });
    const chunkSpy = jest.spyOn(SqliteChunkStats.prototype, 'close').mockImplementation(() => { closeOrder.push('chunkStats'); });
    const sessSpy = jest.spyOn(SqliteSessionIndex.prototype, 'close').mockImplementation(() => { closeOrder.push('sessionIndex'); });
    const mirrorSpy = jest.spyOn(SqliteFactMirror.prototype, 'close').mockImplementation(() => { closeOrder.push('factMirror'); });
    const eventSpy = jest.spyOn(SqliteEventSink.prototype, 'close').mockImplementation(() => { closeOrder.push('eventSink'); });
    const storeSpy = jest.spyOn(SqliteStore.prototype, 'close').mockImplementation(() => { closeOrder.push('store'); });

    const runtime = await ProfileRuntime.create({
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
      canSchedule: true,
      runScheduledJob: jest.fn().mockResolvedValue(undefined),
      canAddressChat: () => true,
      sideEffectLookup: jest.fn().mockResolvedValue([]),
    });

    // First drain and close
    await runtime.drainAndClose();

    // Verify all 7 handles closed once in exact documented order
    expect(vecSpy).toHaveBeenCalledTimes(1);
    expect(kwSpy).toHaveBeenCalledTimes(1);
    expect(chunkSpy).toHaveBeenCalledTimes(1);
    expect(sessSpy).toHaveBeenCalledTimes(1);
    expect(mirrorSpy).toHaveBeenCalledTimes(1);
    expect(eventSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(closeOrder).toEqual([
      'vectorIndex',
      'keywordIndex',
      'chunkStats',
      'sessionIndex',
      'factMirror',
      'eventSink',
      'store',
    ]);

    // Second drain and close must be idempotent (no double close, no throw)
    await expect(runtime.drainAndClose()).resolves.toBeUndefined();
    expect(vecSpy).toHaveBeenCalledTimes(1);
    expect(storeSpy).toHaveBeenCalledTimes(1);
  });

  it('beginStopping sets the stopping and sweepStopping gates so in-flight sweeps and reindexes short-circuit', async () => {
    const config = makeConfig(tmpDir);
    const workspace = path.join(tmpDir, 'workspace');
    const dbPath = path.join(tmpDir, 'search.db');
    const semaphore = new LLMSemaphore();

    const runtime = await ProfileRuntime.create({
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

    try {
      runtime.beginStopping();
      expect(runtime.isStopping()).toBe(true);

      const sweepResult = await runtime.runTranscriptSweep();
      expect(sweepResult).toEqual({ scanned: false, added: 0 });
    } finally {
      await runtime.drainAndClose();
    }
  });

  it('write operations arriving after drainAndClose are safe gated no-ops', async () => {
    const config = makeConfig(tmpDir);
    const workspace = path.join(tmpDir, 'workspace');
    const dbPath = path.join(tmpDir, 'search.db');
    const semaphore = new LLMSemaphore();

    const runtime = await ProfileRuntime.create({
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

    await runtime.drainAndClose();
    expect(runtime.isClosed()).toBe(true);

    // Any late reindex or background operation arriving after close must not crash
    expect(() => {
      runtime.trackBackgroundOperation('late-op', async () => {
        throw new Error('should not execute');
      });
    }).not.toThrow();

    // Late sweep call must return empty result immediately
    const sweepResult = await runtime.runTranscriptSweep();
    expect(sweepResult).toEqual({ scanned: false, added: 0 });
  });

  it('REFUSES a document with no owner identity instead of serving on a legacy path', async () => {
    // S1 change (OLD -> NEW). OLD: "legacy mode without profiles config builds runtime on legacy
    // paths and operates" — it booted, built a runtime on `config.memory.workspace`, and answered
    // messages, using the literal identity `'default'` inferred from an ABSENT section. That is the
    // shape of document the schema-v2 decoder rejects outright, so the state it exercised cannot be
    // reached through any supported configuration: it only survived because this suite bypassed the
    // decoder with a hand-built object. Serving it meant inferring an owner from nothing, which is
    // exactly what plan 15 §2.1 forbids.
    //
    // NEW invariant, and the one that matters: a configuration naming no owner REFUSES TO SERVE. It
    // does not fall back to `'default'`, does not touch the workspace, and does not build a runtime.
    // A missing owner is a programming error in the caller, not a mode.
    const config = withoutOwnerIdentity(makeConfig(tmpDir));
    // The CONFIG under test names no owner — that is the whole point. Admission is still REQUIRED on the
    // constructor, so it is supplied from a VALID config: the refusal under test comes from the
    // owner-less config's own path derivation, not from missing authority.
    const gateway = new Gateway(config, await bindGatewayOwner(makeConfig(tmpDir), 'owner-chat'));

    await expect(gateway.start()).rejects.toThrow(/no valid owner identity/i);

    // Nothing was served and nothing clinical was built.
    expect(gateway.runtimeInstance).toBeUndefined();
    expect(gateway.runtimeManager).toBeUndefined();
    expect(gateway.servesPairingOnly).toBe(false);
  });
});
