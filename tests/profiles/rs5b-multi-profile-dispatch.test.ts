import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { GatewayMessageRouter } from '../../src/gateway/router';
import { ProfileRegistry } from '../../src/profiles/registry';
import type { EffectiveConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';
import { EMERGENCY_RESPONSE } from '../../src/safety/emergency-detector';
import {} from '../helpers/test-config';
import { bindOwnerFixture } from '../helpers/owner-authority-fixture';

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

  function makeConfig(): EffectiveConfig {
    return {
    schemaVersion: 2,
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

  /**
   * OLD -> NEW: built `await boundGateway(baseDir)` with no admission, so under S1 the destination guard failed
   * closed. Binding a real owner keeps the assertions on the authority production uses.
   */
  async function boundGateway(root: string): Promise<Gateway> {
    // This suite drives the Gateway through `handleTestMessage`, which presents `channel: 'local'`,
    // `userId: 'local'`. Admission compares the WHOLE identity against the binding, so the owner must be
    // bound over the same transport or even its own messages are correctly refused.
    const bound = await bindOwnerFixture(
      path.join(root, 'profiles', 'default', '.state', 'owner-access.json'),
      'default',
      DEFAULT_CHAT,
      { channel: 'local', userId: 'local' },
    );
    return new Gateway(makeConfig(), bound.gatewayDeps);
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
    gateway = await boundGateway(baseDir);
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

  it('OLD->NEW a message to the secondary paired chat is REFUSED and reaches neither runtime', async () => {
    // OLD -> NEW (S1 containment). This asserted a message to the secondary chat is SERVED by the
    // secondary runtime. Secondary activation is parked (`BACKLOG.md:30` "Deferred, never passed… S1 must
    // prove secondary addresses/runtime/jobs unavailable without harming the owner"), so that is precisely
    // the capability S1 removes. The ISOLATION invariant is preserved and is now stronger: it is proved by
    // nothing crossing, rather than by both sides working.
    // Per plan 15 §5, these assertions were mapped to containment, not skipped or deleted.
    const { secondaryId, defaultRuntime, secondaryRuntime, defaultAgent, secondaryAgent } = await bootTwoProfileGateway();

    const reply = await gateway!.handleTestMessage(SECONDARY_CHAT, `my bp reading ${SECONDARY_MARKER}`);

    // Refused by admission: the chat is not the bound owner destination.
    expect(reply).toMatch(/not connected to this assistant/i);
    // And no model was invoked on EITHER runtime for it.
    expect(secondaryAgent).not.toHaveBeenCalled();
    expect(defaultAgent).not.toHaveBeenCalled();

    // Nothing was captured anywhere.
    const secondaryHistory = secondaryRuntime.sessions!.getHistory(SECONDARY_CHAT);
    expect(secondaryHistory).toEqual([]);
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, SECONDARY_MARKER)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'secondary-only-med')).toEqual([]);
    // OLD -> NEW: previously the served turn captured a medication into the SECONDARY ledger, proving the
    // ledgers were disjoint. With the turn refused there is nothing to capture, so disjointness is proved
    // the only way it can be: NEITHER ledger received anything. Strictly stronger than before.
    const secondaryMeds = await secondaryRuntime.ledgerStore!.listAllOfType('medication');
    expect(secondaryMeds.some((f) => f.entity === 'secondary-only-med')).toBe(false);
    const defaultMeds = await defaultRuntime.ledgerStore!.listAllOfType('medication');
    expect(defaultMeds.some((f) => f.entity === 'secondary-only-med')).toBe(false);
    // The ledgers are still genuinely separate stores, not one aliased store.
    expect(secondaryRuntime.ledgerStore).not.toBe(defaultRuntime.ledgerStore);

    // And the secondary runtime really is a different profile's runtime.
    expect(secondaryRuntime.profileId).toBe(secondaryId);
    expect(secondaryRuntime.workspace).not.toBe(defaultRuntime.workspace);
  });

  it('OLD->NEW interleaved traffic: the owner is served, the secondary chat is refused, zero cross-contamination', async () => {
    // OLD -> NEW: previously both profiles were served and the test proved they stayed disjoint. S1 parks
    // secondary activation, so the same disjointness is now proved the only way it can be: the owner is
    // served and the secondary chat leaves no trace in EITHER runtime.
    const { defaultRuntime, secondaryRuntime, defaultAgent, secondaryAgent } = await bootTwoProfileGateway();

    const r1 = await gateway!.handleTestMessage(DEFAULT_CHAT, `default note ${DEFAULT_MARKER}`);
    const r2 = await gateway!.handleTestMessage(SECONDARY_CHAT, `secondary note ${SECONDARY_MARKER}`);
    const r3 = await gateway!.handleTestMessage(DEFAULT_CHAT, 'default follow-up');
    expect(r1).toContain(DEFAULT_MARKER);
    expect(r2).toMatch(/not connected to this assistant/i);
    expect(r3).toContain(DEFAULT_MARKER);
    expect(defaultAgent).toHaveBeenCalledTimes(2);
    // The secondary runtime is never invoked at all.
    expect(secondaryAgent).not.toHaveBeenCalled();

    const defaultHistory = JSON.stringify(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT));
    const secondaryHistory = JSON.stringify(secondaryRuntime.sessions!.getHistory(SECONDARY_CHAT));
    expect(defaultHistory).toContain(DEFAULT_MARKER);
    expect(defaultHistory).not.toContain(SECONDARY_MARKER);
    // The refused chat produced no secondary history at all.
    expect(secondaryHistory).not.toContain(DEFAULT_MARKER);
    expect(secondaryRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);

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

  it('OLD->NEW an emergency in an UNBOUND chat is refused and persisted nowhere', async () => {
    // OLD -> NEW: previously an emergency in the secondary chat produced the canned EMERGENCY_RESPONSE and
    // was recorded in the SECONDARY session. S1 refuses an unbound chat at admission, BEFORE the emergency
    // check. That ordering is a FOUNDER DECISION (2026-10-03): Shridhar is the only user of this system,
    // multi-profile is parked, and no crisis guidance or rate limiting is wanted for unauthorized senders.
    //
    // The safety property that still matters is asserted here and is unchanged: the OWNER's own emergency
    // text IS answered and recorded (covered by the owner-admission routing suite). What this test now
    // proves is that an unauthorized chat cannot cause a persisted clinical trace in EITHER runtime.
    const { defaultRuntime, secondaryRuntime } = await bootTwoProfileGateway();

    const reply = await gateway!.handleTestMessage(SECONDARY_CHAT, 'severe chest pain right now');

    expect(reply).toMatch(/not connected to this assistant/i);
    expect(reply).not.toBe(EMERGENCY_RESPONSE);
    // Nothing persisted in either runtime, and no health text reached the owner's workspace.
    expect(secondaryRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'severe chest pain')).toEqual([]);
    expect(grepTree(secondaryRuntime.workspace, 'severe chest pain')).toEqual([]);
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

    // OLD -> NEW: previously this CREATED a heartbeat job for the secondary chat and dispatched it there.
    // Under S1 the destination guard authorizes exactly one chat, so job CREATION for any other chat is
    // refused up front rather than silently suppressed at dispatch. Asserting the refusal is the containment
    // proof `BACKLOG.md:66` asks for: unavailable proven, not declared.
    await expect(secondaryRuntime.scheduler!.createJob({
      title: 'Father reminder', chatId: SECONDARY_CHAT, cron: '0 8 * * *',
      prompt: 'take your morning pill', source: 'user', kind: 'routine',
    })).rejects.toThrow(/does not own/i);

    // And nothing was recorded in either scheduler.
    expect(await secondaryRuntime.scheduler!.listJobs()).toEqual([]);
    expect(await defaultRuntime.scheduler!.listJobs()).toEqual([]);
    // The two runtimes really are distinct profiles with distinct stores.
    expect(secondaryRuntime.profileId).toBe(secondaryId);
  });

  it('OLD->NEW a fresh secondary chat is refused: no onboarding, no agent, no store writes', async () => {
    // OLD -> NEW: previously a fresh secondary chat ran deterministic onboarding scoped to the SECONDARY
    // workspace. Secondary activation is parked, so an unbound chat is refused at admission instead. The
    // containment is asserted directly: no onboarding file, no agent call, nothing written to either
    // workspace. Stronger than the original, which only proved scoping.
    const freshChat = 'father-new-chat';
    const registry = new ProfileRegistry(baseDir);
    const secondary = registry.createProfile('father2');
    registry.pairChatToProfile(freshChat, secondary.profileId);
    gateway = await boundGateway(baseDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    const secondaryRuntime = await manager.get(secondary.profileId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (secondaryRuntime as any).agentLoop = { run: mockAgentRun('SHOULD-NOT-RUN') };

    const reply = await gateway.handleTestMessage(freshChat, 'hello, I am setting up');

    // Refused by admission, and nothing ran or was written anywhere.
    expect(reply).toMatch(/not connected to this assistant/i);
    expect(reply).not.toBe('SHOULD-NOT-RUN');
    expect(((secondaryRuntime as unknown as { agentLoop: { run: jest.Mock } }).agentLoop.run)).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(secondaryRuntime.workspace, '.redacted', 'onboarding.json'))).toBe(false);
    expect(fs.existsSync(path.join(defaultRuntime.workspace, '.redacted', 'onboarding.json'))).toBe(false);
  });

  it('OLD->NEW an unknown chat is refused and a registry-paired non-default is ALSO refused', async () => {
    // OLD -> NEW, and this test's TITLE previously documented the S1 DEFECT as intended behaviour:
    // "first-contact auto-pair intact". First contact auto-pairing is the exact defect this wave removes —
    // a stranger's first DM was auto-paired into the owner's profile and answered clinically. The owner is
    // bound here through a REAL owner record, so there is no auto-pair path left to exercise.
    //
    // What is asserted now: the bound owner is served; an unknown chat is refused by ADMISSION (which now
    // runs before the legacy UNRECOGNIZED router path); and a chat paired only in the legacy registry is
    // ALSO refused, because `profiles.json` is no longer authorization.
    gateway = await boundGateway(baseDir);
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

    // Unknown chat → refused by admission (which runs before the legacy UNRECOGNIZED router path, so the
    // refusal is now admission's rather than the router's).
    const strangerReply = await gateway.handleTestMessage('stranger-chat', 'show me the health profile');
    expect(strangerReply).toMatch(/not connected to this assistant/i);

    // OLD -> NEW: was "paired non-default → SERVED (the retired refusal)". A chat paired only in the legacy
    // registry is now REFUSED, because `profiles.json` is not authorization under S1 — the owner record is.
    // This is the containment `BACKLOG.md:66` requires: proven unavailable, not merely declared so.
    const secondaryReply = await gateway.handleTestMessage(SECONDARY_CHAT, 'hello father scope');
    expect(secondaryReply).toMatch(/not connected to this assistant/i);
    expect(secondaryReply).not.toContain(SECONDARY_MARKER);
    expect(secondaryAgent).not.toHaveBeenCalled();

    // The stranger was never paired anywhere, and the registry pairing bought nothing.
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
