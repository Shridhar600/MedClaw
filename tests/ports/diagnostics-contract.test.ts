// tests/ports/diagnostics-contract.test.ts
//
// Contract tests for the diagnostic sink (specs/16 §6 tier 2, plan 15 §7).
//
// Why these earn their place: the sink sits on the admission path, which runs while a stranger is
// talking to the process. Two failure modes follow from that and neither is covered anywhere else:
//
//   1. A sink that THROWS becomes reachable from a stranger's message. Because `emit` is called
//      inside `admit()`, an exception does not merely lose a log line — it unwinds the decision and
//      turns an observability bug into a denial-of-service lever. Proven here through the real
//      enrollment state machine and the real file store, asserting the DECISION, the REPLY TEXT and
//      the DURABLE RECORD all survive a sink that throws on every single event.
//
//   2. A sink that carries arbitrary content is a leak and an oracle. Even without a path or an
//      exception payload, a chat id in a log line is a rate-limit oracle and a pairing code in a log
//      line is the code. Proven by serializing every emitted event from a real pairing flow and
//      asserting none of the synthetic identity markers appear anywhere in it.
//
// These are flow tests on purpose. A test that constructs a bare object and calls `emit` on it would
// assert that TypeScript compiles, which is not the property at risk.

import { DiagnosticSink, guardedDiagnosticSink } from '../../src/ports/diagnostics';
import type { DiagnosticEvent } from '../../src/ports/diagnostics';
import { CryptoPairingCodePort, FileOwnerStatePort, ConsoleDiagnosticSink } from '../../src/runtime';
import { OwnerAdmissionService } from '../../src/profiles';
import type { Clock } from '../../src/ports/clock';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { ownerRecordPathFor } from '../helpers/owner-authority-fixture';

// Synthetic markers. If any of these appear in a diagnostic, the contract has been breached.
const OWNER_CHAT = 'stranger-owned-chat-9f3a';
const SENDER = 'stranger-sender-4b2c';
const PAIRING_CODE = 'K7MQRTVX';
// Distinctive on purpose: an earlier version of this file used OWNER_ID, which is a substring of the
// STAGE name 'owner-admission' and so could never have detected an owner-id leak.
const OWNER_ID = 'sentry-owner-7f4c2a';

