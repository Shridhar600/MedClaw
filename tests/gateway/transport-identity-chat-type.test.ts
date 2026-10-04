// tests/gateway/transport-identity-chat-type.test.ts
//
// The protected invariant: **a message with no asserted `chatType` never gains owner health
// access.** It must be refused, exactly like a group.
//
// Review round 2 finding 2.6. `transportIdentityOf` normalised the inbound message with
// `chatType: incoming.chatType ?? 'private'`, which is the single value in the whole admission
// path that grants owner health access. Its own doc comment claimed the opposite — "A missing or
// over-long field is carried through as-is so the admission service — not this adapter — decides it
// is missing identity" — and its sibling fields (`channel`, `eventId`) did carry through as `''`.
// So a transport that omitted `chatType` had its request laundered into the one chat type that
// bypasses the `non-private-chat` guard, at `owner-admission.ts:255,263,366`.
//
// The deeper cause: `transportIdentityProblem` validated channel, chatId, userId and eventId for
// presence, and skipped `chatType` — the only identity field with no validity check, and the only one
// that had a fabricated default to fall back on.
//
// These cases go through the REAL `transportIdentityOf` and the REAL `OwnerAdmissionService`, because
// the bug is the seam between them. Asserting on either in isolation would not have caught it: the
// normaliser looked fine on its own, and admission looked fine on its own.

import { transportIdentityOf } from '../../src/gateway/router';
import { OwnerAdmissionService } from '../../src/profiles';
import { CryptoPairingCodePort, FileOwnerStatePort } from '../../src/runtime/adapters';
import type { Clock } from '../../src/ports/clock';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';

class FixedClock implements Clock {
  constructor(private instant = new Date('2026-03-01T10:00:00.000Z')) {}
  now(): Date {
    return new Date(this.instant);
  }
}

describe('transport identity never fails open on chatType', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-chat-type');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  /** A real admission service over a real, BOUND owner record. */
  async function boundAdmission() {
    const fixture = writeConfigFixture(root, { telegramEnabled: false });
    const admission = new OwnerAdmissionService({
      store: new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId),
      codes: new CryptoPairingCodePort(),
      clock: new FixedClock(),
      expectedOwnerId: fixture.ownerId,
    });
    await admission.initialize();
    const issued = await admission.issueChallenge();
    if (issued.kind !== 'issued') throw new Error('unreachable');
    const paired = await admission.handlePairing(
      { channel: 'telegram', chatId: 'chat-1', userId: 'user-1', chatType: 'private', eventId: 'e1' },
      issued.plaintext,
    );
    if (paired.kind !== 'paired') throw new Error(`pairing failed: ${paired.kind}`);
    return { admission, fixture, ownerId: fixture.ownerId };
  }

  it('does NOT fabricate `private` when the transport omits chatType', () => {
    // The narrow assertion: the normaliser must not invent the most-privileged value.
    const identity = transportIdentityOf({ chatId: 'chat-1', userId: 'user-1' });

    expect(identity.chatType).not.toBe('private');
    expect(identity.chatType).toBeUndefined();
  });

  it('REFUSES an owner-bound request whose chatType was never asserted', async () => {
    const { admission } = await boundAdmission();

    // Exactly the shape a transport omitting chatType produces, sent by the BOUND chat and user.
    const decision = admission.inspect(
      transportIdentityOf({ channel: 'telegram', chatId: 'chat-1', userId: 'user-1', eventId: 'e2' }),
    );

    // Before the fix this returned `{kind:'owner'}` and the request reached the owner's runtime.
    expect(decision.kind).toBe('refused');
  });

  it('names `missing-transport-identity` for an unasserted chatType', async () => {
    const { admission } = await boundAdmission();

    const decision = admission.inspect(
      transportIdentityOf({ channel: 'telegram', chatId: 'chat-1', userId: 'user-1', eventId: 'e3' }),
    );

    // An absent required field, so the existing reason applies — not a fabricated "private chat".
    if (decision.kind !== 'refused') throw new Error(`expected refused, got ${decision.kind}`);
    expect(decision.reason).toBe('missing-transport-identity');
  });

  it('still admits the bound owner when chatType IS asserted private', async () => {
    const { admission, ownerId } = await boundAdmission();

    const decision = admission.inspect(
      transportIdentityOf({
        channel: 'telegram',
        chatId: 'chat-1',
        userId: 'user-1',
        chatType: 'private',
        eventId: 'e4',
      }),
    );

    // The guard must fail CLOSED without breaking the real owner's normal path.
    expect(decision).toEqual({ kind: 'owner', ownerId });
  });

  it('still refuses group traffic as non-private-chat', async () => {
    const { admission } = await boundAdmission();

    const decision = admission.inspect(
      transportIdentityOf({
        channel: 'telegram',
        chatId: 'chat-1',
        userId: 'user-1',
        chatType: 'group',
        eventId: 'e5',
      }),
    );

    if (decision.kind !== 'refused') throw new Error(`expected refused, got ${decision.kind}`);
    expect(decision.reason).toBe('non-private-chat');
  });
});