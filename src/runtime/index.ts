// src/runtime/index.ts
//
// The local-process boundary: ownership, paths, leases and startup. This file is the ONLY import
// surface for other modules; everything else in `runtime/` (including `adapters/`) is private.
//
// The rule that matters here is ordering, because it is a security property rather than a style one.
// Plan 15 §2.5 requires: take the config lease, validate INSIDE it, then take the workspace lease.
// A process that validated before holding the config lease could validate one file and then serve
// another. `InstallationService` is the single place that ordering is expressed, and
// `composeOwnerAuthority` refuses to build owner authority without an already-acquired installation,
// so composing authority cannot touch an unowned tree.
//
// `adapters/` holds the concrete filesystem, crypto, lease and media implementations. They are
// exposed only where concrete local composition consumes them. Local admin composes the config lease
// and owner authority through this public surface; media composition keeps its existing app wiring.

export {
  defaultRuntimeConfigPath,
  loadRuntimeConfig,
  parseGlobalOptions,
  selectConfigPath,
  ConfigSelectionError,
  ConfigUnavailableError,
  ONBOARD_GUIDANCE,
} from './startup';
export type {
  ConfigSelectionInput,
  GlobalOptionParse,
  LoadRuntimeConfigOptions,
} from './startup';

export {
  InstallationService,
  describeOwnershipRefusal,
  describeRefusal,
  effectiveConfigFor,
  readConfigDocument,
  writeConfigDocument,
  canonicalizeConfigPath,
  readConfigFile,
  writeConfigFile,
} from './installation';
export type {
  ConfigFileSync,
  ConfigWriteOutcome,
  InstallationOwnership,
  InstallationServiceOptions,
  LoadedConfigDocument,
  OwnershipResult,
  OwnerStateStoreFactory,
  SetupInput,
  SetupResult,
} from './installation';

export { composeOwnerAuthority } from './owner-authority';
export { FsMediaStager } from './adapters';
export { createMediaArtifactName, isMediaStagingArtifact, MEDIA_PARTIAL_SUFFIX } from './media-artifact';
export type { MediaStagerOptions } from './adapters';
export type { OwnerAuthority, OwnerAuthoritySource } from './owner-authority';
// Existing local-admin composition consumers use these concrete edges through the public surface.
export { DirectoryLease, FileOwnerStatePort, CryptoPairingCodePort } from './adapters';
