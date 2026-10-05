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
// deliberately NOT re-exported here: a consumer that needs a concrete adapter should import it from
// app wiring or a test fixture, so that production composition stays visible in `src/index.ts` rather
// than being hidden behind a barrel. `OwnerAuthority` is the exception, because composing owner
// authority IS the runtime module's job.

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
export type { OwnerAuthority, OwnerAuthoritySource } from './owner-authority';