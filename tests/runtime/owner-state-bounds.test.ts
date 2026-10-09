// tests/runtime/owner-state-bounds.test.ts
//
// The protected invariant: **one owner's own untrusted pairing traffic can never make the app's own
// record unreadable, and a record that cannot be published says so instead of pretending.** Three
// bounds are pinned here that no other flow isolates.
//
// 1. `PAIRING_MAX_EVENT_IDS_PER_CHAT`. NOTE: an earlier version of this header claimed the
//    `.slice(-PAIRING_MAX_EVENT_IDS_PER_CHAT)` in `OwnerAdmissionService.handlePairing` was the only
//    write-side enforcement and that removing it would grow the array to four and wedge the decoder.
//    THAT WAS WRONG, and writing the test is what proved it: `PAIRING_ATTEMPTS_PER_CHAT_PER_DAY` is
//    also 3, so the allowance cap refuses the fourth attempt BEFORE an event id is written and the
//    slice never actually truncates. The claim is corrected at the case below rather than left here,
//    because a header that states a disproven thing is the same failure as a false source comment.
//    The slice becomes load-bearing only if the attempts cap is raised — which is exactly why the
//    decoder's own bound must stay in step with it.
//
// 2. `OWNER_RECORD_MAX_BYTES`. A record above the bound is refused as too-large, not parsed and not
//    silently truncated — on the READ side, on the bytes actually read.
//
// 3. The SAME bound on the WRITE side. This is the C03 fix and it is the pair that matters: a writer
//    that may publish more bytes than the reader accepts is how a real day of pairing traffic wedged
//    the owner's own record (R11). At the existing 256-candidate/three-attempt bounds with ordinary
//    Telegram-shaped identifiers the record encodes to about 100 KiB, which the previous 64 KiB reader
//    refused — permanently, for every command, until an operator deleted the record by hand.
//
// Real collaborators: the real `FileOwnerStatePort`, the real `OwnerAdmissionService`, the real
// crypto pairing port, the real decoder. No mocked storage; the only controlled input is the
// filesystem durability seam, which drives a REAL publication through a controlled post-rename
// failure.

import * as fs from 'fs';
import * as path from 'path';

import { FileOwnerStatePort, OWNER_RECORD_MAX_BYTES } from '../../src/runtime/adapters/owner-state-file';
import type { OwnerRecordFileSync } from '../../src/runtime/adapters/owner-state-file';
import { CryptoPairingCodePort } from '../../src/runtime/adapters/pairing-code';
import { OwnerAdmissionService } from '../../src/profiles';
import {
  PAIRING_ATTEMPTS_PER_CHAT_PER_DAY,
  PAIRING_MAX_CANDIDATE_CHATS,
  PAIRING_MAX_EVENT_IDS_PER_CHAT,
  PAIRING_MAX_EVENT_ID_LENGTH,
  PAIRING_MAX_ID_LENGTH,
  type OwnerState,
  type TransportIdentity,
} from '../../src/ports/owner-state';
import type { Clock } from '../../src/ports/clock';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

/**
 * U+0001, written as a code point rather than a literal control byte in the source. It is legal
 * inside every identifier and event id the policy accepts, and it is what makes worst-case escaping
 * expensive: `JSON.stringify` expands each one to the six bytes `\u0001`.
 */
const ESCAPE_BOMB_CHAR = String.fromCharCode(1);

/** Ordinary transport traffic: real Telegram-shaped chat ids, sender ids and event ids. */
function productionIdentity(index: number, attempt: number): TransportIdentity {
  const chatId = `-1001234567${String(index).padStart(4, '0')}`;
  return {
    channel: 'telegram',
    chatId,
    userId: String(900000000 + index),
    chatType: 'private',
    eventId: `telegram:${chatId}:${1000000000 + index * 4 + attempt}`,
  };
}

class FixedClock implements Clock {
  constructor(private instant = new Date('2026-03-01T10:00:00.000Z')) {}
  now(): Date {
    return new Date(this.instant);
  }
  setTo(instant: Date): void {
    this.instant = instant;
  }
}

