
import * as fs from 'fs';
import * as path from 'path';

import { Gateway } from '../../src/gateway/gateway';
import { ProfileRuntime } from '../../src/gateway/runtime';
import { ProfileRuntimeManager } from '../../src/gateway/manager';
import { resolveOwnerPaths } from '../../src/profiles/paths';
import { asProfileId } from '../../src/profiles';
import type { EffectiveConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';
import { LLMSemaphore } from '../../src/tools/semaphore';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

const SENSITIVE_MARKER = 'default-user-secret-diagnosis-stage-3-CKD';

describe('owner runtime isolation: storage, ledger, sweep and drain are per-identity', () => {
  let tmpDir: string;
  let config: EffectiveConfig;

  beforeEach(() => {
    tmpDir = makeTestTemp('owner-runtime-isolation');
    config = {
      schemaVersion: 2,
      providers: {
        main: { type: 'ollama', model: 'test-model', baseUrl: 'http://127.0.0.1:9/v1' },
        medical: { type: 'ollama', model: 'test-model', baseUrl: 'http://127.0.0.1:9/v1' },
        embeddings: { type: 'ollama', model: 'test-model', baseUrl: 'http://127.0.0.1:9/v1' },
      },
      channels: { telegram: { enabled: false, botToken: '' } },
      tools: { allow: ['*'], deny: [] },
      memory: {
        workspace: path.join(tmpDir, 'owner-workspace'),
        search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
        bootstrapMaxChars: 20000,
      },
      sessions: {
        compaction: { enabled: true, memoryFlush: true, keepRecentTurns: 10 },
      },
      heartbeat: {
        enabled: false,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'owner-workspace', '.state', 'heartbeat-jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'owner-workspace', '.state', 'audit.jsonl') },
        policy: {
          quietHours: { enabled: false, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 0,
          defaults: {
            morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
            eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
          },
        },
      },
      agent: { maxIterations: 15 },
      profiles: { baseDir: tmpDir, defaultProfileId: 'default' },
    };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    removeTestTemp(tmpDir);
    jest.restoreAllMocks();
  });

  function buildFor(ownerId: string): Promise<ProfileRuntime> {
    const id = asProfileId(ownerId);
    if (id === undefined) throw new Error(`invalid owner id ${ownerId}`);
    const paths = resolveOwnerPaths(tmpDir, id);
    fs.mkdirSync(paths.workspace, { recursive: true, mode: 0o700 });
    return ProfileRuntime.create({
      profileId: id,
      workspace: paths.workspace,
      dbPath: paths.searchDb,
      sessionsPath: paths.sessions,
      schedulerPaths: { storePath: paths.schedulerStore, auditLogPath: paths.auditLog },
      config,
      mainProvider: { modelName: 'test', chat: jest.fn(), embed: jest.fn() },
      semaphore: new LLMSemaphore(),
      canSchedule: false,
      reconcile: jest.fn(),
      sideEffectLookup: jest.fn().mockResolvedValue([]),
    });
  }

  it('builds pairwise-disjoint runtimes: no workspace, database, session lane or job store is shared', async () => {
    const a = await buildFor('default');
    const b = await buildFor('father');
    const c = await buildFor('sibling');
    try {
      const workspaces = [a.workspace, b.workspace, c.workspace];
      expect(new Set(workspaces).size).toBe(3);

      for (const runtime of [a, b, c]) {
        const own = resolveOwnerPaths(tmpDir, runtime.profileId);
        expect(runtime.workspace).toBe(own.workspace);
        expect(runtime.sessions!.sessionsDir.startsWith(`${own.workspace}${path.sep}`)).toBe(true);
      }
    } finally {
      await a.drainAndClose();
      await b.drainAndClose();
      await c.drainAndClose();
    }
  });

  it('a ledger write in one identity is completely invisible to another (real SqliteStore/LedgerStore)', async () => {
    const a = await buildFor('default');
    const b = await buildFor('father');
    try {
      await a.ledgerStore!.recordFact({
        entity: 'lisinopril',
        type: 'medication',
        fields: { dose: '10mg' },
        provenance: { source: 'user', confidence: 1, anchor: 'memory/x.md#L1', capturedAt: new Date().toISOString() },
      });

      const aFacts = await a.ledgerStore!.listAllOfType('medication');
      expect(aFacts.some((f) => f.entity === 'lisinopril')).toBe(true);
      const bFacts = await b.ledgerStore!.listAllOfType('medication');
      expect(bFacts).toEqual([]);
      expect(resolveOwnerPaths(tmpDir, a.profileId).searchDb).not.toBe(
        resolveOwnerPaths(tmpDir, b.profileId).searchDb,
      );
    } finally {
      await a.drainAndClose();
      await b.drainAndClose();
    }
  });

  it('seeds distinct content per identity and greps clean: no identity inherits another\'s facts', async () => {
    const a = await buildFor('default');
    const b = await buildFor('father');
    try {
      fs.writeFileSync(path.join(a.workspace, 'HEALTH_PROFILE.md'), `# Owner A\n${SENSITIVE_MARKER}\n`, { mode: 0o600 });

      const grepTree = (dir: string, needle: string): string[] => {
        const hits: string[] = [];
        const walk = (current: string): void => {
          for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.isFile()) continue;
            if (fs.readFileSync(full, 'utf8').includes(needle)) hits.push(path.relative(dir, full));
          }
        };
        walk(dir);
        return hits;
      };

      expect(grepTree(a.workspace, SENSITIVE_MARKER).length).toBeGreaterThan(0);
      expect(grepTree(b.workspace, SENSITIVE_MARKER)).toEqual([]);
    } finally {
      await a.drainAndClose();
      await b.drainAndClose();
    }
  });

  it('the manager builds each identity exactly once and a build failure degrades only that identity', async () => {
    const builds: string[] = [];
    const manager = new ProfileRuntimeManager(async (id: ProfileId) => {
      builds.push(id);
      if (id === ('broken' as ProfileId)) throw new Error('simulated broken storage for this identity');
      return buildFor(id);
    });

    const first = await manager.get('default' as ProfileId);
    const second = await manager.get('default' as ProfileId);
    expect(first).toBe(second);
    expect(builds.filter((id) => id === 'default')).toHaveLength(1);

    await manager.buildAll(['default' as ProfileId]);
    expect(builds.filter((id) => id === 'default')).toHaveLength(1);

    await expect(manager.get('broken' as ProfileId)).rejects.toThrow(/simulated broken storage/);
    expect(await manager.get('default' as ProfileId)).toBe(first);

    await first.drainAndClose();
  });

  it('a failing transcript sweep does not throw out of the Gateway sweep coordinator', async () => {
    const { writeConfigFixture } = await import('../helpers/config-fixture');
    const fixture = writeConfigFixture(tmpDir, { telegramEnabled: false, ownerId: 'default' });
    const { readConfigDocument, effectiveConfigFor } = await import('../../src/runtime/installation');
    const bootConfig = effectiveConfigFor(readConfigDocument(fixture.configPath, tmpDir).stored);

    const { bindGatewayOwner } = await import('../helpers/gateway-owner-deps');
    const gateway = new Gateway(bootConfig, await bindGatewayOwner(bootConfig, 'owner-chat'));
    await gateway.start();

    try {
      const healthy = await gateway.runTranscriptSweep();
      expect(healthy.scanned).toBe(true);

      const runtime = gateway.runtimeInstance!;
      const failing = jest.spyOn(runtime, 'runTranscriptSweep')
        .mockRejectedValue(new Error('simulated unreadable ledger lane'));

      await expect(gateway.runTranscriptSweep()).resolves.toEqual({ scanned: false, added: 0 });

      failing.mockRestore();
      await expect(gateway.runTranscriptSweep()).resolves.toMatchObject({ scanned: true });
    } finally {
      await gateway.stop();
    }
  });

  it('drains and closes every runtime it owns', async () => {
    const a = await buildFor('default');
    const b = await buildFor('father');
    await a.drainAndClose();
    await b.drainAndClose();
    expect(a.profileId).toBe('default');
    expect(b.profileId).toBe('father');
  });

  it('hardens a freshly-created owner workspace (dir 0700, files 0600)', async () => {
    const runtime = await buildFor('default');
    try {
      const workspaceStat = fs.lstatSync(runtime.workspace);
      expect(workspaceStat.isDirectory()).toBe(true);
      expect(workspaceStat.mode & 0o777).toBe(0o700);
    } finally {
      await runtime.drainAndClose();
    }
  });
});

