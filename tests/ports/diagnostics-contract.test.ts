// What a reader of the diagnostic log relies on: an event never carries an identifier, code or path;
// a refusal always says why; the console line holds only allowlisted fields; and a failing sink can
// never change a pairing or admission decision (the sink runs while a stranger is talking to the process).

import type { DiagnosticSink, DiagnosticEvent } from '../../src/ports/diagnostics';
import { CryptoPairingCodePort, FileOwnerStatePort, ConsoleDiagnosticSink } from '../../src/runtime';
import { OwnerAdmissionService } from '../../src/profiles';
import type { Clock } from '../../src/ports/clock';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { ownerRecordPathFor } from '../helpers/owner-authority-fixture';

// Synthetic markers: if any of these appears in a diagnostic, the contract has been breached.
const OWNER_CHAT = 'stranger-owned-chat-9f3a';
const SENDER = 'stranger-sender-4b2c';
const OWNER_ID = 'sentry-owner-7f4c2a';

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

const fixedClock: Clock = { now: () => new Date('2026-10-03T09:00:00Z') };

describe('console diagnostic line', () => {
  it('prints only allowlisted fields, drops out-of-vocabulary or out-of-range events, and never throws', () => {
    const lines: string[] = [];
    const sink = new ConsoleDiagnosticSink(line => { lines.push(line); });
    const valid = { stage: 'pairing', outcome: 'limited', reason: 'daily-allowance-spent', attempts: 3, durationMs: 7 };

    sink.emit({ ...valid, path: 'unchecked_secret', error: new Error('unchecked_secret') } as DiagnosticEvent);
    for (const forged of [
      { ...valid, stage: 'unchecked_secret' }, { ...valid, outcome: 'unchecked_secret' },
      { ...valid, reason: 'unchecked_secret' }, { ...valid, attempts: 4 }, { ...valid, attempts: -1 },
      { ...valid, durationMs: Infinity }, { ...valid, durationMs: -1 },
      { stage: 'media-intake', outcome: 'saved', bytes: 10 * 1024 * 1024 + 1, durationMs: 1 },
      { stage: 'start-stop', operation: 'unchecked_secret', outcome: 'started', durationMs: 1 },
    ]) sink.emit(forged as DiagnosticEvent);

    expect(lines).toEqual(['[diagnostic] stage=pairing outcome=limited reason=daily-allowance-spent attempts=3 durationMs=7']);
    const broken = new ConsoleDiagnosticSink(() => { throw new Error('writer_error_secret'); });
    expect(() => broken.emit({ stage: 'owner-admission', outcome: 'admitted', durationMs: 1 })).not.toThrow();
  });
});

describe('diagnostics from a real pairing flow', () => {
  let root: string;

  beforeEach(() => { root = makeTestTemp('diagnostics-contract'); });
  afterEach(() => { removeTestTemp(root); });

  function admissionWith(recordRoot: string, sink: DiagnosticSink): OwnerAdmissionService {
    return new OwnerAdmissionService({
      store: new FileOwnerStatePort(ownerRecordPathFor(recordRoot), OWNER_ID),
      codes: new CryptoPairingCodePort(),
      clock: fixedClock,
      expectedOwnerId: OWNER_ID,
      diagnostics: sink,
    });
  }

  async function pairOwner(admission: OwnerAdmissionService) {
    await admission.initialize();
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('must issue a code');
    return { issued, result: await admission.handlePairing(OWNER_IDENTITY, issued.plaintext) };
  }

  it('emits no identifier, code or path, and gives every refusal a reason', async () => {
    const seen: DiagnosticEvent[] = [];
    const admission = admissionWith(root, { emit: (event) => { seen.push(event); } });

    const { issued } = await pairOwner(admission);
    expect(admission.inspect(STRANGER_IDENTITY).kind).toBe('refused');
    await admission.handlePairing(STRANGER_IDENTITY, 'not a code');

    expect(seen.length).toBeGreaterThan(0);
    const serialized = seen.map((event) => JSON.stringify(event)).join('\n');
    for (const forbidden of [OWNER_CHAT, SENDER, 'group-77', issued.plaintext, OWNER_ID, root, '.state']) {
      expect(serialized).not.toContain(forbidden);
    }
    for (const event of seen) {
      expect(event.stage.length).toBeGreaterThan(0);
      expect(Number.isFinite(event.durationMs)).toBe(true);
    }
    const refusals = seen.filter((event) => (event as { outcome: string }).outcome === 'refused');
    expect(refusals.length).toBeGreaterThan(0);
    for (const event of refusals) expect((event as { reason?: string }).reason).toEqual(expect.any(String));
  });

  it('pairs the owner and refuses a stranger with the same outcome when every emission throws', async () => {
    const seen: DiagnosticEvent[] = [];
    const admission = admissionWith(root, {
      emit(event): void {
        seen.push(event);
        throw new Error('sink failure: ENOSPC');
      },
    });

    const { result } = await pairOwner(admission);

    expect(result.kind).toBe('paired');
    expect(admission.inspect(STRANGER_IDENTITY).kind).toBe('refused');
    const readBack = new FileOwnerStatePort(ownerRecordPathFor(root), OWNER_ID).read();
    expect(readBack.kind === 'available' && readBack.state.phase).toBe('bound');
    expect(seen.length).toBeGreaterThan(0);
  });
});
