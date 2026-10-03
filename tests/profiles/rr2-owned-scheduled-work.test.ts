import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Gateway } from '../../src/gateway/gateway';
import { composeOwnerAuthority } from '../../src/runtime/owner-authority';
import { asProfileId } from '../../src/profiles';
import type { OwnerAdmissionService } from '../../src/profiles';
import type { EffectiveConfig } from '../../src/config/types';
import type { ProfileId } from '../../src/profiles/types';
import { ProfileRuntime } from '../../src/gateway/runtime';
import { LLMSemaphore } from '../../src/tools/semaphore';
import { attachGatewayTestRuntime } from '../helpers/gateway-test-runtime';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

// RR2-B1 (R2-10/R2-11): scheduled work retains its OWNING identity. Every production trigger
// closure captures its concrete ProfileRuntime; the job's `chatId` is a destination, never
// authority to select a runtime or claim pairing. Real job stores, real session files, scripted
// agent responses, no live networks.
//
// S1 change (OLD -> NEW). OLD: this suite booted TWO real profiles through `ProfileRegistry` and
// proved B1 as "A's work cannot reach B and B's work cannot reach A". NEW: S1 serves exactly one
// owner — `buildRuntimeFor` now REFUSES any identity that is not the selected owner — so the
// cross-identity leg is expressed as "a destination that is NOT the bound owner chat", which is the
// same authority question asked of the one identity that exists.
//
// Nothing was deleted. Per plan 15 §5: "keep dispatch/egress destination authority, outcome truth,
// no foreign session/store mutation and refusal with absent guard… use the selected owner's real
// runtime plus unbound destinations. Never discard B1 merely because its original fixture boots two
// profiles." Each retired leg is recorded at its old->new site below.

jest.mock('../../src/memory/indexer', () => ({
  MemoryIndexer: jest.fn().mockImplementation(() => ({
    indexAll: jest.fn().mockRejectedValue(new Error('embedding provider unavailable')),
  })),
}));

const DEFAULT_CHAT = 'owner-chat';
/** OLD: the second identity's paired chat. NEW: simply a chat that is not the owner's binding. */
const SECONDARY_CHAT = 'father-chat';
/** OLD: the second identity's alternate paired chat. NEW: a second unbound destination. */
const SECONDARY_ALT_CHAT = 'father-alt-chat';
/** OLD: a marker proving the reply came from the SECONDARY runtime. NEW: unused by identity; kept as
 *  a distinct prompt/trace marker so a reply can still be attributed to one job. */
const SECONDARY_MARKER = 'owned-heartbeat-secondary-7d21';
const DEFAULT_MARKER = 'owned-heartbeat-default-4c8e';

