// tests/helpers/gateway-owner-deps.ts
//
// One way to give a test Gateway the admission authority S1 now REQUIRES.
//
// WHY THIS EXISTS. `GatewayAdmissionDeps.admission` and `ownerId` became required in the T5 cutover.
// That was deliberate: `if (this.admission)` in `start()` had been silently skipping the entire S1
// refusal policy on any Gateway composed without admission, and `admitAndStage` had been passing text
// through unadmitted. Plan 15 §5 requires "New core APIs must not have an optional admission fallback",
// so there is no default to fall back on and every test must supply a real authority.
//
// Every test that does so has the same three questions — which owner, which record, which chat — and the
// honest answers are all derivable from the `EffectiveConfig` the test already built. This helper derives
// them and drives the REAL enrollment state machine (`issue -> submit -> commit`), so a fixture cannot
// accidentally rely on a record shape the real writer would never produce.
//
// It does NOT write a record by hand. Tests that need to assert on a specific binding (a mid-flight
// rebind, an unpaired boot, a stranger) call `bindOwnerFixture` or `composeOwnerAuthority` directly.

import type { EffectiveConfig } from '../../src/config/types';
import { asProfileId, resolveOwnerPaths } from '../../src/profiles';
import type { GatewayAdmissionDeps } from '../../src/gateway/gateway';
import type { OwnerAdmissionService } from '../../src/profiles';
import type { ProfileId } from '../../src/profiles/types';
import { bindOwnerFixture } from './owner-authority-fixture';

/**
 * Bind an owner for `config` and return deps ready to spread into `new Gateway(config, deps)`.
 *
 * @param config   the SAME effective config the Gateway will be constructed with — the owner identity
 *                 and record path are derived from it, so a fixture cannot point the authority at one
 *                 owner while the Gateway serves another.
 * @param chatId   the chat to bind. Defaults to `TEST_OWNER_CHAT`. Pass the chat your test sends from, or
 *                 admission will (correctly) refuse it.
 * @param transport the identity the Gateway will present. Admission compares channel + chatId + userId
 *                 against the binding, and REQUIRES a non-empty `channel`, `userId` and `eventId` plus
 *                 `chatType: 'private'`, so an inbound test message must carry the same values.
 *                 `handleTestMessage` presents `local`/`local`; a raw `handleMessage({...})` literal must
 *                 now include the identity fields it previously omitted.
 */
export async function bindGatewayOwner(
  config: EffectiveConfig,
  chatId: string,
  transport: { channel?: string; userId?: string } = { channel: 'local', userId: 'local' },
): Promise<GatewayAdmissionDeps> {
  const ownerId = asProfileId(config.profiles?.defaultProfileId ?? '');
  if (ownerId === undefined) {
    throw new Error(
      `bindGatewayOwner: config names no valid owner id (${JSON.stringify(config.profiles)}); `
      + 'a Gateway cannot be given admission authority without one',
    );
  }
  const ownerRecord = resolveOwnerPaths(config.profiles!.baseDir, ownerId).ownerRecord;
  return (await bindOwnerFixture(ownerRecord, ownerId, chatId, transport)).gatewayDeps;
}

/**
 * Admission authority for a config whose owner record is seeded but NOT yet bound.
 *
 * `initialize()` commits an unpaired record through the real store, which is the state a fresh install
 * is in. A Gateway booted with these deps serves pairing only and builds no clinical runtime.
 */
export async function unpairedGatewayOwner(config: EffectiveConfig): Promise<{
  admission: OwnerAdmissionService;
  ownerId: ProfileId;
}> {
  const ownerId = asProfileId(config.profiles?.defaultProfileId ?? '');
  if (ownerId === undefined) throw new Error('unpairedGatewayOwner: config names no valid owner id');
  const ownerRecord = resolveOwnerPaths(config.profiles!.baseDir, ownerId).ownerRecord;
  const { composeOwnerAuthority } = await import('../../src/runtime/owner-authority');
  const authority = composeOwnerAuthority({ ownerId, ownerPaths: { ownerRecord } });
  await authority.admission.initialize();
  return { admission: authority.admission, ownerId };
}
