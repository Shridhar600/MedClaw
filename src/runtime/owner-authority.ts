import { OwnerAdmissionService } from '../profiles';
import type { ProfileId } from '../profiles';
import type { DiagnosticSink } from '../ports/diagnostics';
import { SILENT_DIAGNOSTIC_SINK } from '../ports/diagnostics';
import { systemClock } from '../ports/defaults';
import { CryptoPairingCodePort, FileOwnerStatePort } from './adapters';
import type { OwnerPaths } from '../profiles';

export interface OwnerAuthority {
  /** The configured owner identity. Never inferred, never defaulted. */
  readonly ownerId: ProfileId;
  /** The sole authority for who may reach a clinical runtime. */
  readonly admission: OwnerAdmissionService;
}

export interface OwnerAuthoritySource {
  readonly ownerId: ProfileId;
  readonly ownerPaths: Pick<OwnerPaths, 'ownerRecord'>;
}

export function composeOwnerAuthority(
  ownership: OwnerAuthoritySource,
  diagnostics: DiagnosticSink = SILENT_DIAGNOSTIC_SINK,
): OwnerAuthority {
  return {
    ownerId: ownership.ownerId,
    admission: new OwnerAdmissionService({
      store: new FileOwnerStatePort(ownership.ownerPaths.ownerRecord, ownership.ownerId),
      codes: new CryptoPairingCodePort(),
      clock: systemClock,
      expectedOwnerId: ownership.ownerId,
      diagnostics,
    }),
  };
}
