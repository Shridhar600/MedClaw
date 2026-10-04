// tests/e2e/socs-owner-foundation.e2e.test.ts
//
// The S1 owner spine, end to end through the REAL composition path (plan 15 §4 T4).
//
// Nothing here is a test double for the thing under test. The only substituted collaborators are
// the EXTERNAL provider network calls — the plan's stated boundary. Everything between is real:
//
//   real setup (`runCli onboard`) -> real config document -> real owner record
//   -> real local pairing code (`runCli pairing issue`)
//   -> real daemon (`startDaemon`, holding real directory leases)
//   -> real `Gateway` -> real admission -> real router -> real `ProfileRuntime`
//   -> real session store, real narrative workspace, real scheduler store
//
// What this closes: residual R-13 (a BOUND boot through the real `Gateway.start()` with a real
// owner runtime) and residual R-10 (a turn genuinely in flight when stop is requested).

import * as fs from 'fs';
import * as path from 'path';

import { runCli } from '../../src/cli';
import { startDaemon, type DaemonHandle } from '../../src/index';
import { Gateway } from '../../src/gateway/gateway';
import type { DiagnosticEvent, DiagnosticSink } from '../../src/ports/diagnostics';
import type { LLMProvider, LLMResponse } from '../../src/providers/types';
import type { IncomingMessage } from '../../src/channels/types';
import { CryptoPairingCodePort, FileOwnerStatePort, DirectoryLease } from '../../src/runtime/adapters';
import { InstallationService } from '../../src/runtime/installation';
import { OwnerAdmissionService, asProfileId } from '../../src/profiles';
import type { TransportIdentity } from '../../src/ports/owner-state';
import { systemClock } from '../../src/ports/defaults';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { resolveOwnerPaths } from '../../src/profiles';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

/** A scripted provider. Deterministic, in-process, and never touches the network. */
class ScriptedProvider implements LLMProvider {
  readonly modelName = 'socs-e2e-scripted';
  readonly chatCalls: LLMResponse[] = [];
  constructor(private readonly script: LLMResponse[]) {}
  async chat(): Promise<LLMResponse> {
    const next = this.script[Math.min(this.chatCalls.length, this.script.length - 1)];
    this.chatCalls.push(next);
    return next;
  }
  async embed(): Promise<number[]> {
    return new Array(768).fill(0);
  }
}

function textResponse(content: string): LLMResponse {
  return { type: 'text', text: content };
}

/** The paths a real setup run would derive. Nothing here is pre-created. */
interface SpineTarget {
  configPath: string;
  baseDir: string;
  ownerId: string;
  ownerRecord: string;
  workspace: string;
  workspaceLease: string;
}

const OWNER_CHAT = 'owner-chat';
const OWNER_USER = 'owner-user';

/**
 * `startDaemon()` already awaits `gateway.start()` before it resolves, and propagates a boot failure.
 * This suite used to ALSO fire `void gateway.start()` from the `createGateway` hook and then wait on it
 * with `settleBoots()`, on the mistaken belief that `startDaemon` did not start the Gateway.
 *
 * It does. So every daemon here was booted TWICE, concurrently: two providers, two semaphores, two
 * registries, two runtime managers and two sets of runtimes, with the losing manager orphaned because
 * `stopResources()` drains only `this.manager`. That orphaned set is what kept the event loop alive after
 * the suite finished — the open handle this file was excluded from `npm test` to contain.
 *
 * Nothing starts the Gateway here any more. `startDaemon()` resolving IS the boot.
 */

function telegramMessage(
  chatId: string,
  userId: string,
  messageId: string,
  text: string,
): IncomingMessage {
  return {
    channel: 'telegram',
    chatType: 'private',
    eventId: `telegram:${chatId}:${messageId}`,
    chatId,
    userId,
    messageId,
    text,
  };
}

function identityFor(chatId: string, userId: string, messageId: string): TransportIdentity {
  return {
    channel: 'telegram',
    chatId,
    userId,
    chatType: 'private',
    eventId: `telegram:${chatId}:${messageId}`,
  };
}

