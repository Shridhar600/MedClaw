// tests/profiles/owner-enrollment.test.ts
//
// The S1 enrollment contract, exercised through the real collaborators: a real file-backed
// owner record (`FileOwnerStatePort`), the real salted-SHA-256 code port, and a real service
// reloaded from disk between attempts so restart behaviour is actually tested.
//
// Nothing here mocks the policy under test. The only controlled inputs are the clock (so UTC day
// rollover and 24-hour expiry are provable) and deliberate write faults (so the commit/uncertain
// branches are reachable at all).
//
// Temp data lives inside the workspace via `makeTestTemp`, never in `/tmp` or `$HOME`.

import * as fs from 'fs';
import * as path from 'path';

import {
  CryptoPairingCodePort,
  FileOwnerStatePort,
} from '../../src/runtime/adapters';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import type { Clock } from '../../src/ports/clock';
import {
  PAIRING_CODE_EXPIRY_MS,
  PAIRING_MAX_CANDIDATE_CHATS,
  type OwnerState,
  type OwnerStatePort,
  type PairingResult,
  type TransportIdentity,
} from '../../src/ports/owner-state';
import {
  OwnerAdmissionService,
  asProfileId,
  decodeOwnerState,
  isWellFormedSubmission,
  resolveOwnerPaths,
} from '../../src/profiles';

const OWNER_ID = 'default';

function ownerAt(root: string, ownerId = OWNER_ID) {
  return resolveOwnerPaths(root, asProfileId(ownerId)!);
}

/** Mutable clock so day rollover and expiry are exact rather than slept through. */
class TestClock implements Clock {
  constructor(private instant: Date) {}
  now(): Date {
    return new Date(this.instant);
  }
  advanceMs(ms: number): void {
    this.instant = new Date(this.instant.getTime() + ms);
  }
  setTo(instant: Date): void {
    this.instant = new Date(instant);
  }
}

function identity(overrides: Partial<TransportIdentity> = {}): TransportIdentity {
  return {
    channel: 'telegram',
    chatId: 'chat-1',
    userId: 'user-1',
    chatType: 'private',
    eventId: 'telegram:chat-1:1',
    ...overrides,
  };
}

const START = new Date('2026-03-01T10:00:00.000Z');

/**
 * A well-formed submission that is not the issued code. It must use only symbols from
 * `PAIRING_CODE_SYMBOLS` — the alphabet deliberately omits I, O, 0 and 1, so a code containing
 * one of those is not a code at all and would be answered with the prompt, not "invalid".
 */
const WRONG_CODE = 'AAAAAAAA';

interface Harness {
  root: string;
  recordPath: string;
  store: FileOwnerStatePort;
  codes: CryptoPairingCodePort;
  clock: TestClock;
  outcomes: string[];
  /** A brand new service over the same on-disk record — this is how "restart" is tested. */
  reopen(): OwnerAdmissionService;
  readRecord(): OwnerState | undefined;
  /** Narrowed accessors, so a test never re-reads a union and asserts through a cast. */
  boundRecord(): Extract<OwnerState, { phase: 'bound' }> | undefined;
  unpairedRecord(): Extract<OwnerState, { phase: 'unpaired' }> | undefined;
  rawBytes(): Buffer;
}

function makeHarness(root: string, clock = new TestClock(START)): Harness {
  const paths = ownerAt(root);
  const store = new FileOwnerStatePort(paths.ownerRecord, OWNER_ID);
  const codes = new CryptoPairingCodePort();
  const outcomes: string[] = [];
  const build = (): OwnerAdmissionService =>
    new OwnerAdmissionService({
      store,
      codes,
      clock,
      expectedOwnerId: OWNER_ID,
      diagnostics: {
        recordPairingOutcome: (event) => outcomes.push(`${event.result}:${event.chatType}`),
      },
    });
  return {
    root,
    recordPath: paths.ownerRecord,
    store,
    codes,
    clock,
    outcomes,
    reopen: build,
    readRecord: () => {
      const read = store.read();
      return read.kind === 'available' ? read.state : undefined;
    },
    boundRecord: () => {
      const read = store.read();
      return read.kind === 'available' && read.state.phase === 'bound' ? read.state : undefined;
    },
    unpairedRecord: () => {
      const read = store.read();
      return read.kind === 'available' && read.state.phase === 'unpaired' ? read.state : undefined;
    },
    rawBytes: () => fs.readFileSync(paths.ownerRecord),
  };
}

