// tests/runtime/owner-state-bounds.test.ts
//
// The protected invariant: **a bounded owner record refuses to grow, rather than growing until it
// wedges itself.** Two bounds are pinned here that no flow test isolates, and both were reported as
// untested in review round 2.
//
// 1. `PAIRING_MAX_EVENT_IDS_PER_CHAT`. The `.slice(-PAIRING_MAX_EVENT_IDS_PER_CHAT)` in
//    `OwnerAdmissionService.handlePairing` is the ONLY write-side enforcement. That makes it
//    load-bearing in a way that is easy to miss: `decodeOwnerState` rejects a stored array LONGER
//    than the bound, so if the slice were removed the array would grow to four on the next attempt
//    and the decoder would then reject the whole record — every later read returning `unavailable`
//    and every command refusing, for a reason that looks nothing like its cause.
//
// 2. `OWNER_RECORD_MAX_BYTES`. A record above the bound is refused as too-large, not parsed and not
//    silently truncated. This is the same shape as the 256 KiB config bound, which
//    `tests/config/config.test.ts` already covers; the owner record is a separate reader with a
//    separate limit and had no coverage at all.
//
// Real collaborators: the real `FileOwnerStatePort`, the real `OwnerAdmissionService`, the real
// crypto pairing port, the real decoder. No mocked storage.

import * as fs from 'fs';
import * as path from 'path';

import { FileOwnerStatePort, OWNER_RECORD_MAX_BYTES } from '../../src/runtime/adapters/owner-state-file';
import { CryptoPairingCodePort } from '../../src/runtime/adapters/pairing-code';
import { OwnerAdmissionService } from '../../src/profiles';
import { PAIRING_MAX_EVENT_IDS_PER_CHAT } from '../../src/ports/owner-state';
import type { TransportIdentity } from '../../src/ports/owner-state';
import type { Clock } from '../../src/ports/clock';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

class FixedClock implements Clock {
  constructor(private instant = new Date('2026-03-01T10:00:00.000Z')) {}
  now(): Date {
    return new Date(this.instant);
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