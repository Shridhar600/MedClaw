
import type { EffectiveConfig } from '../../src/config/types';
import { asProfileId, resolveOwnerPaths } from '../../src/profiles';
import type { GatewayAdmissionDeps } from '../../src/gateway/gateway';
import type { OwnerAdmissionService } from '../../src/profiles';
import type { ProfileId } from '../../src/profiles/types';
import { bindOwnerFixture } from './owner-authority-fixture';

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
