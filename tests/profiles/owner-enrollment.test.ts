
import * as fs from 'fs';
import * as path from 'path';

import {
  CryptoPairingCodePort,
  FileOwnerStatePort,
} from '../../src/runtime/adapters';
import type { OwnerRecordFileSync } from '../../src/runtime/adapters';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import type { Clock } from '../../src/ports/clock';
import type { DiagnosticEvent } from '../../src/ports/diagnostics';
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

// `PAIRING_CODE_SYMBOLS` omits I, O, 0 and 1, so this is answered as "not a code" rather than invalid.
const WRONG_CODE = 'AAAAAAAA';

interface Harness {
  root: string;
  recordPath: string;
  store: FileOwnerStatePort;
  codes: CryptoPairingCodePort;
  clock: TestClock;
  outcomes: DiagnosticEvent[];
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
  const outcomes: DiagnosticEvent[] = [];
  const build = (): OwnerAdmissionService =>
    new OwnerAdmissionService({
      store,
      codes,
      clock,
      expectedOwnerId: OWNER_ID,
      diagnostics: { emit: (event) => outcomes.push(event) },
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
    root = makeTestTemp('enrollment');
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

    expect(new Date(issued.expiresAt).getTime() - START.getTime()).toBe(PAIRING_CODE_EXPIRY_MS);
  });

  it('records no code, no identifier and no exception text in its bounded outcome channel', async () => {
    const service = harness.reopen();
    await service.initialize();
    const issued = await service.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');

    await service.handlePairing(identity({ eventId: 'telegram:chat-1:9' }), WRONG_CODE);

    expect(harness.outcomes).toEqual([
      { stage: 'pairing', outcome: 'invalid', reason: 'code-mismatch', durationMs: expect.any(Number) },
    ]);
    const serialized = JSON.stringify(harness.outcomes);
    expect(serialized).not.toContain('chat-1');
    expect(serialized).not.toContain('user-1');
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain(WRONG_CODE);
  });
});

