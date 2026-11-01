// Public surface of the profiles module; everything else is private.
//
// `resolveOwnerPaths` and friends are pure path derivation. Chat-to-identity resolution is owned by
// owner admission, not by a registry.
export { resolveOwnerPaths, derivedPathsFor, asProfileId, isValidProfileId, OWNER_ID_PATTERN } from './paths';
export type { OwnerPaths } from './paths';
export { WriteQueue, replayJournal } from './write-queue';
export type { WritePriority, WriteOp, WriteQueueOptions } from './write-queue';
export type { ProfileId, ProfileMeta } from './types';

// Enrollment: the closed owner record, its decoder, and the admission state machine. Core shared
// shapes live in `src/ports/owner-state.ts` and are reexported here so callers have one surface.
export {
  decodeOwnerState,
  encodeOwnerState,
  newUnpairedOwnerState,
  utcDayOf,
} from './owner-state';
export type { OwnerStateDecode } from './owner-state';
export {
  OwnerAdmissionService,
  isWellFormedSubmission,
  refusalTextFor,
  PAIRING_COMPLETE_TEXT,
  PAIRING_EXPIRED_TEXT,
  PAIRING_INVALID_TEXT,
  PAIRING_LIMITED_TEXT,
  PAIRING_PROMPT_TEXT,
  PAIRING_REFUSED_TEXT,
  PAIRING_UNAVAILABLE_TEXT,
} from './owner-admission';
export type {
  InstallationAdmission,
  InitializeResult,
  IssueChallengeResult,
  OwnerAdmissionDeps,
} from './owner-admission';
export type {
  AdmissionDecision,
  AdmissionReason,
  OwnerBinding,
  OwnerChallenge,
  OwnerReadReason,
  OwnerState,
  OwnerStatePort,
  OwnerStateRead,
  OwnerStateWriteResult,
  OwnerWriteReason,
  PairingCodePort,
  PairingResult,
  PairingResultKind,
  TransportIdentity,
} from '../ports/owner-state';
export { isBoundOwnerState, isUnpairedOwnerState, OWNER_RECORD_MAX_BYTES } from '../ports/owner-state';
