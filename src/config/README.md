# config

**Purpose:** Configuration policy only — stored/effective types, the total decoder, the
declared non-identity defaults, and assembly of the owner-derived effective configuration.
**This module performs no filesystem access.** Bounded config IO lives in
`src/runtime/adapters/config-file.ts`; lease-owned writers live in `src/runtime/installation.ts`.

**Persisted shape (`schemaVersion: 2`, `StoredConfig` in `types.ts`):**
- `schemaVersion` must equal `2`.
- `profiles: { baseDir, defaultProfileId }` is **mandatory**. Identity is never inferred
  from defaults.
- `memory.workspace`, `heartbeat.storePath` and `heartbeat.audit` are **not persisted**.
  They are derived from `profiles.baseDir` + `profiles.defaultProfileId` through
  `resolveOwnerPaths`, so there is exactly one path authority.
- Unknown keys, prototype keys and the retired path keys above are refused with an
  allowlisted field/reason. Input values never appear in an error message.

**Effective shape (`EffectiveConfig`):** the stored document plus the three derived owner
paths. This is what the gateway, scheduler, session and admin code already read
(`config.memory.workspace`, `config.heartbeat.storePath`, `config.heartbeat.audit.path`),
so stores stay path-agnostic and no module re-derives a path.

**Public API (`index.ts`):**
- `getDefaultConfig(): EffectiveConfig` — fresh copy of the defaults plus default derived paths.
- `decodeConfigDocument(input: unknown, opts?): ConfigDecodeResult` — total decode of an
  unknown value. Never throws for bad input; returns typed issues.
- `effectiveFromStored(stored, paths)` / `resolveEffectiveConfig(stored, paths)` — inject the
  owner paths resolved by the caller.
- `serializeStoredConfig(stored): string` — the single persisted form.
- `validateConfig(config)`, `redactConfig(value)`, `toStoredView(config)`,
  `protectedSetReason(dottedPath)`, `formatConfigIssue(issue)`, `expandHomePath(value, homeDir)`.
- `cloneStoredDefaults()`, `DEFAULT_STORED_CONFIG`, `DEFAULT_SESSION_WINDOW`.

**One rule set:** `decodeStoredConfig` (shape) and `semanticIssues` (cross-field) are the only
validators. `validateConfig` runs the same semantic rules so the wizard, `config set` and the
start preflight cannot disagree with what startup accepts.

**Dependencies:** node builtins (`os`, `path`), `json5` (via the IO adapter), and
`src/safety/emergency-detector` for the built-in emergency keyword constant.

**Extraction notes:** copy `src/config/` plus `src/profiles/paths.ts` and `src/safety/`.
The module has no filesystem dependency, so it compiles and is testable standalone.
`src/profiles` is v2-core and may not import this module; the dependency direction is
`config → profiles/paths` only, never the reverse.
