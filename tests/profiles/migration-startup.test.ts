import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { ProfileRegistry } from '../../src/profiles/registry';
import { HeartbeatStore } from '../../src/scheduler/store';
import { SchedulerAuditLog } from '../../src/scheduler/audit-log';
import type { AppConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';

// Deterministic, network-free memory index (mirrors tests/gateway/gateway-startup.test.ts).
jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

describe('Gateway profile migration + path derivation on startup', () => {
  let tmpDir: string;
  let baseDir: string;
  let legacyWorkspace: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-migration-startup-'));
    baseDir = path.join(tmpDir, 'redacted-home');
    legacyWorkspace = path.join(tmpDir, 'legacy-workspace');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
    return {
      providers: {
        main: { type: 'ollama', model: 'test-model', baseUrl: 'http://localhost:11434/v1' },
        medical: { type: 'ollama', model: 'test-model', baseUrl: 'http://localhost:11434/v1' },
        embeddings: { type: 'ollama', model: 'test-model', baseUrl: 'http://localhost:11434/v1' },
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
          quietHours: { enabled: true, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 60,
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

  // ── Outcome 1 + 2: end-to-end migration on real Gateway.start() ────────

  it('migrates legacy workspace content into profiles/default with real file content, and logs a one-line summary', async () => {
    fs.mkdirSync(legacyWorkspace, { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspace, 'hello.md'), 'world', 'utf8');
    fs.mkdirSync(path.join(legacyWorkspace, 'conditions'), { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspace, 'conditions', 'asthma.md'), 'inhaler daily', 'utf8');

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const gateway = new Gateway(makeConfig());
    await gateway.start();
    await gateway.stop();

    const profileHello = path.join(baseDir, 'profiles', 'default', 'hello.md');
    const profileAsthma = path.join(baseDir, 'profiles', 'default', 'conditions', 'asthma.md');
    expect(fs.readFileSync(profileHello, 'utf8')).toBe('world');
    expect(fs.readFileSync(profileAsthma, 'utf8')).toBe('inhaler daily');

    const summaryLine = logSpy.mock.calls
      .flat()
      .find((c) => typeof c === 'string' && c.includes('Legacy workspace migration: migrated='));
    expect(summaryLine).toMatch(/migrated=\d+ skipped=\d+ errors=0/);

    const registry = new ProfileRegistry(baseDir);
    expect(registry.hasBeenMigrated('default' as ProfileId, legacyWorkspace)).toBe(true);
  });

  it('second boot is a no-op: sentinel prevents re-scanning the legacy workspace', async () => {
    fs.mkdirSync(legacyWorkspace, { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspace, 'hello.md'), 'world', 'utf8');

    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const gatewayA = new Gateway(makeConfig());
    await gatewayA.start();
    await gatewayA.stop();

    const migrateSpy = jest.spyOn(ProfileRegistry.prototype, 'migrateLegacyWorkspace');

    const gatewayB = new Gateway(makeConfig());
    await gatewayB.start();
    await gatewayB.stop();

    expect(migrateSpy).not.toHaveBeenCalled();
  });

  it('falls back to the legacy workspace and warns loudly (without crashing) when migration reports errors', async () => {
    fs.mkdirSync(legacyWorkspace, { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspace, 'hello.md'), 'world', 'utf8');

    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    jest.spyOn(ProfileRegistry.prototype, 'migrateLegacyWorkspace').mockReturnValue({
      migrated: 0,
      skipped: 0,
      errors: ['simulated copy failure: disk full'],
    });

    const gateway = new Gateway(makeConfig());
    await expect(gateway.start()).resolves.toBeUndefined();
    await gateway.stop();

    // Nothing landed in the profile dir; the legacy workspace remains intact and usable.
    expect(fs.existsSync(path.join(baseDir, 'profiles', 'default', 'hello.md'))).toBe(false);
    expect(fs.readFileSync(path.join(legacyWorkspace, 'hello.md'), 'utf8')).toBe('world');

    const warned = warnSpy.mock.calls
      .flat()
      .some((c) => typeof c === 'string' && c.includes('Migration did not complete'));
    expect(warned).toBe(true);
  });

  it('never crashes boot even if ProfileRegistry throws unexpectedly during migration', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    jest.spyOn(ProfileRegistry.prototype, 'hasBeenMigrated').mockImplementation(() => {
      throw new Error('simulated registry corruption');
    });

    const gateway = new Gateway(makeConfig());
    await expect(gateway.start()).resolves.toBeUndefined();
    await gateway.stop();

    const loggedError = errorSpy.mock.calls
      .flat()
      .some((c) => typeof c === 'string' && c.includes('Profile migration failed unexpectedly'));
    expect(loggedError).toBe(true);
  });

  // ── Outcome 2: migrateAndResolveWorkspace decision logic in isolation ──

  describe('migrateAndResolveWorkspace (private decision logic)', () => {
    it('returns the profile workspace once migration completes with zero errors', () => {
      const registry = new ProfileRegistry(baseDir);
      fs.mkdirSync(legacyWorkspace, { recursive: true });
      fs.writeFileSync(path.join(legacyWorkspace, 'a.md'), 'A', 'utf8');
      jest.spyOn(console, 'log').mockImplementation(() => undefined);

      const gateway = new Gateway(makeConfig());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: string = (gateway as any).migrateAndResolveWorkspace(
        registry,
        'default' as ProfileId,
        legacyWorkspace,
      );

      expect(result).toBe(registry.profileWorkspace('default' as ProfileId));
      expect(fs.readFileSync(path.join(result, 'a.md'), 'utf8')).toBe('A');
    });

    it('does not rescan the legacy workspace once the sentinel is present', () => {
      const registry = new ProfileRegistry(baseDir);
      fs.mkdirSync(legacyWorkspace, { recursive: true });
      fs.writeFileSync(path.join(legacyWorkspace, 'a.md'), 'A', 'utf8');
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const gateway = new Gateway(makeConfig());

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).migrateAndResolveWorkspace(registry, 'default' as ProfileId, legacyWorkspace);
      const migrateSpy = jest.spyOn(registry, 'migrateLegacyWorkspace');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const second = (gateway as any).migrateAndResolveWorkspace(registry, 'default' as ProfileId, legacyWorkspace);

      expect(migrateSpy).not.toHaveBeenCalled();
      expect(second).toBe(registry.profileWorkspace('default' as ProfileId));
    });

    it('falls back to the legacy workspace when migration reports errors', () => {
      const registry = new ProfileRegistry(baseDir);
      jest.spyOn(registry, 'migrateLegacyWorkspace').mockReturnValue({ migrated: 0, skipped: 0, errors: ['boom'] });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      jest.spyOn(console, 'log').mockImplementation(() => undefined);

      const gateway = new Gateway(makeConfig());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (gateway as any).migrateAndResolveWorkspace(registry, 'default' as ProfileId, legacyWorkspace);

      expect(result).toBe(legacyWorkspace);
      expect(
        warnSpy.mock.calls.flat().some((c) => typeof c === 'string' && c.includes('encountered 1 error')),
      ).toBe(true);
    });

    it('falls back to the legacy workspace and logs an error when the registry throws unexpectedly', () => {
      const registry = new ProfileRegistry(baseDir);
      jest.spyOn(registry, 'hasBeenMigrated').mockImplementation(() => {
        throw new Error('disk error');
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const gateway = new Gateway(makeConfig());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (gateway as any).migrateAndResolveWorkspace(registry, 'default' as ProfileId, legacyWorkspace);

      expect(result).toBe(legacyWorkspace);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  // ── Outcome 3: SessionManager path derivation ───────────────────────────

  describe('SessionManager path derivation across profiles', () => {
    it('two different profileIds resolve to distinct, non-colliding session directories', () => {
      const registry = new ProfileRegistry(baseDir);
      const a = registry.profileSessions('default' as ProfileId);
      const b = registry.profileSessions('alt-profile' as ProfileId);
      expect(a).not.toBe(b);
      expect(a).toBe(path.join(baseDir, 'profiles', 'default', '.state', 'sessions'));
      expect(b).toBe(path.join(baseDir, 'profiles', 'alt-profile', '.state', 'sessions'));
    });

    it('Gateway.start() derives the sessions path from the profile and persists real turn content there', async () => {
      fs.mkdirSync(legacyWorkspace, { recursive: true });
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      const gateway = new Gateway(makeConfig());
      await gateway.start();

      const expectedSessionsDir = path.join(baseDir, 'profiles', 'default', '.state', 'sessions');
      expect(fs.existsSync(expectedSessionsDir)).toBe(true);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (gateway as any).sessions.recordTurn('chat-xyz', [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]);

      // Wave-D X-2: the thread is per-chat, so the day file lives under a <chatId>/ subdir of the
      // profile's sessions dir (still derived from the profile — the point of this test).
      const dayFile = path.join(expectedSessionsDir, 'chat-xyz', new Date().toISOString().slice(0, 10) + '.jsonl');
      expect(fs.existsSync(dayFile)).toBe(true);
      const lines = fs
        .readFileSync(dayFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0].content).toBe('hello');
      expect(lines[1].content).toBe('hi there');

      await gateway.stop();
    });
  });

  // ── Outcome 4: HeartbeatStore + SchedulerAuditLog path derivation ──────

  describe('resolveSchedulerPaths (private decision logic)', () => {
    it('returns profile-scoped paths under profiles/<id>/.state/ once the migration sentinel is present, and real writes land there', async () => {
      const registry = new ProfileRegistry(baseDir);
      fs.mkdirSync(legacyWorkspace, { recursive: true });
      fs.writeFileSync(path.join(legacyWorkspace, 'note.md'), 'hi', 'utf8');
      const migrationResult = registry.migrateLegacyWorkspace(legacyWorkspace);
      expect(migrationResult.errors).toEqual([]);
      expect(registry.hasBeenMigrated('default' as ProfileId, legacyWorkspace)).toBe(true);

      jest.spyOn(console, 'log').mockImplementation(() => undefined);

      const gateway = new Gateway(makeConfig());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).profileRegistry = registry;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { storePath, auditLogPath } = (gateway as any).resolveSchedulerPaths('default' as ProfileId);

      expect(storePath).toBe(path.join(baseDir, 'profiles', 'default', '.state', 'heartbeat-jobs.json'));
      expect(auditLogPath).toBe(path.join(baseDir, 'profiles', 'default', '.state', 'audit.jsonl'));

      const store = new HeartbeatStore(storePath, 'default');
      const job = await store.create({
        title: 'Morning check-in',
        chatId: 'chat-1',
        cron: '0 8 * * *',
        prompt: 'How are you feeling?',
        source: 'system',
        kind: 'routine',
      });
      expect(fs.existsSync(storePath)).toBe(true);
      const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      expect(raw).toHaveLength(1);
      expect(raw[0].id).toBe(job.id);
      expect(raw[0].title).toBe('Morning check-in');

      const auditLog = new SchedulerAuditLog(auditLogPath, 'default');
      await auditLog.append({ jobId: job.id, chatId: 'chat-1', type: 'triggered', at: new Date().toISOString() });
      expect(fs.existsSync(auditLogPath)).toBe(true);
      const auditRaw = fs
        .readFileSync(auditLogPath, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(auditRaw).toHaveLength(1);
      expect(auditRaw[0].jobId).toBe(job.id);
    });

    it('falls back to legacy heartbeat/audit paths when the migration sentinel is absent', () => {
      const registry = new ProfileRegistry(baseDir); // nothing migrated
      const config = makeConfig();
      const gateway = new Gateway(config);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).profileRegistry = registry;
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { storePath, auditLogPath } = (gateway as any).resolveSchedulerPaths('default' as ProfileId);
      expect(storePath).toBe(config.heartbeat.storePath);
      expect(auditLogPath).toBe(config.heartbeat.audit.path);
    });

    it('returns legacy paths untouched when no ProfileRegistry was constructed at all', () => {
      const config = makeConfig();
      const gateway = new Gateway(config); // profileRegistry stays undefined

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { storePath, auditLogPath } = (gateway as any).resolveSchedulerPaths('default' as ProfileId);
      expect(storePath).toBe(config.heartbeat.storePath);
      expect(auditLogPath).toBe(config.heartbeat.audit.path);
    });

    it('heartbeat/audit paths for two different (migrated) profiles do not collide, and real writes are isolated per profile', async () => {
      const registry = new ProfileRegistry(baseDir);
      jest.spyOn(registry, 'hasBeenMigrated').mockReturnValue(true); // simulate both profiles migrated
      jest.spyOn(console, 'log').mockImplementation(() => undefined);

      const gateway = new Gateway(makeConfig());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).profileRegistry = registry;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pathsA = (gateway as any).resolveSchedulerPaths('default' as ProfileId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pathsB = (gateway as any).resolveSchedulerPaths('alt-profile' as ProfileId);

      expect(pathsA.storePath).not.toBe(pathsB.storePath);
      expect(pathsA.auditLogPath).not.toBe(pathsB.auditLogPath);
      expect(pathsA.storePath).toBe(path.join(baseDir, 'profiles', 'default', '.state', 'heartbeat-jobs.json'));
      expect(pathsB.storePath).toBe(path.join(baseDir, 'profiles', 'alt-profile', '.state', 'heartbeat-jobs.json'));

      const storeA = new HeartbeatStore(pathsA.storePath, 'default');
      const storeB = new HeartbeatStore(pathsB.storePath, 'alt-profile');
      await storeA.create({
        title: 'A job',
        chatId: 'chatA',
        cron: '0 8 * * *',
        prompt: 'p',
        source: 'system',
        kind: 'routine',
      });
      await storeB.create({
        title: 'B job',
        chatId: 'chatB',
        cron: '0 9 * * *',
        prompt: 'p',
        source: 'system',
        kind: 'routine',
      });

      const jobsA = await storeA.list();
      const jobsB = await storeB.list();
      expect(jobsA).toHaveLength(1);
      expect(jobsA[0].title).toBe('A job');
      expect(jobsB).toHaveLength(1);
      expect(jobsB[0].title).toBe('B job');
    });
  });

  // ── Sanity: configs without a `profiles` section keep legacy behavior ──

  it('does not construct a ProfileRegistry or migrate anything when config.profiles is absent', async () => {
    fs.mkdirSync(legacyWorkspace, { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspace, 'hello.md'), 'world', 'utf8');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const config = makeConfig();
    delete config.profiles;

    const gateway = new Gateway(config);
    await gateway.start();
    await gateway.stop();

    expect(fs.existsSync(baseDir)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((gateway as any).profileRegistry).toBeUndefined();
  });
});
