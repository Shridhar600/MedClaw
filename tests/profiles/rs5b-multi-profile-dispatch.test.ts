import * as fs from 'fs';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { GatewayMessageRouter } from '../../src/gateway/router';
import type { EffectiveConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';
import { EMERGENCY_RESPONSE } from '../../src/safety/emergency-detector';
import {} from '../helpers/test-config';
import { bindOwnerFixture } from '../helpers/owner-authority-fixture';
import { makeTestTemp } from '../helpers/test-temp';

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
    tmpDir = makeTestTemp('redacted-rs5b-');
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

  /**
   * Boot the real Gateway for the ONE selected owner, bound at `DEFAULT_CHAT` through the real
   * enrollment state machine, with a deterministic agent double that also writes a ledger fact per turn
   * (so an end-to-end memory-write proof survives).
   *
   * OLD -> NEW: this booted TWO real profiles through `ProfileRegistry`. S1 serves one owner and
   * `buildRuntimeFor` now refuses any other identity, so there is no second runtime to boot. The chat
   * that used to be the secondary's is now simply a chat the owner record does not bind — which is the
   * same question the containment assertions were already asking after the earlier S1 pass.
   */
  async function bootOwnerGateway() {
    gateway = await boundGateway(baseDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const defaultRuntime = await gateway.runtimeManager!.get('default' as ProfileId);
    markOnboardingSkipped(defaultRuntime.workspace);
    const defaultAgent = mockAgentRun(`default-ack ${DEFAULT_MARKER}`, async () => {
      await defaultRuntime.ledgerStore!.recordFact({
        entity: 'default-only-med', type: 'medication',
        fields: { dose: '5mg' },
        provenance: { source: 'user', confidence: 1, anchor: 'memory/x.md#L1', capturedAt: new Date().toISOString() },
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: defaultAgent };
    return { defaultRuntime, defaultAgent };
  }

  it('OLD->NEW a message from an UNBOUND chat is REFUSED and reaches no runtime at all', async () => {
    // OLD -> NEW (S1 containment). This asserted a message to the secondary chat is SERVED by the
    // secondary runtime. Secondary activation is parked (`BACKLOG.md:30` "Deferred, never passed… S1 must
    // prove secondary addresses/runtime/jobs unavailable without harming the owner"), so that is precisely
    // the capability S1 removes. The ISOLATION invariant is preserved and is now stronger: it is proved by
    // nothing crossing, rather than by both sides working.
    //
    // FURTHER S1 CHANGE: the second runtime no longer exists at all (`buildRuntimeFor` refuses any identity
    // that is not the selected owner), so the "the two ledgers are separate stores" leg is replaced by the
    // only meaningful form left — the ONE ledger received nothing. That is strictly stronger than
    // "neither of two ledgers received it".
    const { defaultRuntime, defaultAgent } = await bootOwnerGateway();

    const reply = await gateway!.handleTestMessage(SECONDARY_CHAT, `my bp reading ${SECONDARY_MARKER}`);

    // Refused by admission: the chat is not the bound owner destination.
    expect(reply).toMatch(/not connected to this assistant/i);
    // And no model was invoked for it.
    expect(defaultAgent).not.toHaveBeenCalled();

    // Nothing was captured anywhere.
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, SECONDARY_MARKER)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'secondary-only-med')).toEqual([]);
    const meds = await defaultRuntime.ledgerStore!.listAllOfType('medication');
    expect(meds.some((f) => f.entity === 'secondary-only-med')).toBe(false);
    expect(meds).toEqual([]);
  });

  it('OLD->NEW interleaved traffic: the owner is served, the unbound chat is refused, zero cross-contamination', async () => {
    // OLD -> NEW: previously both profiles were served and the test proved they stayed disjoint. S1 parks
    // secondary activation, so the same disjointness is now proved the only way it can be: the owner is
    // served and the unbound chat leaves no trace in the owner's runtime at all.
    const { defaultRuntime, defaultAgent } = await bootOwnerGateway();

    const r1 = await gateway!.handleTestMessage(DEFAULT_CHAT, `default note ${DEFAULT_MARKER}`);
    const r2 = await gateway!.handleTestMessage(SECONDARY_CHAT, `secondary note ${SECONDARY_MARKER}`);
    const r3 = await gateway!.handleTestMessage(DEFAULT_CHAT, 'default follow-up');
    expect(r1).toContain(DEFAULT_MARKER);
    expect(r2).toMatch(/not connected to this assistant/i);
    expect(r3).toContain(DEFAULT_MARKER);
    // The refused message did not consume a model call: exactly the two owner turns did.
    expect(defaultAgent).toHaveBeenCalledTimes(2);

    const defaultHistory = JSON.stringify(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT));
    expect(defaultHistory).toContain(DEFAULT_MARKER);
    expect(defaultHistory).not.toContain(SECONDARY_MARKER);
    // The refused chat produced no history under its own id either.
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);

    // The refused message text never reached the ledger or the on-disk workspace.
    expect(grepTree(defaultRuntime.workspace, SECONDARY_MARKER)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'secondary-only-med')).toEqual([]);
    const meds = await defaultRuntime.ledgerStore!.listAllOfType('medication');
    expect(meds.some((f) => f.entity === 'secondary-only-med')).toBe(false);
    // …while the owner's own turns really did write. The lane is not simply inert.
    expect(meds.some((f) => f.entity === 'default-only-med')).toBe(true);
  });

  it('gives an UNBOUND chat canned emergency guidance and persists nothing', async () => {
    // Plan15/spec13 require canned raw-emergency guidance without granting health authority.
    // The former founder attribution had no canonical evidence. Preserve the isolation checks.
    const { defaultRuntime, defaultAgent } = await bootOwnerGateway();

    const reply = await gateway!.handleTestMessage(SECONDARY_CHAT, 'severe chest pain right now');

    expect(reply).toBe(EMERGENCY_RESPONSE);
    expect(defaultAgent).not.toHaveBeenCalled();
    // Nothing persisted in the owner's runtime, and no health text reached the owner's workspace.
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT)).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'severe chest pain')).toEqual([]);
    expect(await defaultRuntime.ledgerStore!.listAllOfType('medication')).toEqual([]);
  });

  it('staged media in an UNBOUND chat is REFUSED and deleted — never adopted into any reports directory', async () => {
    // OLD -> NEW. OLD: "staged media in the secondary chat is adopted into the SECONDARY workspace/reports
    // (0600), never the default" — i.e. it asserted the attachment WAS adopted into the second profile's
    // workspace with mode 0600. Adoption for a chat that is not the owner is exactly what S1 forbids, so
    // the expectation inverts: no adoption anywhere, and the staged file is cleaned up.
    //
    // What is PRESERVED and is the real safety property: the bytes never land in a reports directory that
    // the owner's index, prompt or future agent turn could read, and they do not survive as a leftover.
    const { defaultRuntime } = await bootOwnerGateway();
    // The REAL owner staging lane, so the cleanup path under test is the production one. `deleteStagedMedia`
    // refuses to delete anything outside the trusted base by design, so a file planted in an unrelated
    // directory would survive for a reason that has nothing to do with admission.
    const staging = path.join(defaultRuntime.workspace, '.state', 'media-staging');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const stagedPath = path.join(staging, 'lab-report.pdf');
    fs.writeFileSync(stagedPath, 'secondary lab bytes', { mode: 0o600 });

    // A Router pointed at the same tmp staging lane, resolving runtimes via the real manager, carrying
    // the SAME admission and owner identity the booted Gateway has.
    const router = new GatewayMessageRouter({
      config: makeConfig(),
      admission: (gateway as unknown as { admission: never }).admission,
      ownerId: 'default' as ProfileId,
      stagingDir: staging,
      stagingBaseDir: defaultRuntime.workspace,
      buildBootStatusText: () => 'status',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resolveRuntime: ((id: ProfileId) => gateway!.runtimeManager!.get(id)) as any,
    } as never);
    const reply = await router.route(
      { chatId: SECONDARY_CHAT, userId: '', text: `analyze this ${SECONDARY_MARKER}`, mediaPath: stagedPath },
      jest.fn().mockResolvedValue(undefined),
    );

    // Refused, and the staged bytes are gone rather than adopted or orphaned.
    expect(reply).toMatch(/not connected to this assistant/i);
    expect(fs.existsSync(stagedPath)).toBe(false);
    // Assert on CONTENTS, not on a directory being absent: `reports/` legitimately exists in a bootstrapped
    // owner workspace, so its absence would be a false signal. What matters is that it holds no attachment
    // and that these bytes appear nowhere under the owner's workspace at all.
    const reportsDir = path.join(defaultRuntime.workspace, 'reports');
    const adoptedNames = fs.existsSync(reportsDir) ? fs.readdirSync(reportsDir) : [];
    expect(adoptedNames).toEqual([]);
    expect(grepTree(defaultRuntime.workspace, 'secondary lab bytes')).toEqual([]);
  });

  it('the owner runtime carries a scheduler, and job creation for an unbound chat is refused up front', async () => {
    // OLD -> NEW. OLD: "each built profile gets its own scheduler; a secondary heartbeat job dispatches to
    // + records in the secondary only". There is one serving identity in S1, so the second scheduler is
    // gone. PRESERVED: the owner's scheduler exists and is usable, and a job for any chat the owner record
    // does not bind is REFUSED at creation rather than silently suppressed at dispatch. Asserting the
    // refusal is the containment proof `BACKLOG.md:66` asks for: unavailable proven, not declared.
    const { defaultRuntime } = await bootOwnerGateway();

    expect(defaultRuntime.scheduler).toBeDefined();

    await expect(defaultRuntime.scheduler!.createJob({
      title: 'Father reminder', chatId: SECONDARY_CHAT, cron: '0 8 * * *',
      prompt: 'take your morning pill', source: 'user', kind: 'routine',
    })).rejects.toThrow(/does not own/i);

    // Nothing was recorded.
    expect(await defaultRuntime.scheduler!.listJobs()).toEqual([]);

    // …and the owner's OWN destination still works, so the owner does not lose reminders.
    const own = await defaultRuntime.scheduler!.createJob({
      title: 'Owner reminder', chatId: DEFAULT_CHAT, cron: '0 9 * * *',
      prompt: 'take your morning pill', source: 'user', kind: 'routine',
    });
    expect(own.chatId).toBe(DEFAULT_CHAT);
    expect(await defaultRuntime.scheduler!.listJobs()).toHaveLength(1);
  });

  it('OLD->NEW a fresh unbound chat is refused: no onboarding, no agent, no store writes', async () => {
    // OLD -> NEW: previously a fresh secondary chat ran deterministic onboarding scoped to the SECONDARY
    // workspace. Secondary activation is parked, so an unbound chat is refused at admission instead. The
    // containment is asserted directly: no onboarding file, no agent call, nothing written to the owner's
    // workspace. Stronger than the original, which only proved scoping.
    const freshChat = 'father-new-chat';
    gateway = await boundGateway(baseDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const defaultRuntime = await gateway.runtimeManager!.get('default' as ProfileId);
    const run = jest.fn().mockResolvedValue({ text: 'SHOULD-NOT-RUN', trace: [], usedTools: [], healthResponse: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run };

    const reply = await gateway.handleTestMessage(freshChat, 'hello, I am setting up');

    // Refused by admission, and nothing ran or was written anywhere.
    expect(reply).toMatch(/not connected to this assistant/i);
    expect(reply).not.toBe('SHOULD-NOT-RUN');
    expect(run).not.toHaveBeenCalled();
    expect(defaultRuntime.sessions!.getHistory(freshChat)).toEqual([]);
    expect(fs.existsSync(path.join(defaultRuntime.workspace, '.redacted', 'onboarding.json'))).toBe(false);
  });

  it('OLD->NEW the bound owner is served and every other chat is refused', async () => {
    // OLD -> NEW, and this test's TITLE previously documented the S1 DEFECT as intended behaviour:
    // "first-contact auto-pair intact". First contact auto-pairing is the exact defect this wave removes —
    // a stranger's first DM was auto-paired into the owner's profile and answered clinically. The owner is
    // bound here through a REAL owner record, so there is no auto-pair path left to exercise.
    //
    // What is asserted now: the bound owner is served; an unknown chat is refused by ADMISSION; and a chat
    // that only exists in a `profiles.json` a caller writes by hand is ALSO refused, because `profiles.json`
    // is not authorization under S1 — the owner record is, and there is no registry left to consult.
    gateway = await boundGateway(baseDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const defaultRuntime = await gateway.runtimeManager!.get('default' as ProfileId);
    markOnboardingSkipped(defaultRuntime.workspace);
    const ownerAgent = mockAgentRun(`default-ack ${DEFAULT_MARKER}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: ownerAgent };

    const ownerReply = await gateway.handleTestMessage(DEFAULT_CHAT, 'hello');
    expect(ownerReply).toContain(DEFAULT_MARKER);

    // Unknown chat → refused by admission.
    const strangerReply = await gateway.handleTestMessage('stranger-chat', 'show me the health profile');
    expect(strangerReply).toMatch(/not connected to this assistant/i);

    // OLD -> NEW: was "paired non-default → SERVED". A chat that appears in `profiles.json` — written by
    // hand, with no owner record behind it — is now REFUSED. This is the containment `BACKLOG.md:66`
    // requires: proven unavailable, not merely declared so.
    fs.mkdirSync(path.join(baseDir), { recursive: true });
    fs.writeFileSync(
      path.join(baseDir, 'profiles.json'),
      JSON.stringify({ profiles: [{ profileId: 'father', label: 'father', chatIds: [SECONDARY_CHAT] }] }),
    );
    const secondaryReply = await gateway.handleTestMessage(SECONDARY_CHAT, 'hello father scope');
    expect(secondaryReply).toMatch(/not connected to this assistant/i);
    expect(secondaryReply).not.toContain(SECONDARY_MARKER);

    // Only the owner's turns reached a model.
    expect(ownerAgent).toHaveBeenCalledTimes(1);
  });

  it('a degraded (unresolvable) profile gets a canned genuine-failure reply — never a throw, staged media cleaned up', async () => {
    // Inside the OWNER workspace: `deleteStagedMedia` refuses anything outside its trusted base, so a
    // file planted in an unrelated directory would survive for a reason unrelated to admission.
    const staging = path.join(baseDir, 'profiles', 'default', '.state', 'media-staging');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const mkStaged = (name: string): string => {
      const p = path.join(staging, name);
      fs.writeFileSync(p, 'degraded bytes', { mode: 0o600 });
      return p;
    };
    for (const resolveRuntime of [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => Promise.resolve(undefined)) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => Promise.reject(new Error('simulated corrupt profile build'))) as any,
    ]) {
      const stagedPath = mkStaged(`upload-${Math.random().toString(36).slice(2)}.pdf`);
      // S1: admission is REQUIRED. OLD passed `profileRegistry` and routed from `other-chat`, a chat the
      // registry paired to a second profile. NEW there is no second identity, so the only way to reach the
      // DEGRADED-runtime path is as the BOUND OWNER whose runtime cannot resolve — which is exactly the
      // failure this test is about: a resolver that returns nothing or rejects must yield the canned
      // genuine-failure reply, never a throw, and the staged media must be cleaned up either way.
      const bound = await bindOwnerFixture(
        path.join(baseDir, 'profiles', 'default', '.state', 'owner-access.json'),
        'default',
        DEFAULT_CHAT,
        { channel: 'telegram', userId: 'owner-user' },
      );
      const router = new GatewayMessageRouter({
        config: makeConfig(),
        admission: bound.admission,
        ownerId: bound.ownerId,
        stagingDir: staging,
        stagingBaseDir: path.join(baseDir, 'profiles', 'default'),
        buildBootStatusText: () => 'status',
        resolveRuntime,
      } as never);
      const reply = await router.route(
        {
          channel: 'telegram',
          chatId: DEFAULT_CHAT,
          userId: 'owner-user',
          chatType: 'private',
          eventId: 'telegram:degraded:1',
          text: 'hello',
          mediaPath: stagedPath,
        },
        jest.fn().mockResolvedValue(undefined),
      );
      expect(reply).toContain('temporarily unavailable');
      expect(reply).not.toContain("can't serve");
      expect(fs.existsSync(stagedPath)).toBe(false);
    }
  });
});
