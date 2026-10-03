import { OwnerAdmissionService } from '../profiles';
import type { OwnerAccessDiagnostics, ProfileId } from '../profiles';
import { systemClock } from '../ports/defaults';
import { CryptoPairingCodePort, FileOwnerStatePort } from './adapters';
import type { OwnerPaths } from '../profiles';

/**
 * The one place owner authority is composed for a running local process.
 *
 * Plan 15 §5 requires that a daemon's root gate its own direct build APIs, and forbids an optional
 * admission fallback in a new core API. That is only enforceable if there is a single composition
 * point: every entry path (the daemon in `src/index.ts`, local admin in `src/cli/admin.ts`) builds
 * admission here, from the identity and record path that ownership acquisition already resolved.
 * Nothing infers an owner, and nothing defaults to `'default'`.
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
  diagnostics: OwnerAccessDiagnostics = SILENT_DIAGNOSTICS,
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

/**
 * Diagnostics sink for callers that only need authority, not observability.
 *
 * Pairing outcomes are deliberately not logged anywhere: the event carries a chat-shaped identifier
 * and plan 15 §50 plus rollout §456 forbid identifiers and health text in logs. A surface that wants
 * real diagnostics supplies its own sink.
 */
const SILENT_DIAGNOSTICS: OwnerAccessDiagnostics = {
  recordPairingOutcome: () => {},
};
