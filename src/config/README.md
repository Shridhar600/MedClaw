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
  `parseConfigSetPath(input)`, `protectedSetReason(validatedPath)`, `formatConfigIssue(issue)`,
  `expandHomePath(value, homeDir)`.
- `cloneStoredDefaults()`, `DEFAULT_STORED_CONFIG`, `DEFAULT_SESSION_WINDOW`.
- `isCronValidationWorkBounded(input)` — pure resource preflight shared with scheduler registration/recovery;
  it does not decide cron syntax or promise a future occurrence.

**One rule set:** `decodeStoredConfig` (shape) and `semanticIssues` (cross-field) are the only
validators. `validateConfig` runs the same semantic rules so the wizard, `config set` and the
start preflight cannot disagree with what startup accepts.

`config set` trims dotted segments once. It rejects empty segments, brackets and prototype keys.
Protection and mutation consume the same validated segments. Protected fields include ancestors
and descendants: replacing `sessions` cannot change a retired reset setting indirectly. Declared
nonidentity descendants remain writable. The full decoder still refuses unknown fields/invalid values.

Heartbeat default cron first passes the shared resource preflight: at most1024 UTF16 input units and
512 reserved range values across five/six fields. It matches installed name/wildcard normalization,
checks overlapping range endpoints within field domains and reserves the full domain per hyphen.
This bounds conversion before installed `node-cron.validate` decides semantics. Normal names, lists,
reversed ranges, steps and weekday aliases remain supported; highly redundant ranges may exceed the
conservative budget. Both enabled and disabled defaults use this policy. Refusal identifies the
field/reason without the submitted expression. Syntax acceptance does not promise a future calendar
occurrence; this is not a calendar or recurrence engine.

**Provider endpoints:** a LOCAL role must carry its local base URL. A CLOUD role may carry an
explicit endpoint — OpenRouter has no SDK default, so setup writes its router URL and the document
must be able to keep it — but it must not carry `LOCAL_OLLAMA_BASE_URL`, which is the concrete
inheritance mistake (plan 15 §2.1: "cloud provider selection never inherits a local base URL").
Structural URL validity is decided separately and earlier: a non-http(s) scheme, an unparseable
string or a wrongly typed value is still refused. The rule is deliberately not an SSRF policy and
does not ban private or loopback endpoints at other URLs.

**Dependencies:** node builtins (`os`, `path`), installed `node-cron` for scheduler-equivalent cron semantics, and
`src/safety/emergency-detector` for the built-in emergency keyword constant.

**Extraction notes:** copy `src/config/` plus `src/profiles/paths.ts` and `src/safety/`.
The module has no filesystem dependency, so it compiles and is testable standalone.
`src/profiles` is v2-core and may not import this module; the dependency direction is
`config → profiles/paths` only, never the reverse.