describe('owner enrollment: admission before any clinical work', () => {
  let root: string;
  let harness: Harness;

  beforeEach(async () => {
    root = makeTestTemp('admission');
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

  it('refuses a reissue once bound, because rebinding is not supported', async () => {
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

describe('owner enrollment: the pairing allowance is per chat, per day, and in memory', () => {
  let root: string;
  let harness: Harness;

  beforeEach(async () => {
    root = makeTestTemp('allowance');
    harness = makeHarness(root);
    await harness.reopen().initialize();
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  async function issueCode(service = harness.reopen()): Promise<string> {
    const issued = await service.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    return issued.plaintext;
  }

  it('allows three attempts per chat; the fourth is silent even with the right code until a restart', async () => {
    const service = harness.reopen();
    const code = await issueCode(service);
    expect(await service.handlePairing(identity({ eventId: 'e1' }), WRONG_CODE)).toEqual({ kind: 'invalid' });
    expect(await service.handlePairing(identity({ eventId: 'e2' }), 'hello, is anyone there?')).toEqual({ kind: 'prompt' });
    expect(await service.handlePairing(identity({ eventId: 'e3' }), WRONG_CODE)).toEqual({ kind: 'invalid' });

    const reissued = await issueCode(service);
    expect(await service.handlePairing(identity({ eventId: 'e4' }), reissued)).toEqual({ kind: 'limited' });
    expect(harness.readRecord()?.phase).toBe('unpaired');
    expect(code).not.toBe(reissued);

    expect(await harness.reopen().handlePairing(identity({ eventId: 'e5' }), reissued)).toEqual({
      kind: 'paired',
      boundOwnerId: OWNER_ID,
    });
  });

  it('does not spend a second attempt for a redelivered transport event', async () => {
    const service = harness.reopen();
    await issueCode(service);
    expect(await service.handlePairing(identity({ eventId: 'same-event' }), WRONG_CODE)).toEqual({ kind: 'invalid' });
    for (let i = 0; i < 5; i += 1) {
      expect(await service.handlePairing(identity({ eventId: 'same-event' }), WRONG_CODE)).toEqual({ kind: 'prompt' });
    }
    expect(await service.handlePairing(identity({ eventId: 'e2' }), WRONG_CODE)).toEqual({ kind: 'invalid' });
  });

  it('gives a new UTC day a fresh allowance', async () => {
    const service = harness.reopen();
    await issueCode(service);
    for (const attempt of [1, 2, 3]) await service.handlePairing(identity({ eventId: `e${attempt}` }), WRONG_CODE);
    expect(await service.handlePairing(identity({ eventId: 'e4' }), WRONG_CODE)).toEqual({ kind: 'limited' });

    harness.clock.setTo(new Date('2026-03-02T10:00:00.000Z'));
    const day2 = await issueCode(service);
    expect(await service.handlePairing(identity({ eventId: 'e5' }), day2)).toEqual({ kind: 'paired', boundOwnerId: OWNER_ID });
  });

  it('refuses a new candidate chat once the day\'s candidate table is full, without dropping tracked chats', async () => {
    const service = harness.reopen();
    await issueCode(service);
    for (let index = 0; index < PAIRING_MAX_CANDIDATE_CHATS; index += 1) {
      const result = await service.handlePairing(
        identity({ chatId: `chat-${index}`, userId: `user-${index}`, eventId: `e-${index}` }),
        'hello',
      );
      expect(result).toEqual({ kind: 'prompt' });
    }
    expect(await service.handlePairing(
      identity({ chatId: 'chat-overflow', userId: 'user-overflow', eventId: 'e-overflow' }),
      'hello',
    )).toEqual({ kind: 'refused' });
    expect(await service.handlePairing(identity({ chatId: 'chat-0', userId: 'user-0', eventId: 'e-0b' }), 'hello'))
      .toEqual({ kind: 'prompt' });
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
    root = makeTestTemp('commit');
    clock = new TestClock(START);
    const paths = ownerAt(root);
    recordPath = paths.ownerRecord;
    const seed = new FileOwnerStatePort(recordPath, OWNER_ID);
    const seeder = new OwnerAdmissionService({
      store: seed,
      codes: new CryptoPairingCodePort(),
      clock,
      expectedOwnerId: OWNER_ID,
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

  /** A real file flush that fails BEFORE the rename, so nothing is ever published. */
  function failingFileFlushSync(): OwnerRecordFileSync {
    return {
      syncFile: (): void => {
        const error: NodeJS.ErrnoException = new Error('injected file flush failure');
        error.code = 'EIO';
        throw error;
      },
      syncDir: (dir: string): void => {
        const dfd = fs.openSync(dir, 'r');
        try {
          fs.fsyncSync(dfd);
        } finally {
          fs.closeSync(dfd);
        }
      },
    };
  }

  /** The real file adapter with one controlled durability fault. No mocked policy result. */
  function storeOver(record: string, sync: OwnerRecordFileSync): FileOwnerStatePort {
    return new FileOwnerStatePort(record, OWNER_ID, undefined, sync);
  }

  function refusingStore(): OwnerStatePort {
    return storeOver(recordPath, failingFileFlushSync());
  }

  /** Publishes and then loses the acknowledgement: the out-of-contract case the policy must survive. */
  function unacknowledgedStore(record: string): OwnerStatePort {
    const real = new FileOwnerStatePort(record, OWNER_ID);
    return {
      read: () => real.read(),
      replace: async (): Promise<never> => {
        const error: NodeJS.ErrnoException = new Error('acknowledgement lost before any write');
        error.code = 'EIO';
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
    });
  }

  it('refuses without binding when the write demonstrably failed', async () => {
    const bytesBefore = fs.readFileSync(recordPath);
    const service = serviceOver(refusingStore());

    const result: PairingResult = await service.handlePairing(identity(), code());

    expect(result).toEqual({ kind: 'unavailable' });
    expect(fs.readFileSync(recordPath)).toEqual(bytesBefore);
    const reread = new FileOwnerStatePort(recordPath, OWNER_ID).read();
    expect(reread.kind === 'available' && reread.state.phase).toBe('unpaired');
  });

  it('never reports a created record when the record was not published', async () => {
    const freshRoot = makeTestTemp('init-refused');
    try {
      const freshRecord = path.join(freshRoot, 'owner-access.json');
      const refused = await new OwnerAdmissionService({
        store: storeOver(freshRecord, failingFileFlushSync()),
        codes: new CryptoPairingCodePort(),
        clock,
        expectedOwnerId: OWNER_ID,
      }).initialize();

      expect(refused).toBe('refused');
      expect(fs.existsSync(freshRecord)).toBe(false);
    } finally {
      removeTestTemp(freshRoot);
    }
  });

  it('reports an unconfirmed publication as uncertain, not as created', async () => {
    const freshRoot = makeTestTemp('init-uncertain');
    try {
      const uncertain = await new OwnerAdmissionService({
        store: unacknowledgedStore(path.join(freshRoot, 'owner-access.json')),
        codes: new CryptoPairingCodePort(),
        clock,
        expectedOwnerId: OWNER_ID,
      }).initialize();

      expect(uncertain).toBe('uncertain');
    } finally {
      removeTestTemp(freshRoot);
    }
  });

  it('binds when an uncertain write turns out to have landed, instead of undoing it', async () => {
    const real = new FileOwnerStatePort(recordPath, OWNER_ID);
    let boundWriteAcknowledged = false;
    const store: OwnerStatePort = {
      read: () => real.read(),
      replace: async (next: OwnerState) => {
        const outcome = await real.replace(next);
        if (next.phase === 'bound') {
          boundWriteAcknowledged = true;
          const error: NodeJS.ErrnoException = new Error('acknowledgement lost after commit');
          throw error;
        }
        return outcome;
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

    const issued = await serviceOver(refusingStore()).issueChallenge();

    expect(issued).toEqual({ kind: 'refused', reason: 'unavailable', writeReason: 'flush-failed' });
    const after = real.read();
    const verifierAfter = after.kind === 'available' && after.state.phase === 'unpaired'
      ? after.state.challenge?.verifier
      : undefined;
    expect(verifierAfter).toBe(verifierBefore);
    expect(verifierAfter).toBeDefined();
  });

  it('reports an unconfirmed replacement as uncertain while keeping the new record readable', async () => {
    const real = new FileOwnerStatePort(recordPath, OWNER_ID);
    const before = real.read();
    const verifierBefore = before.kind === 'available' && before.state.phase === 'unpaired'
      ? before.state.challenge?.verifier
      : undefined;

    const unconfirmed = new OwnerAdmissionService({
      store: storeOver(recordPath, {
        syncFile: (fd: number): void => fs.fsyncSync(fd),
        syncDir: (): void => {
          const error: NodeJS.ErrnoException = new Error('injected directory flush failure');
          error.code = 'EIO';
          throw error;
        },
      }),
      codes: new CryptoPairingCodePort(),
      clock,
      expectedOwnerId: OWNER_ID,
    });

    const issued = await unconfirmed.issueChallenge();

    expect(issued).toEqual({ kind: 'refused', reason: 'uncertain' });
    const after = new FileOwnerStatePort(recordPath, OWNER_ID).read();
    expect(after.kind).toBe('available');
    const verifierAfter = after.kind === 'available' && after.state.phase === 'unpaired'
      ? after.state.challenge?.verifier
      : undefined;
    expect(verifierAfter).toBeDefined();
    expect(verifierAfter).not.toBe(verifierBefore);
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