describe('S1 owner spine: setup -> daemon -> stranger refused -> pair -> owner turn -> restart', () => {
  let root: string;
  let fixture: SpineTarget;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-spine');
    // A genuinely FRESH target: setup now refuses an existing installation, so the paths this
    // suite asserts on are derived here rather than pre-written by a fixture helper.
    const baseDir = path.join(root, 'state');
    const ownerId = 'default';
    const ownerPaths = resolveOwnerPaths(baseDir, asProfileId(ownerId)!);
    fixture = {
      configPath: path.join(root, 'config.json'),
      baseDir,
      ownerId,
      ownerRecord: ownerPaths.ownerRecord,
      workspace: ownerPaths.workspace,
      workspaceLease: ownerPaths.workspaceLease,
    };
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  async function cli(argv: string[]): Promise<{ code: number; output: string }> {
    let output = '';
    const code = await runCli(argv, {
      stdout: (text) => { output += text; },
      stderr: (text) => { output += text; },
    });
    return { code, output };
  }

  /** The real non-interactive setup an operator would run. */
  function setup(): Promise<{ code: number; output: string }> {
    return cli([
      'onboard',
      '--yes',
      '--config', fixture.configPath,
      '--state-root', fixture.baseDir,
      '--owner-id', fixture.ownerId,
      '--provider', 'ollama',
      '--telegram-enabled', 'false',
      '--timezone', 'UTC',
      '--heartbeats-enabled', 'false',
    ]);
  }

  function admissionFor(diagnostics?: DiagnosticSink): OwnerAdmissionService {
    return new OwnerAdmissionService({
      store: new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId),
      codes: new CryptoPairingCodePort(),
      clock: systemClock,
      expectedOwnerId: fixture.ownerId,
      ...(diagnostics ? { diagnostics } : {}),
    });
  }

  async function bootDaemon(
    provider: ScriptedProvider,
    /** When supplied, the real boot reports its outcomes through the closed diagnostic contract. */
    diagnostics?: DiagnosticSink,
  ): Promise<DaemonHandle> {
    const config = await loadRuntimeConfig({ configPath: fixture.configPath });
    return startDaemon({
      services: new InstallationService(new DirectoryLease()),
      configPath: fixture.configPath,
      homeDir: root,
      createGateway: () => {
        const gateway = new Gateway(config, {
          admission: admissionFor(diagnostics),
          ownerId: asProfileId(fixture.ownerId)!,
          createProvider: () => provider,
          ...(diagnostics ? { diagnostics } : {}),
        });
        return gateway;
      },
    });
  }

  it('serves the owner after pairing WITHOUT a restart, in one daemon lifetime', async () => {
    // The defect this exists for: `start()` decided admission ONCE and, on an unpaired record, returned
    // after building no provider, runtime or scheduler. Nothing rebuilt them when the owner paired, so
    // the owner's next message resolved to a runtime that did not exist and was answered "this chat's
    // profile is temporarily unavailable" — forever, until a restart nobody was told to perform. The
    // earlier spine test hid this by shutting down, pairing out-of-band, and booting a second daemon.
    //
    // Here the pairing code travels through `deliverMessage` as a real inbound transport event, and the
    // owner's next real message must be answered from a real runtime built during THIS process's life.
    expect((await setup()).code).toBe(0);

    const admission = admissionFor();
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error(`issue failed: ${issued.kind}`);

    const provider = new ScriptedProvider([textResponse('Noted. Rest and hydration help most headaches.')]);
    const sent: string[] = [];
    const handle = await bootDaemon(provider);

    try {
      // Booted unpaired: pairing only, and provably nothing clinical.
      expect(handle.gateway.servesPairingOnly).toBe(true);
      expect(handle.gateway.runtimeInstance).toBeUndefined();

      const deliver = (identity: TransportIdentity, text: string) =>
        handle.gateway.deliverMessage(
          { chatId: identity.chatId, userId: identity.userId, text, channel: 'telegram', chatType: 'private', eventId: identity.eventId },
          async (reply) => { sent.push(reply); },
        );

      const ownerIdentity = identityFor('owner-chat', 'owner-user', '1');

      // The pairing code arrives as ordinary inbound traffic, exactly as Telegram would deliver it.
      await deliver(ownerIdentity, issued.plaintext);
      expect(sent.join('\n')).toMatch(/pairing complete/i);

      // The very next owner message must be answered from a real runtime — no restart in between.
      sent.length = 0;
      await deliver(identityFor('owner-chat', 'owner-user', '2'), 'Can I eat daal chawal?');

      // The daemon promoted itself: pairing-only is over and a real runtime exists. This is the whole
      // point — before the fix these stayed true/false forever and the message was answered
      // "this chat's profile is temporarily unavailable".
      expect(handle.gateway.servesPairingOnly).toBe(false);
      expect(handle.gateway.runtimeInstance).toBeDefined();

      // The message was NOT refused and NOT swallowed. The first ordinary owner message legitimately
      // starts in-chat onboarding, which is canned, so no provider call happens on THIS message.
      expect(sent.join(' ')).toMatch(/personal health companion|before we start/i);
      expect(sent.join('\n')).not.toMatch(/temporarily unavailable/i);

      // And the owner's words really reached the session store in this same process, unprompted.
      const history = handle.gateway.runtimeInstance!.sessions!.getHistory('owner-chat');
      expect(history.map((m) => m.content).join('\n')).toContain('Can I eat daal chawal?');

      // Onboarding is a real multi-step flow; `skip` is a supported answer, so completing it here is
      // real behaviour rather than a bypass. Only now does a turn reach the provider.
      sent.length = 0;
      await deliver(identityFor('owner-chat', 'owner-user', '3'), 'skip');
      sent.length = 0;
      await deliver(identityFor('owner-chat', 'owner-user', '4'), 'Can I eat daal chawal?');
      expect(provider.chatCalls.length).toBeGreaterThan(0);
      expect(sent.join('\n')).not.toMatch(/temporarily unavailable/i);
    } finally {
      await handle.shutdown();
    }
  }, 180_000);

  it('runs the whole owner spine with real modules and preserves it across a restart', async () => {
    // ── 1. real setup produces the document AND the unpaired record ───────────────────
    const setupResult = await setup();
    expect(setupResult.code).toBe(0);
    expect(fs.existsSync(fixture.configPath)).toBe(true);
    expect(fs.existsSync(fixture.ownerRecord)).toBe(true);
    expect(admissionFor().inspectInstallation()).toEqual({ kind: 'unpaired' });

    // ── 2. the local pairing code comes from the real CLI ─────────────────────────────
    const issued = await cli(['--config', fixture.configPath, 'pairing', 'issue']);
    expect(issued.code).toBe(0);
    const pairingCode = issued.output.match(/\n\s{4}([A-Z2-9]{8})\s/)![1];

    // ── 3. boot the real daemon under real leases, still unpaired ────────────────────
    const provider = new ScriptedProvider([textResponse('Noted. I will keep that in mind.')]);

    const unpaired = await bootDaemon(provider);
    expect(unpaired.kind).toBe('owned');
    try {
      expect(unpaired.gateway.servesPairingOnly).toBe(true);

      const strangerReply = await unpaired.gateway.handleTestMessage('stranger-chat', 'What is my blood pressure?');
      expect(strangerReply).not.toMatch(/blood pressure|Noted/i);
      // No provider call happened at all: an unpaired installation builds no clinical runtime.
      expect(provider.chatCalls).toHaveLength(0);
      expect(admissionFor().inspectInstallation()).toEqual({ kind: 'unpaired' });
    } finally {
      await unpaired.shutdown();
    }

    // ── 4. pair through the real policy, then restart and serve the owner ─────────────
    const pairing = await admissionFor().handlePairing(
      identityFor(OWNER_CHAT, OWNER_USER, 'bind-1'),
      pairingCode,
    );
    expect(pairing).toMatchObject({ kind: 'paired', boundOwnerId: fixture.ownerId });

    const bindingBytes = fs.readFileSync(fixture.ownerRecord);
    expect(JSON.parse(bindingBytes.toString())).toMatchObject({
      phase: 'bound',
      binding: { channel: 'telegram', chatId: OWNER_CHAT, senderId: OWNER_USER },
    });

    const bound = await bootDaemon(provider);
    expect(bound.kind).toBe('owned');
    try {
      // A BOUND boot builds the REAL owner runtime — the gap residual R-13 recorded.
      expect(bound.gateway.servesPairingOnly).toBe(false);
      expect(bound.gateway.runtimeInstance).toBeDefined();
      expect(bound.gateway.runtimeInstance!.workspace).toBe(fixture.workspace);

      // A stranger message with a real telegram identity is refused. Boot itself makes provider
      // calls (readiness probing), so the invariant is that the STRANGER adds none.
      const callsBeforeStranger = provider.chatCalls.length;
      const strangerReplies: string[] = [];
      await bound.gateway.deliverMessage(telegramMessage('stranger-chat', 'stranger-user', 's1', 'What is my blood pressure?'), async (text) => {
        strangerReplies.push(text);
      });
      expect(strangerReplies.join(' ')).not.toMatch(/Noted/i);
      expect(provider.chatCalls).toHaveLength(callsBeforeStranger);

      // The local dev seam is NOT the bound telegram chat and is refused as a stranger. This is a
      // security property, not a limitation: a local REPL must not become an enrollment bypass.
      const localReply = await bound.gateway.handleTestMessage(OWNER_CHAT, 'I slept badly and my knee hurts.');
      expect(localReply).toMatch(/not connected to this assistant/i);
      expect(provider.chatCalls).toHaveLength(callsBeforeStranger);

      // The OWNER message carries the real telegram identity the binding recorded, so it runs
      // through the real router, the real runtime and the real coordinator.
      const OWNER_FIRST_MESSAGE = 'I slept badly and my knee hurts.';
      const ownerReplies: string[] = [];
      await bound.gateway.deliverMessage(
        telegramMessage(OWNER_CHAT, OWNER_USER, 'o1', OWNER_FIRST_MESSAGE),
        async (text) => { ownerReplies.push(text); },
      );

      // The first ordinary message starts in-chat onboarding — canned, so no provider call — and it
      // is NOT refused and NOT swallowed.
      expect(ownerReplies.join(' ')).toMatch(/personal health companion|before we start/i);
      expect(provider.chatCalls).toHaveLength(callsBeforeStranger);

      // "Captured, not lost when onboarding starts", proved against the real session store rather
      // than a flush-timed file check.
      const history = bound.gateway.runtimeInstance!.sessions!.getHistory(OWNER_CHAT);
      expect(history.map((message) => message.content).join('\n')).toContain(OWNER_FIRST_MESSAGE);

      // Onboarding is a real multi-step flow. Completing it through the same inbound path is the
      // honest way to reach the agent loop — `skip` is a supported user answer, so this is real
      // behaviour, not a bypass of it.
      const skipReplies: string[] = [];
      await bound.gateway.deliverMessage(
        telegramMessage(OWNER_CHAT, OWNER_USER, 'o-skip', 'skip'),
        async (text) => { skipReplies.push(text); },
      );
      expect(skipReplies.join(' ')).toMatch(/skipped|onboarding/i);

      // A later owner message now reaches the real agent loop and the real provider.
      const laterReplies: string[] = [];
      await bound.gateway.deliverMessage(
        telegramMessage(OWNER_CHAT, OWNER_USER, 'o2', 'and my sleep has been worse this week too'),
        async (text) => { laterReplies.push(text); },
      );
      expect(provider.chatCalls.length).toBeGreaterThan(callsBeforeStranger);
      expect(laterReplies.join(' ')).toContain('Noted');
      expect(bound.gateway.runtimeInstance!.workspace).toBe(fixture.workspace);
    } finally {
      await bound.shutdown();
    }

    // ── 5. restart preserves the binding, the owner paths and the record bytes ────────
    const rebooted = await bootDaemon(provider);
    try {
      expect(rebooted.gateway.servesPairingOnly).toBe(false);
      expect(rebooted.gateway.runtimeInstance!.workspace).toBe(fixture.workspace);
      expect(admissionFor().inspectInstallation()).toEqual({ kind: 'bound', ownerId: fixture.ownerId });
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(bindingBytes);
    } finally {
      await rebooted.shutdown();
    }

    // Both leases released: a clean shutdown leaves nothing held.
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
  }, 120_000);

  it('reports useful outcomes through the closed diagnostic contract during a real boot', async () => {
    // Why this earns its place: the contract is only worth having if the REAL composition root emits
    // through it. A unit test on a hand-built sink cannot catch a wiring gap — an adapter that is never
    // passed to `new Gateway(...)`, or an admission service built without it, emits nothing at all and
    // every contract test still passes. This boots the real daemon, pairs the owner, serves a turn and
    // stops, and asserts on what was actually emitted.
    expect((await setup()).code).toBe(0);

    const events: DiagnosticEvent[] = [];
    const capture: DiagnosticSink = { emit: (event) => events.push(event) };
    const owner = identityFor('owner-chat', 'owner-user', '1');
    const replies: string[] = [];
    const deliver = (message: IncomingMessage): Promise<void> =>
      daemon.gateway.deliverMessage(message, async (reply) => { replies.push(reply); });

    // Issued BEFORE the daemon boots, because the CLI needs the installation lease the running
    // daemon holds. Admission re-reads the record on every message, so the daemon still observes the
    // pairing event itself.
    // Declared out here, not inside the try, so the post-shutdown leak assertions can check it too.
    // A pairing code that reached a diagnostic would be the worst possible leak in this contract.
    const issued = await cli(['--config', fixture.configPath, 'pairing', 'issue']);
    expect(issued.code).toBe(0);
    const pairingCode = issued.output.match(/\b[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}\b/)?.[0];
    expect(pairingCode).toBeTruthy();

    const provider = new ScriptedProvider([textResponse('ok'), textResponse('ok')]);
    const daemon = await bootDaemon(provider, capture);
    try {
      // Boot: the record is unpaired, so admission must report pairing-only — NOT admitted. A boot
      // that claimed 'admitted' here would be asserting a clinical runtime it deliberately did not build.
      expect(events).toContainEqual(
        expect.objectContaining({ stage: 'owner-admission', outcome: 'pairing-only' }),
      );
      expect(events).toContainEqual(expect.objectContaining({ stage: 'start-stop', outcome: 'started' }));

      // A stranger in a group is refused at admission, and the contract records which reason.
      await deliver({
        channel: 'telegram', chatType: 'group', eventId: 'telegram:group-999:g1',
        chatId: 'group-999', userId: 'nobody', text: 'what is my blood pressure?',
      });
      expect(events).toContainEqual(
        expect.objectContaining({ stage: 'owner-admission', outcome: 'refused', reason: 'non-private-chat' }),
      );
      // …and nothing about their question reached a provider or the transcript.
      expect(replies.join(' ')).not.toMatch(/blood pressure/i);

      // The owner pairs over the real inbound path.
      await deliver(telegramMessage(owner.chatId, owner.userId, 'p1', pairingCode as string));
      expect(events).toContainEqual(expect.objectContaining({ stage: 'pairing', outcome: 'paired' }));

      // An owner turn: admission admits, with a real measured duration.
      await deliver(telegramMessage(owner.chatId, owner.userId, 'm1', 'I slept badly last night'));
      expect(events).toContainEqual(expect.objectContaining({ stage: 'owner-admission', outcome: 'admitted' }));
    } finally {
      await daemon.shutdown();
    }

    // Stop is reported too, so an operator can tell a clean shutdown from a dropped process.
    expect(events).toContainEqual(expect.objectContaining({ stage: 'start-stop', outcome: 'stopped' }));

    // The privacy half of the contract, over the REAL emitted stream: nothing identifier-shaped.
    const serialized = JSON.stringify(events);
    for (const secret of [owner.chatId, owner.userId, fixture.ownerRecord, fixture.baseDir, pairingCode as string]) {
      expect(serialized).not.toContain(secret);
    }
    // And every event is well-formed against the closed shape, with a real duration.
    expect(events.length).toBeGreaterThan(4);
    for (const event of events) {
      expect(Number.isFinite(event.durationMs)).toBe(true);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);

  it('refuses to start a second daemon while the first holds the installation', async () => {
    expect((await setup()).code).toBe(0);

    const provider = new ScriptedProvider([textResponse('ok')]);
    const first = await bootDaemon(provider);
    try {
      await expect(bootDaemon(provider)).rejects.toThrow(/holds this config resource/);
    } finally {
      await first.shutdown();
    }

    // After shutdown the same start succeeds again, so the refusal was ownership and not damage.
    const second = await bootDaemon(provider);
    expect(second.kind).toBe('owned');
    await second.shutdown();
  }, 120_000);

  it('releases ownership only once an in-flight turn has settled (residual R-10)', async () => {
    expect((await setup()).code).toBe(0);
    const issued = await cli(['--config', fixture.configPath, 'pairing', 'issue']);
    const pairingCode = issued.output.match(/\n\s{4}([A-Z2-9]{8})\s/)![1];
    expect(
      await admissionFor().handlePairing(identityFor(OWNER_CHAT, OWNER_USER, 'bind-1'), pairingCode),
    ).toMatchObject({ kind: 'paired' });

    const provider = new ScriptedProvider([textResponse('Noted.')]);

    // A provider whose chat() blocks on a controllable gate: a REAL in-flight turn, not a stub
    // of one. This is the deterministic continuation T2 could not build without this seam.
    let openGate = (): void => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let entered = false;
    // The gate must swallow only THIS turn. Boot probes the provider before the turn starts, so a
    // blanket gate would be consumed by the readiness check and the turn would run unblocked.
    const TURN_MARKER = 'a real turn that will still be running';
    const gatedProvider: LLMProvider = {
      modelName: 'gated',
      chat: async (messages) => {
        const prompt = messages.map((message) => message.content).join('\n');
        if (!prompt.includes(TURN_MARKER)) return textResponse('Noted.');
        entered = true;
        await gate;
        return textResponse('Noted.');
      },
      embed: async () => new Array(768).fill(0),
    };

    const config = await loadRuntimeConfig({ configPath: fixture.configPath });
    const daemon = await startDaemon({
      services: new InstallationService(new DirectoryLease()),
      configPath: fixture.configPath,
      homeDir: root,
      createGateway: () => {
        const gateway = new Gateway(config, {
          admission: admissionFor(),
          ownerId: asProfileId(fixture.ownerId)!,
          createProvider: (cfg) => (cfg === config.providers.main ? gatedProvider : provider),
        });
        return gateway;
      },
    });

    // Onboarding is completed through the same inbound path first, so the gated call below is a
    // real AGENT turn rather than another canned onboarding question.
    await daemon.gateway.deliverMessage(
      telegramMessage(OWNER_CHAT, OWNER_USER, 'r10-skip', 'skip'),
      async () => undefined,
    );
    const turn = daemon.gateway.deliverMessage(
      telegramMessage(OWNER_CHAT, OWNER_USER, 'r10', 'a real turn that will still be running'),
      async () => undefined,
    );
    // Wait until the gated provider is genuinely inside the turn.
    for (let i = 0; i < 400 && !entered; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(entered).toBe(true);

    // While the turn is in flight the disposition is pending, not quiescent.
    expect(daemon.gateway.getShutdownDisposition()).toBe('pending');
    expect(daemon.gateway.shutdownWorkInFlight().turns).toBeGreaterThan(0);

    // Shutdown observes the disposition, gives the in-flight turn its chance, and then RETAINS
    // ownership rather than releasing it under a live turn. That is the behaviour the residual
    // asked for, so the assertions are about the lease, not about shutdown hanging.
    await daemon.shutdown();
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);
    expect(daemon.gateway.shutdownWorkInFlight().turns).toBeGreaterThan(0);

    // Let the turn finish. Only once it has settled may ownership be released.
    openGate();
    await turn;
    await daemon.shutdown();

    expect(daemon.gateway.shutdownWorkInFlight().turns).toBe(0);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
  }, 120_000);
});