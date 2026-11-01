// src/runtime/index.ts
//
// The local-process boundary: ownership, paths, leases and startup. This file is the only import surface for
// other modules; everything else in `runtime/` (including `adapters/`) is private.
//
// The rule that matters here is ordering, because it is a security property rather than a style one: take the
// config lease, validate inside it, then take the workspace lease. A process that validated before holding the
// config lease could validate one file and then serve another. `InstallationService` is the single place that
// ordering is expressed, and `composeOwnerAuthority` refuses to build owner authority without an already-acquired
// installation, so composing authority cannot touch an unowned tree.
//
// `adapters/` holds the concrete filesystem, crypto, lease and media implementations. They are exposed only where
// concrete local composition consumes them.

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
export { FsMediaStager, ConsoleDiagnosticSink } from './adapters';
export { createMediaArtifactName, isMediaStagingArtifact, MEDIA_PARTIAL_SUFFIX } from './media-artifact';
export type { MediaStagerOptions } from './adapters';
export type { OwnerAuthority, OwnerAuthoritySource } from './owner-authority';
// Concrete adapters consumed by local-admin composition.
export { DirectoryLease, FileOwnerStatePort, CryptoPairingCodePort } from './adapters';