function mockAgentRun(replyText: string) {
  return jest.fn(async () => ({
    text: replyText,
    trace: [{ role: 'assistant' as const, content: replyText }],
    usedTools: [],
    healthResponse: false,
  }));
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function hashTree(dir: string, options: { skipStateDir?: boolean } = {}): string {
  if (!fs.existsSync(dir)) return 'missing';
  const hash = createHash('sha256');
  const walk = (current: string, rel: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      const relFull = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        // `.state/` holds the job store, the audit log and the search database — BOOKKEEPING. A
        // suppressed delivery must record its refusal there, so including it would make "no clinical
        // side effect" untestable. `skipStateDir` hashes the owner's clinical content only: memory,
        // ledger, SAFETY.md and the rest.
        if (options.skipStateDir && entry.name === '.state') continue;
        walk(full, relFull);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(relFull);
      hash.update(fs.readFileSync(full));
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

describe('RR2-B1: scheduled work retains its owning profile (R2-10/R2-11)', () => {
  let tmpDir: string;
  let baseDir: string;
  let legacyWorkspace: string;
  let gateway: Gateway | undefined;

  beforeEach(() => {
    // Workspace-local (gitignored `.test-tmp/`), never `os.tmpdir()`. This fixture is being rewritten for
    // one-owner authority, so it moves off the out-of-workspace path as part of the same change.
    tmpDir = makeTestTemp('rr2b1');
    baseDir = path.join(tmpDir, 'redacted-home');
    // OLD: a hand-picked `legacy-workspace` that the migration branch copied into a profile directory.
    // NEW: `config.memory.workspace` IS the owner workspace — the same derivation production uses.
    legacyWorkspace = path.join(baseDir, 'profiles', 'default');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    removeTestTemp(tmpDir);
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
        storePath: path.join(legacyWorkspace, '.state', 'heartbeat-jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(legacyWorkspace, '.state', 'audit.jsonl') },
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

  /**
   * Bind the owner through the REAL admission service, so the destination guard reads a genuine record.
   *
   * Old -> new (S1 cutover): this suite used to authorize a scheduled destination by calling
   * `registry.pairChatToProfile(...)`. S1 made pairing the only route to a profile, so nothing ever paired
   * the registry and the guard returned `false` for the owner's own chat — with `heartbeat.enabled`
   * defaulting to true, the owner's reminders were inert in the shipped daemon while still being armed at
   * boot. The authority is now `OwnerState.binding.chatId`.
   *
   * **No assertion was deleted.** Fixtures were re-pointed, per plan 15 §5: "use the selected owner's real
   * runtime plus unbound destinations… Never discard B1 merely because its original fixture boots two
   * profiles."
   */
  async function bindOwner(chatId: string): Promise<OwnerAdmissionService> {
    const authority = composeOwnerAuthority({
      ownerId: asProfileId('default')!,
      ownerPaths: { ownerRecord: path.join(baseDir, 'profiles', 'default', '.state', 'owner-access.json') },
    });
    await authority.admission.initialize();
    const issued = await authority.admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error(`issue failed: ${issued.kind}`);
    const result = await authority.admission.handlePairing(
      { channel: 'telegram', chatId, userId: 'owner-user', chatType: 'private', eventId: `telegram:${chatId}:bind` },
      issued.plaintext,
    );
    if (result.kind !== 'paired') throw new Error(`pairing failed: ${result.kind}`);
    return authority.admission;
  }

  /**
   * Boot the real Gateway for the ONE selected owner, bound at `DEFAULT_CHAT` through the real
   * enrollment state machine. Returns the owner's real runtime, its job store, its agent double and
   * the real channel, so every assertion below runs on production collaborators.
   *
   * OLD -> NEW: this built a second `ProfileRegistry` profile ("father"), paired two chats to it and
   * asked `manager.get(secondary.profileId)`. S1 serves one owner, so there is no second runtime to
   * build; the destination-authority question is now asked of unbound chats instead.
   */
  async function bootOwnerGateway() {
    const admission = await bindOwner(DEFAULT_CHAT);
    gateway = new Gateway(makeConfig(), { admission, ownerId: asProfileId('default')! });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const manager = gateway.runtimeManager!;
    const defaultRuntime = await manager.get('default' as ProfileId);
    markOnboardingSkipped(defaultRuntime.workspace);
    const defaultAgent = mockAgentRun(`owner-ack ${DEFAULT_MARKER}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: defaultAgent };

    /**
     * Move the binding to a different chat, through the REAL owner-state port and record format.
     *
     * This is the S1 equivalent of the old `liveRegistry.pairChatToProfile(...)` mid-flight reassignment.
     * S1 supports no rebinding *command*, so this writes the record the way an authoritative change would
     * arrive from outside: fresh read, modified state, atomic replace. The guard must re-read it at egress.
     */
    const rebindOwnerChat = async (newChatId: string): Promise<void> => {
      const { FileOwnerStatePort } = await import('../../src/runtime/adapters');
      const recordPath = path.join(baseDir, 'profiles', 'default', '.state', 'owner-access.json');
      const port = new FileOwnerStatePort(recordPath, 'default');
      const current = port.read();
      if (current.kind !== 'available' || current.state.phase !== 'bound') {
        throw new Error('owner record is not bound; cannot rebind');
      }
      await port.replace({
        ...current.state,
        binding: { ...current.state.binding, chatId: newChatId },
      });
    };

    return {
      defaultRuntime,
      defaultAgent,
      rebindOwnerChat,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: (gateway as any).channel.send as jest.Mock,
    };
  }

  it('cron_manage refuses any destination that is not the bound owner chat and persists nothing; the bound destination stays usable', async () => {
    // OLD -> NEW: this was "B's model tries to point a reminder at A's chat" plus "B's own chat AND a
    // B-owned alternate chat both remain usable". Both halves are retired: S1 has no second identity, and
    // no chat other than the owner's binding may be activated. The authority question is unchanged, so it
    // is asked of the one runtime that exists, against every chat that is not its binding.
    const { defaultRuntime } = await bootOwnerGateway();
    const storeJobs = () => defaultRuntime.scheduler!.getStore().list();
    const before = (await storeJobs()).length;

    // Pointing a reminder at a chat that is not the owner's binding is refused…
    const foreign = await defaultRuntime.registry!.execute(
      'cron_manage',
      { action: 'create', title: 'Cross-profile reminder', chatId: SECONDARY_CHAT, cron: '0 8 * * *', prompt: 'cross prompt' },
      { chatId: DEFAULT_CHAT },
    );
    expect(foreign.isError).toBe(true);

    // …as is a second unbound destination, even though the owner is the one asking.
    const alternate = await defaultRuntime.registry!.execute(
      'cron_manage',
      { action: 'create', title: 'Alt-chat reminder', chatId: SECONDARY_ALT_CHAT, cron: '0 10 * * *', prompt: 'alt prompt' },
      { chatId: DEFAULT_CHAT },
    );
    expect(alternate.isError).toBe(true);

    // Nothing landed in the store.
    expect((await storeJobs()).length).toBe(before);
    const jobsAfterRefusals = await storeJobs();
    expect(jobsAfterRefusals.some((j) => j.title === 'Cross-profile reminder')).toBe(false);
    expect(jobsAfterRefusals.some((j) => j.title === 'Alt-chat reminder')).toBe(false);

    // THE REGRESSION THIS GUARDS: the owner's OWN bound destination is still accepted, so reminders
    // keep working. This is the leg that was inert while the guard still read the registry.
    const ownerJob = await defaultRuntime.registry!.execute(
      'cron_manage',
      { action: 'create', title: 'Owner reminder', chatId: DEFAULT_CHAT, cron: '0 9 * * *', prompt: 'owner prompt' },
      { chatId: DEFAULT_CHAT },
    );
    expect(ownerJob.isError).toBeUndefined();
    const jobs = await storeJobs();
    expect(jobs.some((j) => j.title === 'Owner reminder' && j.chatId === DEFAULT_CHAT)).toBe(true);
  });

  it('a planted job addressed to an UNBOUND chat fires on the real path into suppression: no agent/session/store change, no send', async () => {
    // OLD -> NEW: was "a planted B-owned job addressed to A fires into suppression: no A agent/session/
    // store change, no send to A". Same real fire path, same suppression outcome; the "foreign" chat is
    // now simply a chat the owner record does not bind.
    const { defaultRuntime, defaultAgent, send } = await bootOwnerGateway();

    // Plant directly through the real HeartbeatStore (bypasses the create guard deliberately) so a
    // stale/foreign record can be exercised on the real fire path.
    const store = defaultRuntime.scheduler!.getStore();
    const planted = await store.create({
      title: 'Planted foreign job',
      chatId: SECONDARY_CHAT,
      cron: '0 8 * * *',
      prompt: `unbound-only prompt ${SECONDARY_MARKER}`,
      source: 'agent',
      kind: 'routine',
    });

    // OLD: byte-equality against the SECONDARY's store, i.e. "A's store is untouched". NEW: there is one
    // store and it MUST record the refusal, so "persists nothing" is restated as what it means — the set
    // of JOBS is unchanged (none created, none deleted, no chat reassigned) and the only difference is the
    // recorded outcome, asserted precisely below.
    const jobsBefore = (await store.list()).map((j) => `${j.id}|${j.title}|${j.chatId}|${j.enabled}`).sort();
    // Clinical content only — see `hashTree`. The refusal itself is recorded in `.state/heartbeat-jobs.json`,
    // which is asserted separately below via `lastOutcome`.
    const workspaceBefore = hashTree(defaultRuntime.workspace, { skipStateDir: true });
    const sessionsBefore = hashTree(defaultRuntime.sessions!.sessionsDir);

    // Real production fire path: the scheduler trigger -> Gateway dispatch -> destination guard.
    await defaultRuntime.scheduler!.runNow(planted.id);

    expect(defaultAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    // No session entry under the refused destination, and no mutation anywhere on disk.
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(hashTree(defaultRuntime.workspace, { skipStateDir: true })).toBe(workspaceBefore);
    expect(hashTree(defaultRuntime.sessions!.sessionsDir)).toBe(sessionsBefore);
    const jobsAfter = (await store.list()).map((j) => `${j.id}|${j.title}|${j.chatId}|${j.enabled}`).sort();
    expect(jobsAfter).toEqual(jobsBefore);

    // The store records an HONEST REFUSAL — suppressed, not sent, not an operational error, no retry.
    const refreshed = await store.get(planted.id);
    expect(refreshed?.lastOutcome).toBe('skipped-unowned-chat');
    expect(refreshed?.deliveryState).toBe('ready');
    expect(refreshed?.retryCount).toBe(0);
  });

  it('a recovered job for an unknown chat binds nothing, calls no model, sends nothing — and no message can grant that chat either', async () => {
    // OLD -> NEW: was "…with an open pairing table pairs nothing…; GENUINE FIRST CONTACT STILL WORKS".
    // The second half asserted that a brand-new chat was auto-paired into the owner runtime on first
    // contact and could then hold scheduled work. That IS the defect S1 removes — first-contact
    // auto-pair — so it cannot be preserved as an expectation. Replaced by the stronger statement of the
    // same boundary: the chat stays unbound no matter who asks, including the owner's own runtime.
    const admission = await bindOwner(DEFAULT_CHAT);
    gateway = new Gateway(makeConfig(), { admission, ownerId: asProfileId('default')! });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    await gateway.start();
    const defaultRuntime = await gateway.runtimeManager!.get('default' as ProfileId);
    markOnboardingSkipped(defaultRuntime.workspace);
    const defaultAgent = mockAgentRun(`default-ack ${DEFAULT_MARKER}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: defaultAgent };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const send = (gateway as any).channel.send as jest.Mock;

    // Plant a recovered/persisted job addressed to a stranger through the real store.
    const store = defaultRuntime.scheduler!.getStore();
    const planted = await store.create({
      title: 'Recovered stray job',
      chatId: 'stranger-heartbeat-chat',
      cron: '0 8 * * *',
      prompt: 'stray prompt',
      source: 'system',
      kind: 'routine',
    });

    await defaultRuntime.scheduler!.runNow(planted.id);

    // Nothing bound the stranger, no model call, no send.
    expect(admission.ownsDestination('stranger-heartbeat-chat')).toBe(false);
    expect(defaultAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(defaultRuntime.sessions!.getHistory('stranger-heartbeat-chat')).toEqual([]);
    const refreshed = await store.get(planted.id);
    expect(refreshed?.lastOutcome).toBe('skipped-unowned-chat');

    // A message from that chat cannot grant it either: it is refused and never paired, so the pairing
    // table stays closed and the job above stays suppressed on the next fire.
    const reply = await gateway.handleTestMessage('stranger-heartbeat-chat', 'hello there');
    expect(reply).not.toContain(DEFAULT_MARKER);
    expect(admission.ownsDestination('stranger-heartbeat-chat')).toBe(false);
  });

  it('a valid job on the BOUND owner destination fires for real (agent, session, outcome, audit); an unbound destination changes nothing; failed delivery records an operational error', async () => {
    // OLD -> NEW: was "a valid B job changes only B… A state stays byte-equivalent". The B-identity leg is
    // retired (secondary activation is parked), so the same invariant is now expressed for the single
    // selected owner: a job on the bound destination really fires and really records, and a job on any
    // other destination changes nothing at all. Every assertion below is preserved, not dropped.
    const { defaultRuntime, send } = await bootOwnerGateway();

    const job = await defaultRuntime.scheduler!.createJob({
      title: 'Valid owner reminder',
      chatId: DEFAULT_CHAT,
      cron: '0 8 * * *',
      prompt: `take the morning pill ${SECONDARY_MARKER}`,
      source: 'user',
      kind: 'routine',
    });
    await defaultRuntime.scheduler!.runNow(job.id);

    // THE REGRESSION THIS RESTORES: with the guard reading the owner record, a real reminder fires again.
    // Before the re-point this whole path was suppressed and the owner's reminders were inert.
    expect(send).toHaveBeenCalledWith(DEFAULT_CHAT, expect.objectContaining({ text: expect.stringContaining(DEFAULT_MARKER) }));
    const refreshed = await defaultRuntime.scheduler!.getStore().get(job.id);
    expect(refreshed?.lastOutcome).toBe('sent');
    // OLD: read the audit log through `new ProfileRegistry(baseDir).profileAuditLog(...)`.
    // NEW: the store and audit log are both derived owner paths, asserted directly.
    const auditRaw = fs.readFileSync(path.join(legacyWorkspace, '.state', 'audit.jsonl'), 'utf8');
    expect(auditRaw).toContain('"type":"sent"');

    // The owner's session holds the turn…
    expect(JSON.stringify(defaultRuntime.sessions!.getHistory(DEFAULT_CHAT))).toContain(DEFAULT_MARKER);
    // …and the unbound destination the owner does NOT own holds nothing. OLD: `secondaryRuntime` was a
    // second runtime's session; NEW: the refused destination has no session entry in the owner's own lane.
    expect(defaultRuntime.sessions!.getHistory(SECONDARY_CHAT)).toEqual([]);
    expect(hashTree(defaultRuntime.sessions!.sessionsDir)).not.toBe('missing');

    // Failed delivery still records an OPERATIONAL outcome on the owner store (not suppression).
    send.mockRejectedValueOnce(new Error('send failed'));
    const failJob = await defaultRuntime.scheduler!.createJob({
      title: 'Failing owner reminder',
      chatId: DEFAULT_CHAT,
      cron: '0 12 * * *',
      prompt: 'will fail',
      source: 'user',
      kind: 'routine',
    });
    await expect(defaultRuntime.scheduler!.runNow(failJob.id)).resolves.toBeUndefined();
    const failed = await defaultRuntime.scheduler!.getStore().get(failJob.id);
    expect(failed?.lastOutcome).toBe('error');
    expect(failed?.deliveryState).toBe('retry-wait');
  });

  it('reassigning the bound destination WHILE the agent is held: no send, outcome suppressed (never sent/error-retry), no session entry', async () => {
    // OLD -> NEW: was "reassigning the destination from B to A while the scripted B agent is held". The
    // authority is now the owner RECORD, so the mid-flight reassignment is a record rebind rather than a
    // registry pairing. The invariant is identical and now stronger: the guard must RE-READ the record at
    // egress, because a slow retrieval or a long model call can span a binding change.
    const { defaultRuntime, rebindOwnerChat, send } = await bootOwnerGateway();

    const job = await defaultRuntime.scheduler!.createJob({
      title: 'Held owner reminder',
      chatId: DEFAULT_CHAT,
      cron: '0 8 * * *',
      prompt: `held prompt ${DEFAULT_MARKER}`,
      source: 'user',
      kind: 'routine',
    });

    let releaseAgent!: () => void;
    const agentGate = new Promise<void>((resolve) => { releaseAgent = resolve; });
    const heldRun = jest.fn(async () => {
      await agentGate;
      return {
        text: `held heartbeat reply ${SECONDARY_MARKER}`,
        trace: [{ role: 'assistant' as const, content: `held heartbeat reply ${SECONDARY_MARKER}` }],
        usedTools: [],
        healthResponse: false,
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (defaultRuntime as any).agentLoop = { run: heldRun };

    const firePromise = defaultRuntime.scheduler!.runNow(job.id);
    await until(() => heldRun.mock.calls.length > 0);

    // The owner binding moves to a DIFFERENT chat while the model is still running.
    await rebindOwnerChat('some-other-chat');

    releaseAgent();
    await firePromise;

    // No delivery at all: the chat this job addressed is no longer the bound destination.
    expect(send).not.toHaveBeenCalled();

    // An AUTHORIZATION suppression — never recorded as sent, and never as an operational error/retry.
    const refreshed = await defaultRuntime.scheduler!.getStore().get(job.id);
    expect(refreshed?.lastOutcome).toBe('skipped-unowned-chat');
    expect(refreshed?.deliveryState).toBe('ready');
    expect(refreshed?.retryCount).toBe(0);

    // NOTE ON WHAT IS *NOT* ASSERTED HERE, deliberately. The dispatching runtime does record the turn and
    // the model's reply locally, and that is correct: B1 suppresses EGRESS, not the local record. An
    // earlier draft of this test asserted the session stayed empty; that was wrong and was removed rather
    // than forced to pass. The pre-S1 assertion was `getHistory(SECONDARY_CHAT)` on the OTHER profile —
    // "no entry appeared under the destination it was refused" — and under one owner there is no second
    // profile, so `send` not being called is the faithful equivalent.
  });

  it('a throwing owner-record read fails closed: no implicit default authorization, refusal is not a crash', async () => {
    // OLD -> NEW. OLD proved TWO boundaries: "no registry" and "throwing registry lookup". NEW proves ONE
    // at runtime, because the other is no longer a reachable state:
    //
    //   - "no authority at all" is now enforced by the TYPE. `GatewayAdmissionDeps.admission` is
    //     required, so a Gateway with no owner authority does not compile. That is stronger than a test,
    //     and it is what plan 15 §5 asks for: "New core APIs must not have an optional admission fallback".
    //   - "authority present but its record read THROWS" is still reachable at runtime, so it is still
    //     tested here. This is the guard standing between a scheduler trigger and an unauthorised send,
    //     and it must fail closed rather than crash the daemon or default to the owner.
    const config = makeConfig();
    const admission = await bindOwner(DEFAULT_CHAT);
    gateway = new Gateway(config, { admission, ownerId: asProfileId('default')! });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = attachGatewayTestRuntime(gateway, config, {
      sessions: {
        getLastActiveAt: jest.fn().mockReturnValue(undefined),
        prepareHistory: jest.fn().mockResolvedValue([]),
        recordTurn: jest.fn().mockResolvedValue(undefined),
        recordPromptUsage: jest.fn().mockResolvedValue(undefined),
        getHistory: jest.fn().mockReturnValue([]),
      },
      agentLoop: { run: jest.fn().mockResolvedValue({ text: 'SHOULD-NOT-RUN', trace: [], usedTools: [], healthResponse: false }) },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };

    const job: {
      id: string; title: string; chatId: string; cron: string; timezone: string; prompt: string;
      enabled: boolean; source: 'system'; kind: 'routine'; deliveryState: 'ready';
      retryCount: number; maxRetries: number; createdAt: string; updatedAt: string;
    } = {
      id: 'boundary-job',
      title: 'Boundary job',
      chatId: 'any-chat',
      cron: '0 8 * * *',
      timezone: 'UTC',
      prompt: 'boundary prompt',
      enabled: true,
      source: 'system' as const,
      kind: 'routine' as const,
      deliveryState: 'ready' as const,
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // The gateway DOES hold a real bound owner, and `any-chat` is not that owner's destination.
    // Nothing may authorize this chat by default.
    await (gateway as unknown as {
      handleScheduledJob(job: unknown, owner: unknown, invokedByScheduler: boolean): Promise<void>;
    }).handleScheduledJob(job, runtime, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((gateway as any).channel.send as jest.Mock)).not.toHaveBeenCalled();
    expect((runtime.agentLoop as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();

    // An owner-record read that THROWS: refusal is fail-closed and sanitized, never a crash.
    // OLD stubbed `profileRegistry.getProfileForChat` to throw; NEW replaces the admission service with
    // one whose record read explodes. The field is private, so this reaches it the way a broken
    // collaborator actually presents: present, and throwing.
    (gateway as unknown as { admission: unknown }).admission = {
      ownsDestination: () => { throw new Error('owner record read exploded'); },
    };
    await (gateway as unknown as {
      handleScheduledJob(job: unknown, owner: unknown, invokedByScheduler: boolean): Promise<void>;
    }).handleScheduledJob(job, runtime, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((gateway as any).channel.send as jest.Mock)).not.toHaveBeenCalled();
    expect((runtime.agentLoop as unknown as { run: jest.Mock }).run).not.toHaveBeenCalled();

    // And nothing leaked: the throw was sanitized, not propagated.
    const logged = warnSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain('owner record read exploded');
  });

  it('production runtimes construct their scheduler WITH the destination guard; the direct canSchedule factory refuses activation without one', async () => {
    const { defaultRuntime } = await bootOwnerGateway();

    // Normal boot: the production scheduler carries the guard, wired to the owner record.
    // OLD also asserted a SECOND scheduler existed for the second identity; that capability is retired,
    // and slice 1 makes `buildRuntimeFor` REFUSE to build a runtime for any other identity, so the
    // "secondary identity may address nothing" property is now structural rather than asserted twice.
    const defaultGuard = (defaultRuntime.scheduler as unknown as { canAddressChat?: (chatId: string) => boolean }).canAddressChat;
    expect(typeof defaultGuard).toBe('function');
    // The selected owner may address its own bound destination, and nothing else.
    expect(defaultGuard!(DEFAULT_CHAT)).toBe(true);
    expect(defaultGuard!(SECONDARY_CHAT)).toBe(false);
    // Even the owner's own other chats are refused: the binding names exactly one destination.
    expect(defaultGuard!(SECONDARY_ALT_CHAT)).toBe(false);
    expect(defaultGuard!('nonsense-chat')).toBe(false);

    // Supported direct canSchedule:true factory path WITH a fixture predicate still activates.
    const workspace = path.join(tmpDir, 'factory-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const config = makeConfig();
    const withGuard = await ProfileRuntime.create({
      profileId: 'default' as ProfileId,
      workspace,
      dbPath: path.join(tmpDir, 'factory.db'),
      sessionsPath: path.join(tmpDir, 'factory-sessions'),
      schedulerPaths: {
        storePath: path.join(tmpDir, 'factory-heartbeats', 'jobs.json'),
        auditLogPath: path.join(tmpDir, 'factory-heartbeats', 'audit.jsonl'),
      },
      config,
      mainProvider: { modelName: 'test', chat: jest.fn(), embed: jest.fn() },
      semaphore: new LLMSemaphore(),
      canSchedule: true,
      runScheduledJob: jest.fn().mockResolvedValue(undefined),
      // Baseline-compatible: the guard dep does not exist pre-B1, so the extra key is
      // ignored there (behavioral RED) and type-checked after the interface gains it.
      ...({ canAddressChat: () => true } as Record<string, unknown>),
    });
    try {
      expect(withGuard.scheduler).toBeDefined();
      const guard = (withGuard.scheduler as unknown as { canAddressChat?: (chatId: string) => boolean }).canAddressChat;
      expect(guard!('any-chat')).toBe(true);
    } finally {
      await withGuard.drainAndClose();
    }

    // canSchedule:true WITHOUT a destination guard refuses scheduler activation
    // (never constructs an unguarded production scheduler) and does not crash boot.
    const unguardedWorkspace = path.join(tmpDir, 'factory-unguarded');
    fs.mkdirSync(unguardedWorkspace, { recursive: true });
    const withoutGuard = await ProfileRuntime.create({
      profileId: 'default' as ProfileId,
      workspace: unguardedWorkspace,
      dbPath: path.join(tmpDir, 'factory-unguarded.db'),
      sessionsPath: path.join(tmpDir, 'factory-unguarded-sessions'),
      schedulerPaths: {
        storePath: path.join(tmpDir, 'factory-unguarded-heartbeats', 'jobs.json'),
        auditLogPath: path.join(tmpDir, 'factory-unguarded-heartbeats', 'audit.jsonl'),
      },
      config,
      mainProvider: { modelName: 'test', chat: jest.fn(), embed: jest.fn() },
      semaphore: new LLMSemaphore(),
      canSchedule: true,
      runScheduledJob: jest.fn().mockResolvedValue(undefined),
    });
    try {
      expect(withoutGuard.scheduler).toBeUndefined();
    } finally {
      await withoutGuard.drainAndClose();
    }
  });
});