describe('C09 console diagnostic edge', () => {
  it('checks runtime vocabulary/numeric bounds without copying unchecked fields, and never throws', () => {
    // Distinct invariant: runtime values can defeat TypeScript. Flow tests cannot supply forged
    // events without replacing the policy under test. Check the adapter's actual output boundary.
    const lines: string[] = [];
    const sink = new ConsoleDiagnosticSink(line => { lines.push(line); });
    const valid = { stage: 'pairing', outcome: 'limited', reason: 'daily-allowance-spent', attempts: 3, durationMs: 7 };
    sink.emit({ ...valid, path: 'C09_unchecked_secret', error: new Error('C09_unchecked_secret') } as DiagnosticEvent);
    expect(lines).toEqual(['[diagnostic] stage=pairing outcome=limited reason=daily-allowance-spent attempts=3 durationMs=7']);
    for (const forged of [
      { ...valid, stage: 'C09_unchecked_secret' }, { ...valid, outcome: 'C09_unchecked_secret' },
      { ...valid, reason: 'C09_unchecked_secret' }, { ...valid, attempts: 4 },
      { ...valid, attempts: -1 }, { ...valid, durationMs: Infinity }, { ...valid, durationMs: -1 },
      { stage: 'media-intake', outcome: 'saved', bytes: 10 * 1024 * 1024 + 1, durationMs: 1 },
      { stage: 'start-stop', operation: 'C09_unchecked_secret', outcome: 'started', durationMs: 1 },
    ]) sink.emit(forged as DiagnosticEvent);
    expect(lines).toHaveLength(1);
    // Snapshot each checked field once: a getter must not change the value after validation.
    const changingCases: Array<[Record<string, unknown>, string, string]> = [
      [{ stage: 'owner-admission', outcome: 'refused', reason: 'unavailable', durationMs: 1 }, 'reason',
        '[diagnostic] stage=owner-admission outcome=refused reason=unavailable durationMs=1'],
      [{ stage: 'pairing', outcome: 'limited', reason: 'daily-allowance-spent', attempts: 3, durationMs: 1 }, 'reason',
        '[diagnostic] stage=pairing outcome=limited reason=daily-allowance-spent attempts=3 durationMs=1'],
      [{ stage: 'media-intake', outcome: 'refused', reason: 'source-failed', durationMs: 1 }, 'reason',
        '[diagnostic] stage=media-intake outcome=refused reason=source-failed durationMs=1'],
      [{ stage: 'start-stop', operation: 'start', outcome: 'failed', reason: 'build-failed', durationMs: 1 }, 'reason',
        '[diagnostic] stage=start-stop operation=start outcome=failed reason=build-failed durationMs=1'],
      [{ stage: 'media-intake', outcome: 'saved', bytes: 0, durationMs: 1 }, 'bytes',
        '[diagnostic] stage=media-intake outcome=saved bytes=0 durationMs=1'],
      [{ stage: 'pairing', outcome: 'limited', reason: 'daily-allowance-spent', attempts: 3, durationMs: 1 }, 'attempts',
        '[diagnostic] stage=pairing outcome=limited reason=daily-allowance-spent attempts=3 durationMs=1'],
    ];
    for (const [event, field, expected] of changingCases) {
      const first = event[field];
      let reads = 0;
      Object.defineProperty(event, field, { get: () => ++reads === 1 ? first : 'C09_changing_getter_secret' });
      const captured: string[] = [];
      new ConsoleDiagnosticSink(line => { captured.push(line); }).emit(event as unknown as DiagnosticEvent);
      expect(captured).toEqual([expected]);
      expect(reads).toBe(1);
    }
    const broken = new ConsoleDiagnosticSink(() => { throw new Error('C09_writer_error_secret'); });
    expect(() => broken.emit({ stage: 'owner-admission', outcome: 'admitted', durationMs: 1 })).not.toThrow();
  });
});

/** An adapter that always fails, the way a real one does: ENOSPC, a full disk, a bad log target. */
function throwingSink(seen: DiagnosticEvent[] = []): DiagnosticSink {
  return {
    emit(event): void {
      seen.push(event);
      throw new Error(`sink failure: ENOSPC while writing ${PAIRING_CODE}`);
    },
  };
}

function recordingSink(seen: DiagnosticEvent[]): DiagnosticSink {
  return {
    emit(event): void {
      seen.push(event);
    },
  };
}

/** A clock the test controls, so `durationMs` is a real measurement and not a wall-clock guess. */
class TestClock implements Clock {
  constructor(private instant: Date) {}
  now(): Date {
    return new Date(this.instant);
  }
  advanceMs(ms: number): void {
    this.instant = new Date(this.instant.getTime() + ms);
  }
}

const START = Date.parse('2026-10-03T09:00:00Z');

function ownerAt(root: string) {
  return { ownerRecord: ownerRecordPathFor(root) };
}

/**
 * Build the real admission service over a real record path and real crypto code port.
 * Only the sink differs between cases, so the flow under test is identical.
 */
function buildAdmission(root: string, sink: DiagnosticSink, clock = new TestClock(new Date(START))): OwnerAdmissionService {
  const paths = ownerAt(root);
  return new OwnerAdmissionService({
    store: new FileOwnerStatePort(paths.ownerRecord, OWNER_ID),
    codes: new CryptoPairingCodePort(),
    clock,
    expectedOwnerId: OWNER_ID,
    diagnostics: sink,
  });
}

const OWNER_IDENTITY = {
  channel: 'telegram',
  chatId: OWNER_CHAT,
  userId: SENDER,
  chatType: 'private' as const,
  eventId: `telegram:${OWNER_CHAT}:1`,
};

const STRANGER_IDENTITY = {
  channel: 'telegram',
  chatId: 'group-77',
  userId: 'someone-else',
  chatType: 'group' as const,
  eventId: 'telegram:group-77:1',
};

