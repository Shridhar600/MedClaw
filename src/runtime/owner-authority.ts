import { OwnerAdmissionService } from '../profiles';
import type { ProfileId } from '../profiles';
import type { DiagnosticSink } from '../ports/diagnostics';
import { SILENT_DIAGNOSTIC_SINK } from '../ports/diagnostics';
import { systemClock } from '../ports/defaults';
import { CryptoPairingCodePort, FileOwnerStatePort } from './adapters';
import type { OwnerPaths } from '../profiles';

/**
 * The one place owner authority is composed for a running local process.
 *
 * Every entry path (the daemon in `src/index.ts`, local admin in `src/cli/admin.ts`) builds
 * admission here, from the identity and record path that ownership acquisition already resolved.
 * A daemon root must gate its own direct build APIs, so there is a single composition point and no
 * optional admission fallback. Nothing infers an owner, and nothing defaults to `'default'`.
 */
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

/**
 * Build owner authority from an already-acquired installation.
 *
 * The caller must have taken the owner workspace lease first. This function reads and writes only
 * the owner record inside that workspace, so composing authority cannot touch an unowned tree.
 */
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

/*
 * Diagnostics default to silence, deliberately.
 *
 * The closed `DiagnosticEvent` union carries no identifier, no path and no exception text, since a
 * chat id or pairing code in a log line would be a disclosure and a rate-limit oracle. A caller
 * that wants outcomes supplies a sink over the closed contract; a caller that does not gets
 * silence rather than an accidental stdout print.
 */