const OWNER_ID = 'default';

describe('owner record bounds: refused, never grown into', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-record-bounds');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  function recordPathFor(dir: string): string {
    return path.join(dir, 'owner-access.json');
  }

  function identity(eventId: string): TransportIdentity {
    return {
      channel: 'telegram',
      chatId: 'chat-1',
      userId: 'user-1',
      chatType: 'private',
      eventId,
    };
  }

  function serviceFor(recordPath: string): OwnerAdmissionService {
    return new OwnerAdmissionService({
      store: new FileOwnerStatePort(recordPath, OWNER_ID),
      codes: new CryptoPairingCodePort(),
      clock: new FixedClock(),
      expectedOwnerId: OWNER_ID,
    });
  }

  it('never stores more event ids per chat than the bound, and the record stays decodable', async () => {
    // A CORRECTION to my own earlier claim, found while writing this test.
    //
    // I had written that `.slice(-PAIRING_MAX_EVENT_IDS_PER_CHAT)` was load-bearing and that removing
    // it would grow the array to four and wedge the decoder. That is FALSE, and the test proves why:
    // `PAIRING_ATTEMPTS_PER_CHAT_PER_DAY` is ALSO 3, so the fourth attempt is refused by the daily
    // allowance cap BEFORE an event id is recorded. The stored list reaches 3 and the slice never
    // actually truncates.
    //
    // The slice is therefore defence-in-depth coupling two independently specified limits — it starts
    // mattering only if the attempts cap is raised. This test pins what is actually true today: the
    // invariant holds under a whole day's traffic AND the record remains decodable afterwards.
    const recordPath = recordPathFor(root);
    const service = serviceFor(recordPath);
    await service.initialize();

    // One more distinct event than the bound allows, from the same chat on the same UTC day.
    const events = PAIRING_MAX_EVENT_IDS_PER_CHAT + 1;
    const outcomes: string[] = [];
    for (let i = 0; i < events; i += 1) {
      outcomes.push((await service.handlePairing(identity(`telegram:chat-1:${i}`), 'not-a-code')).kind);
    }

    // The allowance cap is what refuses the surplus attempt — not the event-id bound.
    expect(outcomes).toContain('limited');

    const read = new FileOwnerStatePort(recordPath, OWNER_ID).read();
    if (read.kind !== 'available') throw new Error(`record unreadable: ${read.kind}`);
    if (read.state.phase !== 'unpaired') throw new Error(`expected unpaired, got ${read.state.phase}`);

    const chat = read.state.attempts.chats.find((c: { chatId: string }) => c.chatId === 'chat-1');
    expect(chat?.eventIds.length).toBeLessThanOrEqual(PAIRING_MAX_EVENT_IDS_PER_CHAT);
    // Bounded by the allowance, so at most three ids and never the fourth.
    expect(chat?.eventIds).toEqual(['telegram:chat-1:0', 'telegram:chat-1:1', 'telegram:chat-1:2']);

    // Still decodable. This is the consequence that would break if the two limits ever diverged with
    // the slice removed: `decodeOwnerState` rejects a stored array longer than the bound, so the whole
    // record would read as `unavailable` and every command would refuse for an unrelated-looking cause.
    expect(read.kind).toBe('available');
    expect(read.state.phase).toBe('unpaired');
  });

  it('refuses a record above OWNER_RECORD_MAX_BYTES as too-large instead of parsing it', async () => {
    const recordPath = recordPathFor(root);
    const service = serviceFor(recordPath);
    await service.initialize();

    // A syntactically plausible but oversized record: valid JSON, correct owner, just too big.
    // Refused on size alone, before any structural interpretation.
    const oversized = JSON.stringify({
      phase: 'unpaired',
      ownerId: OWNER_ID,
      padding: 'x'.repeat(OWNER_RECORD_MAX_BYTES + 1024),
    });
    fs.writeFileSync(recordPath, oversized, { mode: 0o600 });
    expect(fs.statSync(recordPath).size).toBeGreaterThan(OWNER_RECORD_MAX_BYTES);

    const read = new FileOwnerStatePort(recordPath, OWNER_ID).read();

    // Explicitly `too-large` rather than a generic unreadable, so an operator can tell a size
    // problem from a corruption problem.
    if (read.kind !== 'unavailable') throw new Error(`expected unavailable, got ${read.kind}`);
    expect(read.reason).toBe('too-large');

    // And the service refuses rather than falling back to a fresh record.
    const decision = service.inspectInstallation();
    expect(decision.kind).toBe('refused');
  });

  it('accepts a record whose size sits just under the configured limit', async () => {
    // The other half of the bound: a refusal that triggers too eagerly is as broken as one that never
    // triggers. Uses the constructor's explicit limit so the boundary is exercised directly rather
    // than inferred from the production constant.
    //
    // An earlier attempt at this padded the record with an extra field, which failed — correctly, since
    // `decodeOwnerState` rejects unknown keys. The record under test has to stay structurally valid,
    // so the limit is moved instead of the content.
    const recordPath = recordPathFor(root);
    const service = serviceFor(recordPath);
    await service.initialize();

    const size = fs.statSync(recordPath).size;
    expect(size).toBeLessThan(OWNER_RECORD_MAX_BYTES);

    // A limit equal to the file's real size: accepted.
    expect(new FileOwnerStatePort(recordPath, OWNER_ID, size).read().kind).toBe('available');

    // One byte under the real size: refused as too-large, never partially parsed.
    const justUnder = new FileOwnerStatePort(recordPath, OWNER_ID, size - 1).read();
    if (justUnder.kind !== 'unavailable') throw new Error(`expected unavailable, got ${justUnder.kind}`);
    expect(justUnder.reason).toBe('too-large');
  });
});

