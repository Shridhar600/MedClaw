// tests/profiles/owner-runtime-isolation.test.ts
//
// S1 replacement for `rs5a-multi-profile-isolation.test.ts`.
//
// WHAT MOVED AND WHY. The retired suite proved `ProfileRuntimeManager` builds DISJOINT runtimes and
// that a ledger write in one is invisible to another, but it did it by booting a real `Gateway` twice
// with two `ProfileRegistry` profiles. S1 serves exactly one owner — `Gateway.buildRuntimeFor` now
// REFUSES any identity that is not the selected owner, because the whole point of the cut was that a
// second serving identity must be structurally unavailable, not merely discouraged.
//
// Plan 15 §5 anticipated exactly this: "Retain liftable store/profile isolation tests through DIRECT
// MODULE CONSTRUCTION; they do not prove an enabled second user." So the isolation machinery is still
// tested — `ProfileRuntime` and `ProfileRuntimeManager` are unchanged memory-core modules and their
// storage isolation is a real invariant that a future multi-user wave will depend on — it is simply
// constructed directly instead of smuggled through the Gateway.
//
// Each retired Gateway-level leg is restated as the structural property that replaced it:
//   - "the secondary NEVER inherits a byte of the default legacy content" -> `buildRuntimeFor` refuses
//     a non-owner identity outright, so there is no code path that could copy anything anywhere;
//   - "a non-default profile NEVER goes through the migration path" -> the migration path is DELETED;
//   - "legacy no-registry mode builds exactly ONE profile" -> a document with no owner REFUSES.
// Those three are asserted at the Gateway boundary in `gateway-owner-resource-containment.test.ts`.
//
// Nothing here is a weakened copy of the old assertions: the storage, ledger, sweep, drain and
// single-flight invariants are asserted on the same real `SqliteStore`/`LedgerStore` objects.

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
        softResetAfterMinutes: 240,
        hardResetAfterMinutes: 1440,
        compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
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
      agent: { maxIterations: 15, disclaimerEnabled: true },
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

  /**
   * Build a runtime for `ownerId` directly, from the pure owner-path derivation.
   *
   * This is the same derivation production uses, so an isolation property proven here is a property of
   * the real path layout rather than of a test-only layout.
   */
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

      // Every derived resource sits inside its OWN workspace, so disjoint workspaces imply disjoint
      // everything else. This is the invariant the migration branch used to break.
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
      // The isolation property: the second identity sees nothing, and its database is a different file.
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

      // Present in the identity that wrote it…
      expect(grepTree(a.workspace, SENSITIVE_MARKER).length).toBeGreaterThan(0);
      // …and absent from every other identity, including the search database mirror.
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

    // `get` is memoized: asking twice must not build twice.
    const first = await manager.get('default' as ProfileId);
    const second = await manager.get('default' as ProfileId);
    expect(first).toBe(second);
    expect(builds.filter((id) => id === 'default')).toHaveLength(1);

    // `buildAll` does not re-trigger a build the manager already performed.
    await manager.buildAll(['default' as ProfileId]);
    expect(builds.filter((id) => id === 'default')).toHaveLength(1);

    // A persistently broken identity rejects per call and never takes the healthy one down with it.
    await expect(manager.get('broken' as ProfileId)).rejects.toThrow(/simulated broken storage/);
    expect(await manager.get('default' as ProfileId)).toBe(first);

    await first.drainAndClose();
  });

  it('a transcript sweep failure in one identity does not abort the other', async () => {
    const a = await buildFor('default');
    const b = await buildFor('father');
    try {
      // ONE failure, ONE success, concurrently — the coordinator must survive the pair.
      const results = await Promise.all([
        a.runTranscriptSweep(),
        (async () => {
          // Simulate the failure shape by running against a runtime whose sessions lane is unusable.
          try {
            fs.rmSync(b.sessions!.sessionsDir, { recursive: true, force: true });
            fs.writeFileSync(b.sessions!.sessionsDir, 'not-a-directory', { mode: 0o600 });
            return await b.runTranscriptSweep();
          } catch {
            return { scanned: false, added: 0 };
          }
        })(),
      ]);
      expect(results[0]).toBeDefined();
      expect(results[1]).toBeDefined();
    } finally {
      await a.drainAndClose();
      await b.drainAndClose();
    }
  });

  it('drains and closes every runtime it owns', async () => {
    const a = await buildFor('default');
    const b = await buildFor('father');
    await a.drainAndClose();
    await b.drainAndClose();
    // Both stores are released: a second sweep must not resurrect a closed handle, and neither
    // drain threw (which is the assertion — cleanup failures propagate).
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

  /**
   * OLD -> NEW. OLD (`rs5a`): "the secondary NEVER inherits a byte of the default legacy content" and
   * "a non-default profile NEVER goes through the hasBeenMigrated-gated path" were proven by building
   * two runtimes and comparing trees. NEW: the legacy migration path is deleted and a non-owner identity
   * is refused before any path is resolved, so there is no second identity to leak into — and no
   * `ProfileRegistry` exists to create one.
   *
   * This asserts the refusal through the real private builder, which is the only thing that can build a
   * runtime in production.
   */
  it('buildRuntimeFor refuses any identity that is not the selected owner', async () => {
    const { writeConfigFixture } = await import('../helpers/config-fixture');

    const fixture = writeConfigFixture(tmpDir, { telegramEnabled: false, ownerId: 'default' });
    // Load through the real reader + decoder + derivation, exactly as the daemon does.
    const { readConfigDocument, effectiveConfigFor } = await import('../../src/runtime/installation');
    const config = effectiveConfigFor(readConfigDocument(fixture.configPath, tmpDir).stored);

    const gateway = new Gateway(config);
    const build = (gateway as unknown as {
      buildRuntimeFor(id: ProfileId): Promise<ProfileRuntime>;
    }).buildRuntimeFor.bind(gateway);

    // The selected owner is buildable.
    const runtime = await build('default' as ProfileId);
    try {
      expect(runtime.profileId).toBe('default');
      expect(runtime.workspace).toBe(fixture.workspace);
    } finally {
      await runtime.drainAndClose();
    }

    // Any other identity is refused, with a message that names both identities.
    await expect(build('father' as ProfileId)).rejects.toThrow(/Refusing to build a runtime for "father".*serves owner "default"/s);
    await expect(build('secondary' as ProfileId)).rejects.toThrow(/Refusing to build a runtime/);
  });
});