describe('diagnostic sink contract', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('diagnostics-contract');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  it('pairs an owner through the real state machine even when every diagnostic emission throws', async () => {
    // Establish the baseline first: with a silent sink this exact flow pairs.
    const control = buildAdmission(root, { emit: () => {} });
    await control.initialize();
    const controlIssued = await control.issueChallenge();
    expect(controlIssued.kind).toBe('issued');
    if (controlIssued.kind !== 'issued') throw new Error('control must issue a code');
    const controlResult = await control.handlePairing(OWNER_IDENTITY, controlIssued.plaintext);
    expect(controlResult.kind).toBe('paired');

    // Now the same flow with a sink that throws on every event, from a fresh record.
    const hostileRoot = makeTestTemp('diagnostics-hostile');
    try {
      const seen: DiagnosticEvent[] = [];
      const hostile = buildAdmission(hostileRoot, throwingSink(seen));

      await hostile.initialize();
      const issued = await hostile.issueChallenge();
      expect(issued.kind).toBe('issued');
      if (issued.kind !== 'issued') throw new Error('hostile run must still issue a code');

      const result = await hostile.handlePairing(OWNER_IDENTITY, issued.plaintext);

      // The decision is unchanged: a broken log must not stop the owner from pairing.
      expect(result.kind).toBe('paired');
      // The plaintext is returned to the local operator, which is the only place it may appear.
      expect((result as { boundOwnerId?: string }).boundOwnerId).toBe(OWNER_ID);

      // The DURABLE outcome is unchanged. This is the assertion that matters most: if the sink's
      // throw landed between "commit the binding" and "return", the process would report failure
      // while the owner was in fact bound — a record and a reply that disagree.
      const readBack = new FileOwnerStatePort(ownerRecordPathFor(hostileRoot), OWNER_ID).read();
      expect(readBack.kind).toBe('available');
      expect(readBack.kind === 'available' && readBack.state.phase).toBe('bound');

      // The sink really was exercised, so this is not a test that passes by never calling emit.
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      removeTestTemp(hostileRoot);
    }
  });

  it('still refuses a stranger with the same reply text when the sink throws', async () => {
    const paths = ownerAt(root);
    const baseline = buildAdmission(root, { emit: () => {} });
    await baseline.initialize();
    const issued = await baseline.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('baseline must issue');
    await baseline.handlePairing(OWNER_IDENTITY, issued.plaintext);
    expect(baseline.inspect(STRANGER_IDENTITY).kind).toBe('refused');

    // A stranger is the actor most able to reach the sink, so the refusal path needs the same proof.
    const hostileSeen: DiagnosticEvent[] = [];
    const hostile = new OwnerAdmissionService({
      store: new FileOwnerStatePort(paths.ownerRecord, OWNER_ID),
      codes: new CryptoPairingCodePort(),
      clock: new TestClock(new Date(START)),
      expectedOwnerId: OWNER_ID,
      diagnostics: throwingSink(hostileSeen),
    });

    const decision = hostile.inspect(STRANGER_IDENTITY);
    expect(decision.kind).toBe('refused');
    expect(hostileSeen.length).toBeGreaterThan(0);
  });

  it('never emits an identifier, a code or a path from a real pairing flow', async () => {
    const seen: DiagnosticEvent[] = [];
    const admission = buildAdmission(root, recordingSink(seen));

    await admission.initialize();
    const issued = await admission.issueChallenge();
    await admission.handlePairing(OWNER_IDENTITY, (issued as { plaintext: string }).plaintext);
    // A stranger refusal and a pairing prompt, so every outcome shape is exercised.
    admission.inspect(STRANGER_IDENTITY);
    await admission.handlePairing(STRANGER_IDENTITY, 'not a code');

    expect(seen.length).toBeGreaterThan(0);

    // Serialize the way any real sink would: a log line or a JSON record.
    const serialized = seen.map((event) => JSON.stringify(event)).join('\n');

    // No chat id, no sender id, no event id, no pairing code, no owner id, no filesystem path.
    expect(serialized).not.toContain(OWNER_CHAT);
    expect(serialized).not.toContain(SENDER);
    expect(serialized).not.toContain(`telegram:${OWNER_CHAT}`);
    expect(serialized).not.toContain('group-77');
    expect(serialized).not.toContain(PAIRING_CODE);
    expect(serialized).not.toContain(OWNER_ID);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('.state');

    // Every event is still useful: a stage, an outcome, a reason where the outcome is a refusal, and
    // a measured duration. An event that satisfied the leak checks by being empty would not be a
    // diagnostic at all.
    for (const event of seen) {
      expect(typeof event.stage).toBe('string');
      expect(event.stage.length).toBeGreaterThan(0);
      expect(typeof (event as { outcome: string }).outcome).toBe('string');
      expect(Number.isFinite(event.durationMs)).toBe(true);
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('emits a required allowlisted reason for every refusal outcome', async () => {
    const seen: DiagnosticEvent[] = [];
    const admission = buildAdmission(root, recordingSink(seen));

    await admission.initialize();
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('must issue');
    await admission.handlePairing(OWNER_IDENTITY, issued.plaintext);
    // Produce a real refusal, from both stages: a group is refused at admission, and a bad code is
    // refused at pairing. Without these the filter would legitimately find nothing.
    expect(admission.inspect(STRANGER_IDENTITY).kind).toBe('refused');
    // A group chat cannot pair at all, so the pairing outcome is `refused` (non-private-chat) rather
    // than `invalid`. Either is a refusal; what this test needs is that a refusal really happened.
    expect(await admission.handlePairing(STRANGER_IDENTITY, 'NOT-A-CODE')).toMatchObject({
      kind: expect.stringMatching(/refused|invalid/),
    });

    const refusals = seen.filter(
      (event) => (event as { outcome: string }).outcome === 'refused',
    );
    expect(refusals.length).toBeGreaterThan(0);
    for (const event of refusals) {
      // A refusal without a reason is unrepresentable in the type; assert it at runtime too, because
      // the sink is a trust boundary that a JSON-parsed or hand-built event can bypass.
      const reason = (event as { reason?: string }).reason;
      expect(typeof reason).toBe('string');
      expect(reason).not.toHaveLength(0);
    }
  });

  describe('guardedDiagnosticSink', () => {
    it('swallows an adapter throw so the observed operation cannot fail', () => {
      const guard = guardedDiagnosticSink({
        emit: () => {
          throw new Error('adapter exploded');
        },
      });

      // No throw escapes: this is the whole contract.
      expect(() =>
        guard.emit({ stage: 'start-stop', operation: 'start', outcome: 'started', durationMs: 1 }),
      ).not.toThrow();
    });

    it('forwards the event unchanged when the adapter succeeds', () => {
      const seen: DiagnosticEvent[] = [];
      const guard = guardedDiagnosticSink(recordingSink(seen));
      const event: DiagnosticEvent = { stage: 'media-intake', outcome: 'refused', reason: 'too-large', durationMs: 12 };

      guard.emit(event);

      expect(seen).toEqual([event]);
    });

    it('degrades to silence rather than to a different control path', () => {
      // A sink that throws on the FIRST event and succeeds on the second models a flaky log target.
      let calls = 0;
      const seen: DiagnosticEvent[] = [];
      const guard = guardedDiagnosticSink({
        emit: (event) => {
          calls += 1;
          if (calls === 1) throw new Error('transient');
          seen.push(event);
        },
      });

      const first: DiagnosticEvent = { stage: 'owner-admission', outcome: 'refused', reason: 'not-owner', durationMs: 3 };
      const second: DiagnosticEvent = { stage: 'owner-admission', outcome: 'admitted', durationMs: 4 };

      expect(() => guard.emit(first)).not.toThrow();
      expect(() => guard.emit(second)).not.toThrow();

      // The first event is lost, and that is the accepted cost: losing a log line must never cost a
      // decision. The sink keeps working afterwards rather than latching into a broken state.
      expect(seen).toEqual([second]);
    });
  });
});