describe('owner enrollment: a record must exist before anything is served', () => {
  let root: string;
  let harness: Harness;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-enrollment');
    harness = makeHarness(root);
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  it('refuses when no record exists instead of treating it as a fresh installation', () => {
    const decision = harness.reopen().inspect(identity());

    expect(decision).toEqual({ kind: 'refused', reason: 'unavailable' });
    expect(fs.existsSync(harness.recordPath)).toBe(false);
  });

  it('creates the unpaired record only when setup explicitly asks for it', async () => {
    const service = harness.reopen();

    expect(await service.initialize()).toBe('created');
    expect(harness.readRecord()).toMatchObject({ phase: 'unpaired', ownerId: OWNER_ID, version: 1 });
    expect(await service.initialize()).toBe('exists');
    expect(harness.reopen().inspect(identity())).toEqual({ kind: 'pairing-only' });
  });

  it('refuses a corrupt record and leaves its bytes untouched rather than quarantining it away', () => {
    fs.mkdirSync(path.dirname(harness.recordPath), { recursive: true, mode: 0o700 });
    const corrupt = Buffer.from('{"version":1,"ownerId":"default","phase":');
    fs.writeFileSync(harness.recordPath, corrupt, { mode: 0o600 });

    expect(harness.store.read()).toEqual({ kind: 'unavailable', reason: 'invalid-document' });
    expect(harness.reopen().inspect(identity())).toEqual({ kind: 'refused', reason: 'unavailable' });

    // Not renamed aside, not deleted, not replaced: an operator still sees what was there.
    expect(fs.readdirSync(path.dirname(harness.recordPath))).toEqual(['owner-access.json']);
    expect(fs.readFileSync(harness.recordPath)).toEqual(corrupt);
  });

  it('refuses a record belonging to another owner and does not adopt it', () => {
    fs.mkdirSync(path.dirname(harness.recordPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      harness.recordPath,
      JSON.stringify({
        version: 1,
        ownerId: 'someone-else',
        createdAt: START.toISOString(),
        phase: 'unpaired',
        attempts: { day: '2026-03-01', chats: [] },
      }),
      { mode: 0o600 },
    );

    expect(harness.store.read()).toEqual({ kind: 'unavailable', reason: 'owner-mismatch' });
    expect(harness.reopen().inspect(identity())).toEqual({ kind: 'refused', reason: 'owner-mismatch' });
  });

  it('treats a missing or unrecognised phase as invalid, not as unpaired', () => {
    for (const phase of [undefined, '', 'pending', 3, null]) {
      const document: Record<string, unknown> = {
        version: 1,
        ownerId: OWNER_ID,
        createdAt: START.toISOString(),
        attempts: { day: '2026-03-01', chats: [] },
      };
      if (phase !== undefined) document.phase = phase;

      expect(decodeOwnerState(document, OWNER_ID)).toEqual({ kind: 'invalid' });
    }
  });

  it('stores the code as a salted verifier, owner-only, and never as plaintext', async () => {
    const service = harness.reopen();
    await service.initialize();

    const issued = await service.issueChallenge();

    expect(issued.kind).toBe('issued');
    if (issued.kind !== 'issued') throw new Error('unreachable');

    expect(isWellFormedSubmission(issued.plaintext)).toBe(true);
    const raw = fs.readFileSync(harness.recordPath, 'utf8');
    expect(raw).not.toContain(issued.plaintext);
    expect(harness.readRecord()).toMatchObject({
      phase: 'unpaired',
      challenge: { verifier: expect.stringMatching(/^v1:[0-9a-f]{32}:[0-9a-f]{64}$/) },
    });
    expect(fs.statSync(harness.recordPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(harness.recordPath)).mode & 0o777).toBe(0o700);

    // 24-hour expiry, measured from issue.
    expect(new Date(issued.expiresAt).getTime() - START.getTime()).toBe(PAIRING_CODE_EXPIRY_MS);
  });

  it('records no code, no identifier and no exception text in its bounded outcome channel', async () => {
    const service = harness.reopen();
    await service.initialize();
    const issued = await service.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');

    await service.handlePairing(identity({ eventId: 'telegram:chat-1:9' }), WRONG_CODE);

    expect(harness.outcomes).toEqual(['invalid:private']);
    // Only "<result>:<chatType>" is ever emitted — no chat, no sender, no code.
    for (const entry of harness.outcomes) {
      expect(entry).not.toContain('chat-1');
      expect(entry).not.toContain('user-1');
    }
    expect(JSON.stringify(harness.outcomes)).not.toContain(WRONG_CODE);
  });
});

describe('owner enrollment: admission before any clinical work', () => {
  let root: string;
  let harness: Harness;

  beforeEach(async () => {
    root = makeTestTemp('socs-s1-admission');
    harness = makeHarness(root);
    await harness.reopen().initialize();
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  it('admits an unpaired private chat to pairing only, and never to the owner', () => {
    expect(harness.reopen().inspect(identity())).toEqual({ kind: 'pairing-only' });
  });

  it('refuses group, supergroup and channel traffic with no health state of any kind', () => {
    const service = harness.reopen();
    for (const chatType of ['group', 'supergroup', 'channel'] as const) {
      expect(service.inspect(identity({ chatType }))).toEqual({
        kind: 'refused',
        reason: 'non-private-chat',
      });
    }
  });

  it('refuses a request whose transport identity is missing or over-long', () => {
    const service = harness.reopen();

    expect(service.inspect(identity({ eventId: '' }))).toEqual({
      kind: 'refused',
      reason: 'missing-transport-identity',
    });
    expect(service.inspect(identity({ chatId: 'x'.repeat(33) }))).toEqual({
      kind: 'refused',
      reason: 'missing-transport-identity',
    });
    expect(service.inspect(identity({ userId: '' }))).toEqual({
      kind: 'refused',
      reason: 'missing-transport-identity',
    });
  });

  it('binds once on the first correct code and never grants a second chat the owner', async () => {
    const service = harness.reopen();
    const issued = await service.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');

    const result = await service.handlePairing(identity(), issued.plaintext);

    expect(result).toEqual({ kind: 'paired', boundOwnerId: OWNER_ID });
    expect(harness.readRecord()).toMatchObject({
      phase: 'bound',
      binding: {
        channel: 'telegram',
        chatId: 'chat-1',
        senderId: 'user-1',
        boundAt: START.toISOString(),
        pairingEventId: 'telegram:chat-1:1',
      },
    });
    // The consumed challenge and the allowance are gone with the phase change.
    expect(JSON.stringify(harness.readRecord())).not.toContain('verifier');

    expect(harness.reopen().inspect(identity())).toEqual({ kind: 'owner', ownerId: OWNER_ID });
    expect(harness.reopen().inspect(identity({ chatId: 'stranger', eventId: 'e2' }))).toEqual({
      kind: 'refused',
      reason: 'already-bound',
    });
  });

  it('answers a replayed pairing event with pairing-complete rather than binding twice', async () => {
    const service = harness.reopen();
    const issued = await service.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');

    await service.handlePairing(identity(), issued.plaintext);
    const boundAt = harness.boundRecord()?.binding.boundAt;

    const replay = await harness.reopen().handlePairing(identity(), issued.plaintext);

    expect(replay).toEqual({ kind: 'already-paired' });
    expect(harness.boundRecord()?.binding.boundAt).toBe(boundAt);
  });

  it('never writes a stranger into the record while the owner is already bound', async () => {
    const service = harness.reopen();
    const issued = await service.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    await service.handlePairing(identity(), issued.plaintext);
    const bytesAfterBinding = harness.rawBytes();

    const stranger = await harness.reopen().handlePairing(
      identity({ chatId: 'stranger-chat', userId: 'stranger-user', eventId: 'telegram:stranger-chat:5' }),
      issued.plaintext,
    );

    expect(stranger).toEqual({ kind: 'refused' });
    expect(harness.rawBytes()).toEqual(bytesAfterBinding);
  });

  it('refuses a reissue once bound, because rebinding is not supported in S1', async () => {
    const service = harness.reopen();
    const issued = await service.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    await service.handlePairing(identity(), issued.plaintext);

    expect(await service.issueChallenge()).toEqual({ kind: 'refused', reason: 'already-bound' });
  });

  it('refuses group traffic even when the text is a valid code', async () => {
    const service = harness.reopen();
    const issued = await service.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');

    const result = await service.handlePairing(
      identity({ chatType: 'group', chatId: 'group-1', eventId: 'telegram:group-1:7' }),
      issued.plaintext,
    );

    expect(result).toEqual({ kind: 'refused' });
    expect(harness.readRecord()?.phase).toBe('unpaired');
  });
});

describe('owner enrollment: the attempt allowance is durable, reserved first, and daily', () => {
  let root: string;
  let harness: Harness;

  beforeEach(async () => {
    root = makeTestTemp('socs-s1-allowance');
    harness = makeHarness(root);
    await harness.reopen().initialize();
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  async function issueCode(): Promise<string> {
    const issued = await harness.reopen().issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    return issued.plaintext;
  }

  it('spends an attempt on a wrong code, so the allowance is reserved before verification', async () => {
    const service = harness.reopen();
    await issueCode();

    expect(await service.handlePairing(identity({ eventId: 'e1' }), 'AAAAAAAA')).toEqual({
      kind: 'invalid',
    });

    expect(harness.unpairedRecord()?.attempts.chats[0].attempts).toBe(1);
  });

  it('refuses the fourth attempt even when the code is correct, across a restart', async () => {
    const service = harness.reopen();
    const code = await issueCode();

    for (const attempt of [1, 2, 3]) {
      expect(await service.handlePairing(identity({ eventId: `e${attempt}` }), WRONG_CODE)).toEqual({
        kind: 'invalid',
      });
    }
    expect(harness.readRecord()?.phase).toBe('unpaired');

    // Restart: a brand new service reading the same bytes must not hand out a 4th attempt.
    const afterRestart = await harness.reopen().handlePairing(identity({ eventId: 'e4' }), code);

    expect(afterRestart).toEqual({ kind: 'limited' });
    expect(harness.readRecord()?.phase).toBe('unpaired');
  });

  it('gives a new UTC day a fresh allowance and expires the old rows', async () => {
    const service = harness.reopen();
    const code = await issueCode();
    for (const attempt of [1, 2, 3]) {
      await service.handlePairing(identity({ eventId: `e${attempt}` }), WRONG_CODE);
    }
    expect(await service.handlePairing(identity({ eventId: 'e4' }), code)).toEqual({ kind: 'limited' });

    harness.clock.setTo(new Date('2026-03-02T10:00:00.000Z'));
    const day2 = await harness.reopen().issueChallenge();
    if (day2.kind !== 'issued') throw new Error('unreachable');

    // A brand new day has a fresh allowance, so the 5th attempt of that day is judged on merit
    // rather than refused by yesterday's exhausted limit.
    expect(await harness.reopen().handlePairing(identity({ eventId: 'e5' }), day2.plaintext)).toEqual({
      kind: 'paired',
      boundOwnerId: OWNER_ID,
    });
  });

  it('expires the previous day\'s rows rather than carrying the allowance forward', async () => {
    const service = harness.reopen();
    await issueCode();
    for (const attempt of [1, 2, 3]) {
      await service.handlePairing(identity({ eventId: `e${attempt}` }), WRONG_CODE);
    }

    harness.clock.setTo(new Date('2026-03-02T09:00:00.000Z'));
    expect(await harness.reopen().handlePairing(identity({ eventId: 'e4' }), WRONG_CODE)).toEqual({
      kind: 'invalid',
    });

    const record = harness.unpairedRecord();
    expect(record?.attempts.day).toBe('2026-03-02');
    expect(record?.attempts.chats).toHaveLength(1);
    expect(record?.attempts.chats[0].attempts).toBe(1);
  });

  it('does not let a reissue reset today\'s allowance', async () => {
    const service = harness.reopen();
    for (const attempt of [1, 2, 3]) {
      await service.handlePairing(identity({ eventId: `e${attempt}` }), WRONG_CODE);
    }

    const reissued = await service.issueChallenge();
    if (reissued.kind !== 'issued') throw new Error('unreachable');

    expect(await harness.reopen().handlePairing(identity({ eventId: 'e4' }), reissued.plaintext))
      .toEqual({ kind: 'limited' });
  });

  it('does not spend a second attempt for a redelivered transport event', async () => {
    const service = harness.reopen();
    await issueCode();

    const first = await service.handlePairing(identity({ eventId: 'same-event' }), WRONG_CODE);
    const redelivered = await harness.reopen().handlePairing(identity({ eventId: 'same-event' }), WRONG_CODE);

    expect(first).toEqual({ kind: 'invalid' });
    expect(redelivered).toEqual({ kind: 'prompt' });
    expect(harness.unpairedRecord()?.attempts.chats[0].attempts).toBe(1);
  });

  it('spends the same allowance on a non-code prompt, so there is no free prompt channel', async () => {
    await issueCode();

    for (const eventId of ['p1', 'p2', 'p3']) {
      expect(await harness.reopen().handlePairing(identity({ eventId }), 'hello, is anyone there?'))
        .toEqual({ kind: 'prompt' });
    }
    expect(await harness.reopen().handlePairing(identity({ eventId: 'p4' }), 'hello again?')).toEqual({
      kind: 'limited',
    });
  });

  it('refuses a 257th candidate chat instead of evicting one that still holds its limit', async () => {
    await issueCode();

    for (let index = 0; index < PAIRING_MAX_CANDIDATE_CHATS; index += 1) {
      const result = await harness.reopen().handlePairing(
        identity({ chatId: `chat-${index}`, userId: `user-${index}`, eventId: `e-${index}` }),
        'hello',
      );
      expect(result).toEqual({ kind: 'prompt' });
    }

    expect(harness.unpairedRecord()?.attempts.chats).toHaveLength(PAIRING_MAX_CANDIDATE_CHATS);

    // The 257th is refused outright; nothing already tracked is dropped.
    expect(await harness.reopen().handlePairing(
      identity({ chatId: 'chat-overflow', userId: 'user-overflow', eventId: 'e-overflow' }),
      'hello',
    )).toEqual({ kind: 'limited' });
    expect(harness.unpairedRecord()?.attempts.chats).toHaveLength(PAIRING_MAX_CANDIDATE_CHATS);
  });

  it('reports an expired code as expired rather than invalid', async () => {
    const service = harness.reopen();
    const code = await issueCode();

    harness.clock.setTo(new Date(START.getTime() + PAIRING_CODE_EXPIRY_MS));

    expect(await service.handlePairing(identity({ eventId: 'e1' }), code)).toEqual({ kind: 'expired' });
    expect(harness.readRecord()?.phase).toBe('unpaired');
  });

  it('binds with a reissued code after expiry', async () => {
    const service = harness.reopen();
    const stale = await issueCode();
    harness.clock.setTo(new Date(START.getTime() + PAIRING_CODE_EXPIRY_MS));
    await service.handlePairing(identity({ eventId: 'e1' }), stale);

    harness.clock.setTo(new Date('2026-03-02T09:00:00.000Z'));
    const fresh = await harness.reopen().issueChallenge();
    if (fresh.kind !== 'issued') throw new Error('unreachable');

    expect(await harness.reopen().handlePairing(identity({ eventId: 'e2' }), fresh.plaintext)).toEqual({
      kind: 'paired',
      boundOwnerId: OWNER_ID,
    });
  });

  it('accepts a retyped code that differs only in case and surrounding whitespace', async () => {
    const service = harness.reopen();
    const issued = await service.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');

    const retyped = `  ${issued.plaintext.toLowerCase()} `;
    expect(await harness.reopen().handlePairing(identity(), retyped)).toEqual({
      kind: 'paired',
      boundOwnerId: OWNER_ID,
    });
  });

  it('does not verify a malformed submission against the verifier', () => {
    expect(isWellFormedSubmission('ABCDEFG')).toBe(false);
    expect(isWellFormedSubmission('ABCDEFGH')).toBe(true);
    expect(isWellFormedSubmission('ABCDEFG1')).toBe(false);
    expect(isWellFormedSubmission('ABCDEFGHI')).toBe(false);
    expect(isWellFormedSubmission('abcdefgh')).toBe(true);
  });
});

describe('owner enrollment: commit outcomes are distinguished from uncertainty', () => {
  let root: string;
  let clock: TestClock;
  let recordPath: string;

  beforeEach(async () => {
    root = makeTestTemp('socs-s1-commit');
    clock = new TestClock(START);
    const paths = ownerAt(root);
    recordPath = paths.ownerRecord;
    const seed = new FileOwnerStatePort(recordPath, OWNER_ID);
    const seeder = new OwnerAdmissionService({
      store: seed,
      codes: new CryptoPairingCodePort(),
      clock,
      expectedOwnerId: OWNER_ID,
      diagnostics: { recordPairingOutcome: () => {} },
    });
    await seeder.initialize();
    const issued = await seeder.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    fs.writeFileSync(
      path.join(root, 'code.txt'),
      issued.plaintext,
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  function code(): string {
    return fs.readFileSync(path.join(root, 'code.txt'), 'utf8');
  }

  /** A store whose `replace` fails in a chosen way before touching the disk. */
  function failingStore(failure: (error: NodeJS.ErrnoException) => void): OwnerStatePort {
    const real = new FileOwnerStatePort(recordPath, OWNER_ID);
    return {
      read: () => real.read(),
      replace: async () => {
        const error: NodeJS.ErrnoException = new Error('injected write fault');
        failure(error);
        throw error;
      },
    };
  }

  function serviceOver(store: OwnerStatePort): OwnerAdmissionService {
    return new OwnerAdmissionService({
      store,
      codes: new CryptoPairingCodePort(),
      clock,
      expectedOwnerId: OWNER_ID,
      diagnostics: { recordPairingOutcome: () => {} },
    });
  }

  it('refuses without binding when the write demonstrably failed', async () => {
    const service = serviceOver(
      failingStore((error) => {
        error.code = 'EACCES';
      }),
    );

    const result: PairingResult = await service.handlePairing(identity(), code());

    expect(result).toEqual({ kind: 'unavailable' });
    const reread = new FileOwnerStatePort(recordPath, OWNER_ID).read();
    expect(reread.kind === 'available' && reread.state.phase).toBe('unpaired');
  });

  it('binds when an uncertain write turns out to have landed, instead of undoing it', async () => {
    // The fault is thrown AFTER a successful replacement: the acknowledgement fails, the binding
    // is real. The service must reload and report the truth.
    const real = new FileOwnerStatePort(recordPath, OWNER_ID);
    let boundWriteAcknowledged = false;
    const store: OwnerStatePort = {
      read: () => real.read(),
      replace: async (next: OwnerState) => {
        await real.replace(next);
        if (next.phase === 'bound') {
          boundWriteAcknowledged = true;
          const error: NodeJS.ErrnoException = new Error('acknowledgement lost after commit');
          throw error;
        }
      },
    };

    const service = serviceOver(store);
    const result = await service.handlePairing(identity(), code());

    expect(boundWriteAcknowledged).toBe(true);
    expect(result).toEqual({ kind: 'paired', boundOwnerId: OWNER_ID });
    const after = real.read();
    expect(after.kind === 'available' && after.state.phase).toBe('bound');
  });

  it('never prints a code as issued when the record could not be committed', async () => {
    const real = new FileOwnerStatePort(recordPath, OWNER_ID);
    const before = real.read();
    const verifierBefore = before.kind === 'available' && before.state.phase === 'unpaired'
      ? before.state.challenge?.verifier
      : undefined;

    const service = serviceOver(
      failingStore((error) => {
        error.code = 'ENOSPC';
      }),
    );

    const issued = await service.issueChallenge();

    expect(issued).toEqual({ kind: 'refused', reason: 'uncertain' });
    const after = real.read();
    const verifierAfter = after.kind === 'available' && after.state.phase === 'unpaired'
      ? after.state.challenge?.verifier
      : undefined;
    // The record still holds exactly the code that was issued earlier — never a code the caller
    // was not shown.
    expect(verifierAfter).toBe(verifierBefore);
    expect(verifierAfter).toBeDefined();
  });

  it('refuses to serve when the record cannot be read at all', async () => {
    const service = serviceOver({
      read: () => ({ kind: 'unavailable', reason: 'unreadable' }),
      replace: async () => {
        throw new Error('must not be reached');
      },
    });

    expect(service.inspect(identity())).toEqual({ kind: 'refused', reason: 'unavailable' });
    expect(await service.handlePairing(identity(), code())).toEqual({ kind: 'unavailable' });
    expect(await service.issueChallenge()).toEqual({ kind: 'refused', reason: 'unavailable' });
  });
});