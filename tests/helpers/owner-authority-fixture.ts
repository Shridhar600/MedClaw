
import * as path from 'path';

import { composeOwnerAuthority } from '../../src/runtime/owner-authority';
import { asProfileId } from '../../src/profiles';
import type { OwnerAdmissionService } from '../../src/profiles';
import type { ProfileId } from '../../src/profiles/types';

/** The owner identity most fixtures declare. */
export const TEST_OWNER_CHAT = 'owner-chat';

export interface BoundOwnerFixture {
  admission: OwnerAdmissionService;
  ownerId: ProfileId;
  /** Spread into `new Gateway(config, deps)`. */
  gatewayDeps: { admission: OwnerAdmissionService; ownerId: ProfileId };
  /** The record path this owner was bound at, for assertions. */
  ownerRecord: string;
}

export async function bindOwnerFixture(
  ownerRecordPath: string,
  ownerId: string,
  chatId: string = TEST_OWNER_CHAT,
  transport: { channel?: string; userId?: string } = {},
): Promise<BoundOwnerFixture> {
  const id = asProfileId(ownerId);
  if (id === undefined) throw new Error(`invalid fixture owner id: ${ownerId}`);

  const authority = composeOwnerAuthority({
    ownerId: id,
    ownerPaths: { ownerRecord: ownerRecordPath },
  });

  await authority.admission.initialize();
  const issued = await authority.admission.issueChallenge();
  if (issued.kind !== 'issued') {
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
