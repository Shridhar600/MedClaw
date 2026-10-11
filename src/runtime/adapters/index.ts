// Public surface of the concrete runtime adapters. Each one is a bounded filesystem, crypto or
// ownership implementation of a port declared in `src/ports/`. Policy lives in `src/profiles`.

export {
  canonicalizeConfigPath,
  readConfigFile,
  writeConfigFile,
  MAX_CONFIG_BYTES,
} from './config-file';
export type {
  CanonicalPathResult,
  ConfigFileReason,
  ConfigFileSync,
  ConfigReadResult,
  ConfigWriteOutcome,
  ConfigWriteStatus,
} from './config-file';
export { DirectoryLease, describeLeaseForLocalInspection, isLocalProcessAlive, readHolder, releaseLeaseIfOwned } from './directory-lease';
export { FileOwnerStatePort, OWNER_RECORD_MAX_BYTES } from './owner-state-file';
export type { OwnerRecordFileSync } from './owner-state-file';
export { CryptoPairingCodePort } from './pairing-code';
export { FsMediaStager } from './media-stager';
export type { MediaStagerOptions } from './media-stager';
export { ConsoleDiagnosticSink } from './console-diagnostics';
