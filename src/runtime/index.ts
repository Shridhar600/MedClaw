
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