// ── C03/R11 — the writer and the reader must agree on ONE budget ──────────────────────────────
//
// A bound the writer does not honour is not a bound. These cases drive the REAL admission policy over
// the REAL file adapter and then read the record back with a brand new reader, which is the only way
// to see the defect: a single reader against a single record proves nothing about whether the bytes
// that were written are bytes the reader will accept.

describe('owner record budget: a saturated day of real traffic stays readable', () => {
  let root: string;
  let clock: FixedClock;
  let recordPath: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-budget-day');
    clock = new FixedClock();
    recordPath = path.join(root, 'owner-access.json');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  function serviceFor(record = recordPath): OwnerAdmissionService {
    return new OwnerAdmissionService({
      store: new FileOwnerStatePort(record, OWNER_ID),
      codes: new CryptoPairingCodePort(),
      clock,
      expectedOwnerId: OWNER_ID,
    });
  }

  it('survives 256 candidates at three attempts, then reissues and binds an eligible owner', async () => {
    const service = serviceFor();
    expect(await service.initialize()).toBe('created');

    // A whole saturated UTC day of ordinary untrusted pairing traffic: the existing candidate and
    // attempt limits, ordinary Telegram-shaped identifiers, ordinary event ids.
    let refused = 0;
    for (let index = 0; index < PAIRING_MAX_CANDIDATE_CHATS; index += 1) {
      for (let attempt = 1; attempt <= PAIRING_ATTEMPTS_PER_CHAT_PER_DAY; attempt += 1) {
        const result = await service.handlePairing(productionIdentity(index, attempt), 'AAAAAAAA');
        if (result.kind === 'limited') refused += 1;
        else expect(result.kind).toBe('invalid');
      }
    }
    expect(refused).toBe(0);

    const bytes = fs.statSync(recordPath).size;
    // The number that matters: real traffic at the existing limits must fit the record's own budget.
    expect(bytes).toBeLessThan(OWNER_RECORD_MAX_BYTES);

    // THE REGRESSION. A brand new reader over the same bytes — this is what restart is. Before the
    // budget was shared, this returned `too-large` and every command refused forever.
    expect(serviceFor().inspectInstallation()).toEqual({ kind: 'unpaired' });

    // A 257th candidate is still refused. Saturation must not be relieved to make this flow pass.
    const saturatedBytes = fs.readFileSync(recordPath);
    expect(await serviceFor().handlePairing(
      {
        channel: 'telegram',
        chatId: '-1001234567000256',
        userId: '900000256',
        chatType: 'private',
        eventId: 'telegram:-1001234567000256:1000002048',
      },
      'AAAAAAAA',
    )).toEqual({ kind: 'refused' });
    expect(fs.readFileSync(recordPath)).toEqual(saturatedBytes);

    // Local reissue still works after a saturated day, and it does NOT reset today's allowance.
    const reissued = await serviceFor().issueChallenge();
    expect(reissued.kind).toBe('issued');
    expect(await serviceFor().handlePairing(productionIdentity(0, 4), 'AAAAAAAA')).toEqual({
      kind: 'limited',
    });

    // The owner is still able to pair: eligibility survives, here by rolling to the next UTC day,
    // which is the other way the policy defines an eligible owner. Nothing was waived to get here.
    clock.setTo(new Date('2026-03-02T09:00:00.000Z'));
    const tomorrow = await serviceFor().issueChallenge();
    if (tomorrow.kind !== 'issued') throw new Error(`expected issued, got ${tomorrow.kind}`);
    expect(await serviceFor().handlePairing(productionIdentity(0, 1), tomorrow.plaintext)).toEqual({
      kind: 'paired',
      boundOwnerId: OWNER_ID,
    });
    expect(serviceFor().inspectInstallation()).toEqual({ kind: 'bound', ownerId: OWNER_ID });
  }, 120_000);

  it('refuses an encoded document above the budget BEFORE publication, keeping the prior record readable', async () => {
    const service = serviceFor();
    await service.initialize();
    await service.issueChallenge();
    const before = fs.readFileSync(recordPath);

    // Worst-case legal content: every field is within its own grammar, but JSON escaping expands each
    // character to six bytes, so the encoded document cannot fit the budget. This is reachable from
    // untrusted traffic — identifiers and event ids are attacker-influenced strings.
    const escapeBomb = ESCAPE_BOMB_CHAR.repeat(PAIRING_MAX_EVENT_ID_LENGTH);
    const oversized: OwnerState = {
      version: 1,
      ownerId: OWNER_ID,
      createdAt: '2026-03-01T10:00:00.000Z',
      phase: 'unpaired',
      attempts: {
        day: '2026-03-01',
        chats: Array.from({ length: PAIRING_MAX_CANDIDATE_CHATS }, (_, index) => ({
          chatId: `chat-${index}`,
          senderId: `user-${index}`,
          attempts: PAIRING_ATTEMPTS_PER_CHAT_PER_DAY,
          eventIds: [escapeBomb, escapeBomb, escapeBomb],
          firstSeenAt: '2026-03-01T10:00:00.000Z',
          lastSeenAt: '2026-03-01T10:00:00.000Z',
        })),
      },
    };

    const outcome = await new FileOwnerStatePort(recordPath, OWNER_ID).replace(oversized);

    // Refused, and refused as a SIZE decision rather than a mysterious write fault.
    expect(outcome).toEqual({ status: 'failed', reason: 'too-large' });
    // Nothing was published and nothing was cleaned up destructively: the previous bytes are intact
    // and still readable, and the attempt left no temp file behind.
    expect(fs.readFileSync(recordPath)).toEqual(before);
    expect(service.inspectInstallation()).toEqual({ kind: 'unpaired' });
    expect(fs.readdirSync(path.dirname(recordPath))).toEqual(['owner-access.json']);
  });

  it('spends no attempt and verifies no code when the reservation cannot be published', async () => {
    // A refusal must not become a free unlimited retry, and must not verify a code whose reservation
    // was never stored. The reserve is written first precisely so this cannot happen.
    // A deliberately small bound, so ONE legal-but-heavy candidate row reaches the budget decision in
    // a single attempt. Reaching it at the production 256 KiB would take hundreds of chats and proves
    // nothing extra: it is the same comparison over the same encoded bytes.
    const store = new FileOwnerStatePort(recordPath, OWNER_ID, 1024);
    const service = new OwnerAdmissionService({
      store,
      codes: new CryptoPairingCodePort(),
      clock,
      expectedOwnerId: OWNER_ID,
    });
    await service.initialize();
    const issued = await service.issueChallenge();
    if (issued.kind !== 'issued') throw new Error(`expected issued, got ${issued.kind}`);
    const before = fs.readFileSync(recordPath);

    // A candidate row that cannot fit the record's own budget, inside the grammar.
    const refused = await service.handlePairing(
      { ...productionIdentity(1, 1), eventId: ESCAPE_BOMB_CHAR.repeat(PAIRING_MAX_EVENT_ID_LENGTH) },
      issued.plaintext,
    );

    // Refused, not paired: the code was never verified against a stored reservation.
    expect(refused.kind).not.toBe('paired');
    // The prior readable record is untouched — no eviction of live limits, no reset.
    expect(fs.readFileSync(recordPath)).toEqual(before);
    expect(service.inspectInstallation()).toEqual({ kind: 'unpaired' });
    // And it is not permanently wedged: an ordinary attempt still works on the same record.
    expect(await service.handlePairing(productionIdentity(2, 1), 'AAAAAAAA')).toEqual({ kind: 'invalid' });
  });
});

