// tests/helpers/owner-authority-fixture.ts
//
// One place that produces a genuinely BOUND owner for a serving test.
//
// Why this exists: S1 made `OwnerAdmissionService` the sole authority for who may reach a clinical runtime,
// and the RR2-B1 destination guard now consults `OwnerState.binding.chatId` rather than the legacy profile
// registry. Every test that boots a Gateway and expects scheduled work — or an admitted turn — to actually
// run therefore has to supply a real bound owner record. Without one the guard fails closed, which is
// correct behaviour and makes the job look "inert".
//
// This mirrors production composition exactly: the same `composeOwnerAuthority` the daemon uses, the same
// `FileOwnerStatePort`, the same `CryptoPairingCodePort`. It binds through the real pairing state machine
// (issue -> submit -> commit) rather than hand-writing a record, so a test cannot accidentally rely on a
// record shape the real writer would never produce.

import * as path from 'path';

import { composeOwnerAuthority } from '../../src/runtime/owner-authority';
import { asProfileId } from '../../src/profiles';
import type { OwnerAdmissionService } from '../../src/profiles';
import type { ProfileId } from '../../src/profiles/types';

/** The owner identity most S1 fixtures declare. */
export const TEST_OWNER_CHAT = 'owner-chat';

export interface BoundOwnerFixture {
  admission: OwnerAdmissionService;
  ownerId: ProfileId;
  /** Spread into `new Gateway(config, deps)`. */
  gatewayDeps: { admission: OwnerAdmissionService; ownerId: ProfileId };
  /** The record path this owner was bound at, for assertions. */
  ownerRecord: string;
}

/**
 * Bind an owner at `ownerRecordPath`, through the real enrollment state machine.
 *
 * @param ownerRecordPath where the durable record lives — normally `<workspace>/.state/owner-access.json`
 * @param chatId         the chat the owner is bound to; this is what the destination guard authorizes
 */
export async function bindOwnerFixture(
  ownerRecordPath: string,
  ownerId: string,
  chatId: string = TEST_OWNER_CHAT,
  /**
   * The transport identity the owner is bound over. Admission compares the whole identity, so a test that
   * reaches the Gateway through `handleTestMessage` (which presents `channel: 'local'`, `userId: 'local'`)
   * MUST bind a matching `local` identity, or its messages are correctly refused.
   */
  transport: { channel?: string; userId?: string } = {},
): Promise<BoundOwnerFixture> {
  const id = asProfileId(ownerId);
  if (id === undefined) throw new Error(`invalid fixture owner id: ${ownerId}`);

  const authority = composeOwnerAuthority({
    ownerId: id,
    ownerPaths: { ownerRecord: ownerRecordPath },
  });

  // `initialize` is idempotent for an existing record; a pre-existing one is fine as long as we can bind.
  await authority.admission.initialize();
  const issued = await authority.admission.issueChallenge();
  if (issued.kind !== 'issued') {
    // Already bound from an earlier call in the same test — that is legitimate, not a failure.
    return {
      admission: authority.admission,
      ownerId: id,
      gatewayDeps: { admission: authority.admission, ownerId: id },
      ownerRecord: ownerRecordPath,
    };
  }

  const channel = transport.channel ?? 'telegram';
  const userId = transport.userId ?? 'owner-user';
  const result = await authority.admission.handlePairing(
    {
      channel,
      chatId,
      userId,
      chatType: 'private',
      eventId: `${channel}:${chatId}:bind`,
    },
    issued.plaintext,
  );
  if (result.kind !== 'paired') {
    throw new Error(`owner fixture could not bind: ${result.kind}`);
  }

  return {
    admission: authority.admission,
    ownerId: id,
    gatewayDeps: { admission: authority.admission, ownerId: id },
    ownerRecord: ownerRecordPath,
  };
}

/** The conventional record path for a workspace produced by `fixtureOwner`/`resolveOwnerPaths`. */
export function ownerRecordPathFor(workspace: string): string {
  return path.join(workspace, '.state', 'owner-access.json');
}
