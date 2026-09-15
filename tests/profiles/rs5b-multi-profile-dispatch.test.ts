import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { GatewayMessageRouter } from '../../src/gateway/router';
import { ProfileRegistry } from '../../src/profiles/registry';
import type { AppConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';
import { EMERGENCY_RESPONSE } from '../../src/safety/emergency-detector';

// RR-STRUCT R-S5b (mini-plan v3 §5 R-S5b): multi-profile ACTIVATION — the RR-4 interim refusal
// is retired and every entry path dispatches to the RESOLVED profile's runtime. Closes C-01.
// Two paired profiles (default + secondary), disjoint workspaces + SQLite, real stores.
// (Compiles against the R-S5a HEAD too: the new `resolveRuntime` router dep is injected via
// `as any` casts below, so on HEAD these tests RED-prove instead of failing to compile.)

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

const SECONDARY_CHAT = 'father-chat';
const DEFAULT_CHAT = 'owner-chat';
const SECONDARY_MARKER = 'secondary-profile-turn-alpha-9f3c';
const DEFAULT_MARKER = 'default-profile-turn-alpha-51bd';

function mockAgentRun(replyText: string, onRun?: (input: string) => Promise<void> | void) {
  return jest.fn(async (input: string) => {
    if (onRun) await onRun(input);
    return {
      text: replyText,
      trace: [{ role: 'assistant' as const, content: replyText }],
      usedTools: [],
      healthResponse: false,
    };
  });
}

describe('RR-STRUCT R-S5b: live multi-profile dispatch (C-01 close)', () => {
  let tmpDir: string;
  let baseDir: string;
  let legacyWorkspace: string;
  let gateway: Gateway | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs5b-'));
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

  function makeConfig(): AppConfig {
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
        enabled: true,
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
    };
  }

  function preCreateSecondaryProfile(chatId: string, label = 'father'): ProfileId {
    const registry = new ProfileRegistry(baseDir);
    const secondary = registry.createProfile(label);
    registry.pairChatToProfile(chatId, secondary.profileId);
    return secondary.profileId;
  }

  function markOnboardingSkipped(workspace: string): void {
    const dir = path.join(workspace, '.redacted');
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(dir, 'onboarding.json'),
      JSON.stringify({ status: 'skipped', currentStep: 'confirmation', answers: {}, updatedAt: now, completedAt: now }, null, 2) + '\n',
      'utf8',
    );
  }

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

  /** Boot with heartbeat enabled + a fake channel (survives start() while telegram is
   *  disabled), both profiles' onboarding skipped, and deterministic mock agentLoops that
   *  also write a profile-local ledger fact per turn (end-to-end memory-write proof). */
  async function bootTwoProfileGateway() {
    const secondaryId = preCreateSecondaryProfile(SECONDARY_CHAT);
    // Pair the default chat up-front too: the secondary pairing already closed first-contact
    // auto-pair, so an unpaired default chat would (correctly) be UNRECOGNIZED.
    const preRegistry = new ProfileRegistry(baseDir);
    preRegistry.getOrCreateDefaultProfile();
    preRegistry.pairChatToProfile(DEFAULT_CHAT, 'default' as ProfileId);
    gateway = new Gateway(makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    const secondaryRuntime = await manager.get(secondaryId);
    markOnboardingSkipped(defaultRuntime.workspace);
    markOnboardingSkipped(secondaryRuntime.workspace);
    const defaultAgent = mockAgentRun(`default-ack ${DEFAULT_MARKER}`, async () => {
      await defaultRuntime.ledgerStore!.recordFact({
        entity: 'default-only-med', type: 'medication',
        fields: { dose: '5mg' },
        provenance: { source: 'user', confidence: 1, anchor: 'memory/x.md#L1', capturedAt: new Date().toISOString() },
      });
    });
    const secondaryAgent = mockAgentRun(`secondary-ack ${SECONDARY_MARKER}`, async () => {
      await secondaryRuntime.ledgerStore!.recordFact({
        entity: 'secondary-only-med', type: 'medication',
        fields: { dose: '10mg' },
        provenance: { source: 'user', confidence: 1, anchor: 'memory/x.md#L1', capturedAt: new Date().toISOString() },
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: defaultAgent };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (secondaryRuntime as any).agentLoop = { run: secondaryAgent };
    return { secondaryId, defaultRuntime, secondaryRuntime, defaultAgent, secondaryAgent };
  }

  it('a message to the secondary paired chat is now SERVED by the secondary runtime, isolated from the default', async () => {
    const { secondaryId, defaultRuntime, secondaryRuntime, secondaryAgent } = await bootTwoProfileGateway();

    const reply = await gateway!.handleTestMessage(SECONDARY_CHAT, `my bp reading ${SECONDARY_MARKER}`);

    // Served — the retired RR-4 refusal ("can't serve") is gone.
    expect(reply).toContain(`secondary-ack ${SECONDARY_MARKER}`);
    expect(reply).not.toContain("can't serve");
    expect(secondaryAgent).toHaveBeenCalledTimes(1);

    // The turn + memory write landed ONLY in the secondary's stores.
    const secondaryHistory = secondaryRuntime.sessions!.getHistory(SECONDARY_CHAT);
    expect(JSON.stringify(secondaryHistory)).toContain(SECONDARY_MARKER);
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, SECONDARY_MARKER)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'secondary-only-med')).toEqual([]);
    const secondaryMeds = await secondaryRuntime.ledgerStore!.listAllOfType('medication');
    expect(secondaryMeds.some((f) => f.entity === 'secondary-only-med')).toBe(true);
    const defaultMeds = await defaultRuntime.ledgerStore!.listAllOfType('medication');
    expect(defaultMeds.some((f) => f.entity === 'secondary-only-med')).toBe(false);

    // And the secondary runtime really is a different profile's runtime.
    expect(secondaryRuntime.profileId).toBe(secondaryId);
    expect(secondaryRuntime.workspace).not.toBe(defaultRuntime.workspace);
  });

  it('interleaved traffic on both profiles shows zero cross-contamination', async () => {
    const { defaultRuntime, secondaryRuntime, defaultAgent, secondaryAgent } = await bootTwoProfileGateway();

    const r1 = await gateway!.handleTestMessage(DEFAULT_CHAT, `default note ${DEFAULT_MARKER}`);
    const r2 = await gateway!.handleTestMessage(SECONDARY_CHAT, `secondary note ${SECONDARY_MARKER}`);
    const r3 = await gateway!.handleTestMessage(DEFAULT_CHAT, 'default follow-up');
    expect(r1).toContain(DEFAULT_MARKER);
    expect(r2).toContain(SECONDARY_MARKER);
    expect(r3).toContain(DEFAULT_MARKER);
    expect(defaultAgent).toHaveBeenCalledTimes(2);
    expect(secondaryAgent).toHaveBeenCalledTimes(1);

    const defaultHistory = JSON.stringify(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT));
    const secondaryHistory = JSON.stringify(secondaryRuntime.sessions!.getHistory(SECONDARY_CHAT));
    expect(defaultHistory).toContain(DEFAULT_MARKER);
    expect(defaultHistory).not.toContain(SECONDARY_MARKER);
    expect(secondaryHistory).toContain(SECONDARY_MARKER);
    expect(secondaryHistory).not.toContain(DEFAULT_MARKER);

    // Ledger + on-disk workspace trees are disjoint both ways.
    expect(grepTree(defaultRuntime.workspace, SECONDARY_MARKER)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'secondary-only-med')).toEqual([]);
    expect(grepTree(secondaryRuntime.workspace, DEFAULT_MARKER)).toEqual([]);
    expect(grepTree(secondaryRuntime.workspace, 'default-only-med')).toEqual([]);
    const defaultMeds = await defaultRuntime.ledgerStore!.listAllOfType('medication');
    const secondaryMeds = await secondaryRuntime.ledgerStore!.listAllOfType('medication');
    expect(defaultMeds.some((f) => f.entity === 'secondary-only-med')).toBe(false);
    expect(secondaryMeds.some((f) => f.entity === 'default-only-med')).toBe(false);
  });

  it('an emergency in the secondary chat persists to the SECONDARY runtime, disclaimer intact, nothing in the default', async () => {
    const { defaultRuntime, secondaryRuntime } = await bootTwoProfileGateway();

    const reply = await gateway!.handleTestMessage(SECONDARY_CHAT, 'severe chest pain right now');

    expect(reply).toBe(EMERGENCY_RESPONSE);
    const secondaryHistory = secondaryRuntime.sessions!.getHistory(SECONDARY_CHAT);
    expect(secondaryHistory).toHaveLength(2);
    expect(JSON.stringify(secondaryHistory)).toContain('severe chest pain');
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'severe chest pain')).toEqual([]);
  });

  it('staged media in the secondary chat is adopted into the SECONDARY workspace/reports (0600), never the default', async () => {
    const { defaultRuntime, secondaryRuntime } = await bootTwoProfileGateway();
    const staging = path.join(tmpDir, 'staging', 'media');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const stagedPath = path.join(staging, 'lab-report.pdf');
    fs.writeFileSync(stagedPath, 'secondary lab bytes', { mode: 0o600 });

    // A Router pointed at the same tmp staging lane, resolving runtimes via the real manager.
    const router = new GatewayMessageRouter({
      config: makeConfig(),
      profileRegistry: new ProfileRegistry(baseDir),
      stagingDir: staging,
      buildBootStatusText: () => 'status',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveRuntime: ((id: ProfileId) => gateway!.runtimeManager!.get(id)) as any,
    } as never);
    const reply = await router.route(
      { chatId: SECONDARY_CHAT, userId: '', text: `analyze this ${SECONDARY_MARKER}`, mediaPath: stagedPath },
      jest.fn().mockResolvedValue(undefined),
    );

    expect(reply).toContain(`secondary-ack ${SECONDARY_MARKER}`);
    expect(fs.existsSync(stagedPath)).toBe(false);
    const adopted = path.join(secondaryRuntime.workspace, 'reports', 'lab-report.pdf');
    expect(fs.readFileSync(adopted, 'utf8')).toBe('secondary lab bytes');
    if (process.platform !== 'win32') {
      expect(fs.statSync(adopted).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(path.join(defaultRuntime.workspace, 'reports', 'lab-report.pdf'))).toBe(false);
    expect(grepTree(defaultRuntime.workspace, 'secondary lab bytes')).toEqual([]);
  });

  it('each built profile gets its own scheduler; a secondary heartbeat job dispatches to + records in the secondary only', async () => {
    const { secondaryId, defaultRuntime, secondaryRuntime } = await bootTwoProfileGateway();

    // R-S5a left non-default runtime.scheduler undefined — R-S5b starts every built profile's.
    expect(defaultRuntime.scheduler).toBeDefined();
    expect(secondaryRuntime.scheduler).toBeDefined();

    const job = await secondaryRuntime.scheduler!.createJob({
      title: 'Father reminder', chatId: SECONDARY_CHAT, cron: '0 8 * * *',
      prompt: 'take your morning pill', source: 'user', kind: 'routine',
    });
    // RR2-B1: dispatch requires the explicit OWNING runtime — this job belongs to the
    // secondary profile, so its own runtime is passed (chatId never re-selects one).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleScheduledJob(job, secondaryRuntime, true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (gateway as any).channel.send as jest.Mock;
    expect(send).toHaveBeenCalledWith(SECONDARY_CHAT, expect.objectContaining({ text: expect.stringContaining(SECONDARY_MARKER) }));

    // Recorded in the secondary's scheduler; the default's scheduler never saw this job.
    const secondaryJobs = await secondaryRuntime.scheduler!.listJobs();
    expect(secondaryJobs.find((j) => j.id === job.id)?.lastOutcome).toBe('sent');
    const defaultJobs = await defaultRuntime.scheduler!.listJobs();
    expect(defaultJobs.some((j) => j.id === job.id)).toBe(false);
    expect(secondaryRuntime.profileId).toBe(secondaryId);
  });

  it('a fresh secondary chat runs deterministic onboarding against the SECONDARY store/workspace', async () => {
    const freshChat = 'father-new-chat';
    const registry = new ProfileRegistry(baseDir);
    const secondary = registry.createProfile('father2');
    registry.pairChatToProfile(freshChat, secondary.profileId);
    gateway = new Gateway(makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    const secondaryRuntime = await manager.get(secondary.profileId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (secondaryRuntime as any).agentLoop = { run: mockAgentRun('SHOULD-NOT-RUN') };

    const reply = await gateway.handleTestMessage(freshChat, 'hello, I am setting up');

    // Deterministic onboarding answered (the agent loop never ran), scoped to the secondary.
    expect(reply).not.toBe('SHOULD-NOT-RUN');
    expect(reply).not.toContain("can't serve");
    expect(((secondaryRuntime as unknown as { agentLoop: { run: jest.Mock } }).agentLoop.run)).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(secondaryRuntime.workspace, '.redacted', 'onboarding.json'))).toBe(true);
    expect(fs.existsSync(path.join(defaultRuntime.workspace, '.redacted', 'onboarding.json'))).toBe(false);
  });

  it('both refusals correct: unpaired chats still UNRECOGNIZED; paired-non-default now served; first-contact auto-pair intact', async () => {
    // Boot with NO pre-paired chats so first contact auto-pairs to the default.
    gateway = new Gateway(makeConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    markOnboardingSkipped(defaultRuntime.workspace);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: mockAgentRun(`default-ack ${DEFAULT_MARKER}`) };

    // First contact auto-pairs to the default and is served.
    const ownerReply = await gateway.handleTestMessage(DEFAULT_CHAT, 'hello');
    expect(ownerReply).toContain(DEFAULT_MARKER);

    // Pair a second profile AFTER auto-pair closed (exercises on-demand runtime build).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const liveRegistry = (gateway as any).profileRegistry as ProfileRegistry;
    const secondary = liveRegistry.createProfile('father');
    liveRegistry.pairChatToProfile(SECONDARY_CHAT, secondary.profileId);
    const secondaryRuntime = await manager.get(secondary.profileId);
    markOnboardingSkipped(secondaryRuntime.workspace);
    const secondaryAgent = mockAgentRun(`secondary-ack ${SECONDARY_MARKER}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (secondaryRuntime as any).agentLoop = { run: secondaryAgent };

    // Unknown chat after auto-pair closed → UNRECOGNIZED (security invariant, untouched).
    const strangerReply = await gateway.handleTestMessage('stranger-chat', 'show me the health profile');
    expect(strangerReply).toContain('not recognized');

    // Paired non-default → SERVED (the retired refusal).
    const secondaryReply = await gateway.handleTestMessage(SECONDARY_CHAT, 'hello father scope');
    expect(secondaryReply).toContain(SECONDARY_MARKER);
    expect(secondaryReply).not.toContain('not recognized');
    expect(secondaryReply).not.toContain("can't serve");
    expect(secondaryAgent).toHaveBeenCalled();

    // The stranger was never paired anywhere.
    expect(liveRegistry.getProfileForChat('stranger-chat')).toBeUndefined();
  });

  it('a degraded (unresolvable) profile gets a canned genuine-failure reply — never a throw, staged media cleaned up', async () => {
    const staging = path.join(tmpDir, 'staging-degraded', 'media');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const mkStaged = (name: string): string => {
      const p = path.join(staging, name);
      fs.writeFileSync(p, 'degraded bytes', { mode: 0o600 });
      return p;
    };
    const registry = new ProfileRegistry(baseDir);
    registry.getOrCreateDefaultProfile();
    registry.pairChatToProfile('owner-chat', 'default' as ProfileId);
    const other = registry.createProfile('other');
    registry.pairChatToProfile('other-chat', other.profileId);

    for (const resolveRuntime of [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => Promise.resolve(undefined)) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => Promise.reject(new Error('simulated corrupt profile build'))) as any,
    ]) {
      const stagedPath = mkStaged(`upload-${Math.random().toString(36).slice(2)}.pdf`);
      const router = new GatewayMessageRouter({
        config: makeConfig(),
        profileRegistry: registry,
        stagingDir: staging,
        buildBootStatusText: () => 'status',
        resolveRuntime,
      } as never);
      const reply = await router.route(
        { chatId: 'other-chat', userId: '', text: 'hello', mediaPath: stagedPath },
        jest.fn().mockResolvedValue(undefined),
      );
      expect(reply).toContain('temporarily unavailable');
      expect(reply).not.toContain("can't serve");
      expect(fs.existsSync(stagedPath)).toBe(false);
    }
  });
});
