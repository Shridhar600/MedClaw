import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { ProfileRegistry } from '../../src/profiles/registry';
import { ProfileRuntime } from '../../src/gateway/runtime';
import type { AppConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';

// RR-STRUCT R-S5a (mini-plan v3 §3.3 + §3.8): ProfileRuntimeManager + entry-path isolation.
// Dispatch STAYS default-only this slice (RR-4 refusal intact) — these tests prove the multi-
// profile RUNTIME machinery is isolated and correct, exercised via TEST configs only (no product
// path to create a 2nd profile yet — P6 is out of scope).

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

const SENSITIVE_MARKER = 'default-user-secret-diagnosis-stage-3-CKD';

describe('RR-STRUCT R-S5a: ProfileRuntimeManager entry-path isolation', () => {
  let tmpDir: string;
  let baseDir: string;
  let legacyWorkspace: string;
  let gateway: Gateway | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs5a-'));
    baseDir = path.join(tmpDir, 'redacted-home');
    legacyWorkspace = path.join(tmpDir, 'legacy-workspace');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* cleanup must not mask the assertion */ }
    gateway = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
    return {
      providers: {
        main: { type: 'ollama', model: 'test-model', baseUrl: 'http://127.0.0.1:9/v1' },
        medical: { type: 'ollama', model: 'test-model', baseUrl: 'http://127.0.0.1:9/v1' },
        embeddings: { type: 'ollama', model: 'test-model', baseUrl: 'http://127.0.0.1:9/v1' },
      },
      channels: { telegram: { enabled: false, botToken: '' } },
      tools: { allow: ['*'], deny: [] },
      memory: {
        workspace: legacyWorkspace,
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
        storePath: path.join(tmpDir, 'legacy-heartbeats', 'jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'legacy-heartbeats', 'audit.jsonl') },
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
      profiles: { baseDir, defaultProfileId: 'default' },
      ...overrides,
    };
  }

  function seedLegacyContent(): void {
    fs.mkdirSync(legacyWorkspace, { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspace, 'SOUL.md'), SENSITIVE_MARKER, 'utf8');
    const legacySessions = path.join(tmpDir, 'sessions');
    fs.mkdirSync(legacySessions, { recursive: true });
    fs.writeFileSync(
      path.join(legacySessions, 'active-legacy-chat.jsonl'),
      JSON.stringify({
        timestamp: '2026-08-26T10:00:00.000Z',
        role: 'user',
        content: `pre-cutover: ${SENSITIVE_MARKER}`,
        chatId: 'legacy-chat',
      }) + '\n',
      'utf8',
    );
  }

  /** Recursively grep every file under `dir` for `needle`; returns matching relative paths. */
  function grepTree(dir: string, needle: string): string[] {
    const hits: string[] = [];
    if (!fs.existsSync(dir)) return hits;
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile()) continue;
        try {
          if (fs.readFileSync(full, 'utf8').includes(needle)) hits.push(path.relative(dir, full));
        } catch { /* unreadable file — not a match */ }
      }
    };
    walk(dir);
    return hits;
  }

  function preCreateSecondaryProfile(chatId: string, label = 'father'): ProfileId {
    const registry = new ProfileRegistry(baseDir);
    const secondary = registry.createProfile(label);
    registry.pairChatToProfile(chatId, secondary.profileId);
    return secondary.profileId;
  }

  // ── Part A+B: cross-profile isolation, migration restricted to default (SAFETY-CRITICAL) ──

  it('builds disjoint runtimes for two paired profiles; the secondary NEVER inherits a byte of the default legacy content', async () => {
    seedLegacyContent();
    const secondaryId = preCreateSecondaryProfile('father-chat');

    gateway = new Gateway(makeConfig());
    await gateway.start();

    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    const secondaryRuntime = await manager.get(secondaryId);

    // Disjoint paths — total isolation (PD-1).
    expect(defaultRuntime.workspace).not.toBe(secondaryRuntime.workspace);
    expect(defaultRuntime).not.toBe(secondaryRuntime);
    expect(defaultRuntime.store).not.toBe(secondaryRuntime.store);

    // The default DID inherit the legacy content (unchanged existing behavior).
    expect(fs.readFileSync(path.join(defaultRuntime.workspace, 'SOUL.md'), 'utf8')).toContain(SENSITIVE_MARKER);

    // The secondary bootstrapped CLEAN: its entire workspace + .state tree contains not a byte
    // of the sensitive legacy marker (F-04 — the design review's reproduced leak).
    expect(grepTree(secondaryRuntime.workspace, SENSITIVE_MARKER)).toEqual([]);
    // And it got the generic TEMPLATE SOUL.md (not the default's copied-in legacy one).
    const secondarySoul = path.join(secondaryRuntime.workspace, 'SOUL.md');
    expect(fs.existsSync(secondarySoul)).toBe(true);
    expect(fs.readFileSync(secondarySoul, 'utf8')).not.toContain(SENSITIVE_MARKER);

    // Session dirs are disjoint and the secondary's has no imported legacy session rows.
    const registry = new ProfileRegistry(baseDir);
    const secondarySessionsDir = registry.profileSessions(secondaryId);
    expect(secondaryRuntime.sessions!.sessionsDir).toBe(secondarySessionsDir);
    expect(secondaryRuntime.sessions!.sessionsDir).not.toBe(defaultRuntime.sessions!.sessionsDir);
    expect(grepTree(secondarySessionsDir, SENSITIVE_MARKER)).toEqual([]);
    expect(grepTree(secondarySessionsDir, 'legacy-chat')).toEqual([]);

    // dbPath / scheduler paths also disjoint, resolved DIRECTLY from the registry for the
    // secondary (no hasBeenMigrated gate, no legacy fallback).
    expect(registry.profileSearchDb(secondaryId)).not.toBe(registry.profileSearchDb('default' as ProfileId));
  });

  it('LEAK PROOF (F-04): the shared default-profile migration path WOULD copy legacy content into any profileId — this is exactly why buildRuntimeFor must never call it for a non-default profile', async () => {
    seedLegacyContent();
    const secondaryId = preCreateSecondaryProfile('father-chat');
    gateway = new Gateway(makeConfig());
    const registry = new ProfileRegistry(baseDir);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: string = (gateway as any).migrateAndResolveWorkspace(registry, secondaryId, legacyWorkspace);

    // Calling the DEFAULT-only migration primitive against a non-default id DOES leak — proving
    // the hazard is real and confirming buildRuntimeFor's branch-by-profileId guard is load-bearing.
    expect(fs.readFileSync(path.join(result, 'SOUL.md'), 'utf8')).toContain(SENSITIVE_MARKER);
  });

  it('a broken secondary profile degrades only that profile; boot continues and the default is unaffected', async () => {
    seedLegacyContent();
    const secondaryId = preCreateSecondaryProfile('father-chat');
    gateway = new Gateway(makeConfig());

    const registry = ProfileRegistry.prototype;
    const originalProfileSearchDb = registry.profileSearchDb;
    jest.spyOn(registry, 'profileSearchDb').mockImplementation(function (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this: any, id: ProfileId,
    ) {
      if (id === secondaryId) throw new Error('simulated corrupt profile directory');
      return originalProfileSearchDb.call(this, id);
    });

    await expect(gateway.start()).resolves.toBeUndefined();

    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    expect(defaultRuntime).toBeDefined();
    expect(manager.all().map((r: { profileId: string }) => r.profileId)).toContain('default');
    expect(manager.all().map((r: { profileId: string }) => r.profileId)).not.toContain(secondaryId);

    const loggedSanitized = (console.error as jest.Mock).mock.calls
      .flat()
      .some((c) => typeof c === 'string' && c.includes(secondaryId) && c.includes('degraded'));
    expect(loggedSanitized).toBe(true);
  });

  it('legacy no-registry mode still builds exactly ONE (default) profile via the manager (A-F11)', async () => {
    const config = makeConfig();
    delete config.profiles;
    gateway = new Gateway(config);

    await gateway.start();

    const manager = gateway.runtimeManager!;
    expect(manager.all()).toHaveLength(1);
    expect(manager.all()[0].profileId).toBe('default');
  });

  // ── Part D (RR-STRUCT R-S5b): the RR-4 refusal is RETIRED — dispatch is live. ──────
  // The two tests that pinned the interim refusal ("still refused" message dispatch +
  // "still skips" scheduled-job dispatch) are REPLACED by "now served / now dispatched"
  // tests in tests/profiles/rs5b-multi-profile-dispatch.test.ts, assertion-for-assertion:
  //   "can't serve" reply + empty secondary history
  //     → served-by-secondary reply + history/memory ONLY in the secondary
  //       ("a message to the secondary paired chat is now SERVED ...");
  //   handleScheduledJob resolves without dispatching
  //     → job dispatches to + records in the secondary only
  //       ("each built profile gets its own scheduler ...").
  // Everything else in this file (entry-path isolation machinery) is unchanged.

  // ── Part C: nightly sweep coordinator ──────────────────────────────────────────────────────

  it('sweeps every built profile independently; one profile sweep failure does not abort the other', async () => {
    seedLegacyContent();
    const secondaryId = preCreateSecondaryProfile('father-chat');
    gateway = new Gateway(makeConfig());
    await gateway.start();

    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    const secondaryRuntime = await manager.get(secondaryId);

    const defaultSpy = jest.spyOn(defaultRuntime, 'runTranscriptSweep').mockResolvedValue({ scanned: true, added: 2 });
    const secondarySpy = jest.spyOn(secondaryRuntime, 'runTranscriptSweep').mockRejectedValue(new Error('secondary ledger unreadable'));

    // Gateway.runTranscriptSweep() keeps its EXISTING external contract: returns the DEFAULT
    // profile's result (byte-identical shape for the single/default-profile test surface).
    const result = await gateway.runTranscriptSweep();
    expect(result).toEqual({ scanned: true, added: 2 });

    // But BOTH profiles were actually swept — the secondary's failure did not prevent the
    // default's sweep from running or from its result being returned.
    expect(defaultSpy).toHaveBeenCalledTimes(1);
    expect(secondarySpy).toHaveBeenCalledTimes(1);
  });

  // ── Lifecycle: drainAndCloseAll closes every built profile, not just the default ────────────

  it('gateway.stop() drains and closes BOTH the default and secondary runtimes', async () => {
    seedLegacyContent();
    const secondaryId = preCreateSecondaryProfile('father-chat');
    gateway = new Gateway(makeConfig());
    await gateway.start();

    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    const secondaryRuntime = await manager.get(secondaryId);
    expect(defaultRuntime.isClosed()).toBe(false);
    expect(secondaryRuntime.isClosed()).toBe(false);

    await gateway.stop();

    expect(defaultRuntime.isClosed()).toBe(true);
    expect(secondaryRuntime.isClosed()).toBe(true);
  });

  // ── Extra hunt: total data-write isolation across REAL SQLite-backed stores (PD-1 core proof) ──

  it('a ledger write in profile A is completely invisible to profile B (real SqliteStore/LedgerStore, PD-1)', async () => {
    seedLegacyContent();
    const secondaryId = preCreateSecondaryProfile('father-chat');
    gateway = new Gateway(makeConfig());
    await gateway.start();

    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    const secondaryRuntime = await manager.get(secondaryId);

    await defaultRuntime.ledgerStore!.recordFact({
      entity: 'lisinopril',
      type: 'medication',
      fields: { dose: '10mg' },
      provenance: { source: 'user', confidence: 1, anchor: 'memory/x.md#L1', capturedAt: new Date().toISOString() },
    });

    const defaultFacts = await defaultRuntime.ledgerStore!.listAllOfType('medication');
    expect(defaultFacts.some((f) => f.entity === 'lisinopril')).toBe(true);

    const secondaryFacts = await secondaryRuntime.ledgerStore!.listAllOfType('medication');
    expect(secondaryFacts.some((f) => f.entity === 'lisinopril')).toBe(false);
    expect(secondaryFacts).toEqual([]);

    // The on-disk ledger markdown itself is also disjoint — no cross-profile file sharing.
    expect(grepTree(secondaryRuntime.workspace, 'lisinopril')).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'lisinopril').length).toBeGreaterThan(0);
  });

  // ── Extra hunt: default profile is built exactly ONCE despite buildAll also listing it ──────

  it('the default profile is built exactly once (buildAll never re-triggers a second real build)', async () => {
    seedLegacyContent();
    preCreateSecondaryProfile('father-chat');
    const createSpy = jest.spyOn(ProfileRuntime, 'create');

    gateway = new Gateway(makeConfig());
    await gateway.start();

    const defaultCalls = createSpy.mock.calls.filter((args) => args[0].profileId === 'default');
    expect(defaultCalls).toHaveLength(1);
  });

  // ── Extra hunt: non-default scheduler paths bypass the hasBeenMigrated gate entirely ─────────

  it('a non-default profile NEVER goes through resolveSchedulerPaths (the hasBeenMigrated-gated helper) — only the default does', async () => {
    seedLegacyContent();
    const secondaryId = preCreateSecondaryProfile('father-chat');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolveSpy = jest.spyOn(Gateway.prototype as any, 'resolveSchedulerPaths');
    gateway = new Gateway(makeConfig());

    await gateway.start();
    await gateway.runtimeManager!.get(secondaryId);

    const calledWith = resolveSpy.mock.calls.map((args) => args[0]);
    expect(calledWith).toContain('default');
    expect(calledWith).not.toContain(secondaryId);

    // And its scheduler paths, resolved DIRECTLY, are the profile-scoped ones regardless of
    // migration-sentinel state (no `hasBeenMigrated` gate, no legacy fallback for a secondary).
    const registry = new ProfileRegistry(baseDir);
    const expectedStore = registry.profileSchedulerStore(secondaryId);
    expect(expectedStore).not.toBe((gateway as unknown as { config: AppConfig }).config.heartbeat.storePath);
  });

  // ── Extra hunt: N>2 profiles build in parallel without serializing/deadlocking ───────────────

  it('three profiles (default + two secondaries) all build successfully with pairwise-disjoint storage', async () => {
    seedLegacyContent();
    const fatherId = preCreateSecondaryProfile('father-chat', 'father');
    const motherId = preCreateSecondaryProfile('mother-chat', 'mother');
    gateway = new Gateway(makeConfig());

    await gateway.start();

    const manager = gateway.runtimeManager!;
    expect(manager.all()).toHaveLength(3);
    const defaultRuntime = await manager.get('default' as ProfileId);
    const fatherRuntime = await manager.get(fatherId);
    const motherRuntime = await manager.get(motherId);

    const workspaces = [defaultRuntime.workspace, fatherRuntime.workspace, motherRuntime.workspace];
    expect(new Set(workspaces).size).toBe(3);
    expect(grepTree(fatherRuntime.workspace, SENSITIVE_MARKER)).toEqual([]);
    expect(grepTree(motherRuntime.workspace, SENSITIVE_MARKER)).toEqual([]);
  });

  // ── Extra hunt: 0600/0700 hardening holds for a freshly-bootstrapped non-default workspace ────

  it('a freshly-bootstrapped secondary profile workspace is hardened (dir 0700, files 0600)', async () => {
    if (process.platform === 'win32') return; // POSIX permission bits only
    seedLegacyContent();
    const secondaryId = preCreateSecondaryProfile('father-chat');
    gateway = new Gateway(makeConfig());
    await gateway.start();

    const secondaryRuntime = await gateway.runtimeManager!.get(secondaryId);
    const dirMode = fs.statSync(secondaryRuntime.workspace).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const soulMode = fs.statSync(path.join(secondaryRuntime.workspace, 'SOUL.md')).mode & 0o777;
    expect(soulMode).toBe(0o600);
  });
});