describe('the Gateway structurally refuses to serve a second identity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('owner-runtime-single-identity');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    removeTestTemp(tmpDir);
    jest.restoreAllMocks();
  });

  it('buildRuntimeFor refuses any identity that is not the selected owner', async () => {
    const { writeConfigFixture } = await import('../helpers/config-fixture');

    const fixture = writeConfigFixture(tmpDir, { telegramEnabled: false, ownerId: 'default' });
    const { readConfigDocument, effectiveConfigFor } = await import('../../src/runtime/installation');
    const config = effectiveConfigFor(readConfigDocument(fixture.configPath, tmpDir).stored);

    const { bindGatewayOwner } = await import('../helpers/gateway-owner-deps');
    const gateway = new Gateway(config, await bindGatewayOwner(config, 'owner-chat'));
    const build = (gateway as unknown as {
      buildRuntimeFor(id: ProfileId): Promise<ProfileRuntime>;
    }).buildRuntimeFor.bind(gateway);

    const runtime = await build('default' as ProfileId);
    try {
      expect(runtime.profileId).toBe('default');
      expect(runtime.workspace).toBe(fixture.workspace);
    } finally {
      await runtime.drainAndClose();
    }

    await expect(build('father' as ProfileId)).rejects.toThrow(/Refusing to build a runtime for "father".*serves owner "default"/s);
    await expect(build('secondary' as ProfileId)).rejects.toThrow(/Refusing to build a runtime/);
  });
});