// ── C03/R20 — a post-rename durability failure is uncertainty, not success and not "no change" ──

describe('owner record publication: which side of the rename failed', () => {
  let root: string;
  let recordPath: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-publication');
    recordPath = path.join(root, 'owner-access.json');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  /** A real store whose only fault is a controlled filesystem durability step. */
  function storeWith(sync: OwnerRecordFileSync, maxBytes = OWNER_RECORD_MAX_BYTES): FileOwnerStatePort {
    return new FileOwnerStatePort(recordPath, OWNER_ID, maxBytes, sync);
  }

  function serviceFor(store: FileOwnerStatePort): OwnerAdmissionService {
    return new OwnerAdmissionService({
      store,
      codes: new CryptoPairingCodePort(),
      clock: new FixedClock(),
      expectedOwnerId: OWNER_ID,
    });
  }

  function realFileSync(): OwnerRecordFileSync {
    return {
      syncFile: (fd: number): void => fs.fsyncSync(fd),
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

  it('never deletes a temp destination it did not create when the exclusive open is refused', async () => {
    const real = storeWith(realFileSync());
    const service = serviceFor(real);

    // A real, valid, readable record exists before anything is attempted.
    expect(await service.initialize()).toBe('created');
    const published = fs.readFileSync(recordPath);
    expect(published.length).toBeGreaterThan(0);

    // The EXACT path this attempt will try to open exclusively. Controlling `Date.now` is the only
    // thing controlled here — `process.pid` is this process's real pid, and the temp name carries no
    // randomness. A fixture that plants a DIFFERENT name proves nothing: it would never collide, and
    // the refusal below would never happen.
    const FROZEN_MS = 1_700_000_000_000;
    const collided = path.join(root, `.owner-access.json.tmp-${process.pid}-${FROZEN_MS}`);
    const sentinel = Buffer.from('synthetic-sentinel: pre-existing unpublished bytes, not a record');
    fs.writeFileSync(collided, sentinel, { mode: 0o600 });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(FROZEN_MS);

    try {
      // The OS refuses the exclusive open because the destination already exists.
      const outcome = await real.replace({
        version: 1,
        ownerId: OWNER_ID,
        createdAt: '2026-03-01T11:00:00.000Z',
        phase: 'unpaired',
        attempts: { day: '2026-03-01', chats: [] },
      });
      expect(outcome).toEqual({ status: 'failed', reason: 'write-failed' });
    } finally {
      // Restore the clock even if an assertion threw, so no later case in this file runs on a
      // controlled `Date.now`.
      clock.mockRestore();
    }

    // THE DEFECT: cleanup ran although this attempt never created that file. A refused open owns
    // nothing, so removing the destination destroys pre-existing bytes that had nothing to do with
    // this attempt — the write-failure contract says "cleanup owns only this attempt's temp".
    expect(fs.existsSync(collided)).toBe(true);
    expect(fs.readFileSync(collided)).toEqual(sentinel);

    // And the real record is untouched: this is not a record-publication failure.
    expect(fs.readFileSync(recordPath)).toEqual(published);
    expect(new FileOwnerStatePort(recordPath, OWNER_ID).read().kind).toBe('available');
  });

  it('closes every descriptor it opens, so repeated publication cannot leak handles', async () => {
    // Brief §8 Task B requires "no surviving descriptors". Nothing else in this file could observe
    // that: the descriptor is closed before the rename, so a leaked one changes no result, no file and
    // no message — it is only visible as an accumulating handle count. Read it directly.
    //
    // `/dev/fd` is the mechanism: the contract is POSIX-only (directory fsync, `process.pid` in the
    // temp name), and both supported platforms expose it. If it is ever absent this test fails loudly
    // instead of silently becoming a no-op assertion.
    const openDescriptors = (): number => fs.readdirSync('/dev/fd').length;
    const record = (): OwnerState => ({
      version: 1,
      ownerId: OWNER_ID,
      createdAt: '2026-03-01T10:00:00.000Z',
      phase: 'unpaired',
      attempts: { day: '2026-03-01', chats: [] },
    });

    const real = storeWith(realFileSync());
    // Warm up first: anything opened lazily settles BEFORE the baseline, so the measurement below is
    // about this adapter's own handles rather than about runtime start-up.
    for (let i = 0; i < 5; i++) await real.replace(record());

    const before = openDescriptors();
    for (let i = 0; i < 40; i++) await real.replace(record());
    // Forty publications, zero new descriptors. A leaked one per write shows up as +40 here.
    expect(openDescriptors()).toBe(before);

    // And the loop was real work, not a stream of refusals that never opened anything.
    expect(new FileOwnerStatePort(recordPath, OWNER_ID).read().kind).toBe('available');
    expect(fs.readdirSync(root)).toEqual(['owner-access.json']);
  });

  it('still removes its own temp when the rename fails after the descriptor was closed', async () => {
    // POSIX refuses `rename(file, nonEmptyDirectory)` with EISDIR, so the rename fails for real at the
    // exact point where the descriptor has already been closed and `fd` is `undefined`. This is the
    // case that decides HOW ownership must be tracked: a guard keyed on the descriptor would read
    // "no descriptor" as "nothing to clean" and leak this attempt's temp forever.
    const occupied = path.join(root, 'owner-access.json');
    fs.mkdirSync(occupied, { mode: 0o700 });
    fs.writeFileSync(path.join(occupied, 'synthetic-sentinel'), 'pre-existing contents');

    const outcome = await storeWith(realFileSync()).replace({
      version: 1,
      ownerId: OWNER_ID,
      createdAt: '2026-03-01T12:00:00.000Z',
      phase: 'unpaired',
      attempts: { day: '2026-03-01', chats: [] },
    });

    expect(outcome).toEqual({ status: 'failed', reason: 'write-failed' });

    // This attempt's temp is gone, even though no descriptor was open any more when the rename failed.
    expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
    // And the thing the rename refused to replace is left exactly as it was.
    expect(fs.statSync(occupied).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(occupied, 'synthetic-sentinel'), 'utf8')).toBe('pre-existing contents');
  });

  it('reports failed and keeps the previous bytes when the write cannot be flushed', async () => {
    const service = serviceFor(storeWith({
      syncFile: (): void => {
        const error: NodeJS.ErrnoException = new Error('injected file flush failure');
        error.code = 'EIO';
        throw error;
      },
      syncDir: (dir: string): void => fs.fsyncSync(fs.openSync(dir, 'r')),
    }));

    expect(await service.initialize()).toBe('refused');
    // Not published, so nothing to read and nothing to claim.
    expect(fs.existsSync(recordPath)).toBe(false);
    // Only this attempt's temp file is cleaned up.
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('reports uncertain, keeps the NEW record readable, and never restores the old bytes', async () => {
    const service = serviceFor(storeWith(realFileSync()));
    expect(await service.initialize()).toBe('created');
    const before = fs.readFileSync(recordPath);
    expect((await service.issueChallenge()).kind).toBe('issued');

    // The controlled fault: the DIRECTORY flush fails, after the rename has already landed.
    const uncertainStore = storeWith({
      syncFile: (fd: number): void => fs.fsyncSync(fd),
      syncDir: (): void => {
        const error: NodeJS.ErrnoException = new Error('injected directory flush failure');
        error.code = 'EIO';
        throw error;
      },
    });

    // The port boundary itself, first: this is where publication truth is decided, and it is the only
    // place that knows which side of the rename failed. A swallowed directory flush used to make this
    // return a plain success.
    const published = await uncertainStore.replace({
      version: 1,
      ownerId: OWNER_ID,
      createdAt: '2026-03-01T10:00:00.000Z',
      phase: 'unpaired',
      attempts: { day: '2026-03-01', chats: [] },
    });
    expect(published).toEqual({ status: 'uncertain', reason: 'flush-failed' });

    // And the distinct outcome reaches policy, rather than being swallowed there instead.
    expect(await serviceFor(uncertainStore).issueChallenge()).toEqual({ kind: 'refused', reason: 'uncertain' });
    // The replacement was retained, not rolled back, not deleted and not restored.
    expect(fs.readFileSync(recordPath)).not.toEqual(before);
    expect(new FileOwnerStatePort(recordPath, OWNER_ID).read().kind).toBe('available');
    // No temp file survives, and the record is still owner-only inside an owner-only directory.
    expect(fs.readdirSync(root)).toEqual(['owner-access.json']);
    expect(fs.statSync(recordPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  });

  it('treats the budget as a byte budget at an exact size boundary', async () => {
    // CORRECTED DESCRIPTION. This case used to be titled "bounds the reader on the bytes it actually
    // reads, not on a prior size check", which claimed a growth property it does not test. It does not:
    // every bound here is derived from a real, accurate `statSync`, so all three reads are decided by
    // the METADATA precheck. The growth-after-metadata property — the one that needs the size to lie —
    // lives in `owner-record-read-bound.test.ts`, which controls exactly that and nothing else.
    //
    // What this case does own, and does pin precisely: the budget is a BYTE budget rather than a
    // character budget, the boundary is exact (the same real record is accepted at `size` and refused
    // at `size - 1`), and the production default accepts a record the explicit smaller bound refuses.
    const service = serviceFor(storeWith(realFileSync()));
    await service.initialize();
    const size = fs.statSync(recordPath).size;

    expect(new FileOwnerStatePort(recordPath, OWNER_ID, size).read().kind).toBe('available');
    expect(new FileOwnerStatePort(recordPath, OWNER_ID, size - 1).read()).toEqual({
      kind: 'unavailable',
      reason: 'too-large',
    });
    // The production default accepts the same real record that an explicit smaller bound refuses.
    expect(new FileOwnerStatePort(recordPath, OWNER_ID).read().kind).toBe('available');
    // And the ordinary traffic that used to overflow a smaller reader stays inside its own grammar.
    expect(productionIdentity(0, 1).chatId.length).toBeLessThanOrEqual(PAIRING_MAX_ID_LENGTH);
    expect(productionIdentity(0, 1).eventId.length).toBeLessThanOrEqual(PAIRING_MAX_EVENT_ID_LENGTH);
  });
});
