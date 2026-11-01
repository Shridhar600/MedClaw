# runtime

**Purpose:** The local-process boundary — ownership, path derivation, leases, strict config loading, and
owner authority composition.

**Public API (`index.ts` — the only import surface):**
- Config selection and loading: `selectConfigPath`, `loadRuntimeConfig`, `defaultRuntimeConfigPath`,
  `parseGlobalOptions`, `ConfigSelectionError`, `ConfigUnavailableError`, `ONBOARD_GUIDANCE`.
- Installation ownership: `InstallationService`, `describeOwnershipRefusal`, `describeRefusal`,
  `InstallationOwnership`, `OwnershipResult`.
- Config documents: `readConfigDocument`, `writeConfigDocument`, `effectiveConfigFor`,
  `readConfigFile`, `writeConfigFile`, `canonicalizeConfigPath`, `ConfigFileSync`, `ConfigWriteOutcome`.
- Owner authority: `composeOwnerAuthority`, `OwnerAuthority`, `OwnerAuthoritySource`.
- Local composition edges: `DirectoryLease`, `FileOwnerStatePort`, `CryptoPairingCodePort`.
- Daemon diagnostics: `ConsoleDiagnosticSink` implements `DiagnosticSink`. It writes one compact line
  with closed stage/operation/outcome/reason and checked duration/counts. Unknown runtime vocabulary,
  invalid numbers and writer failures degrade to silence. No buffering or filesystem/network IO.
  Constructor accepts an optional line writer; its default uses `console.info`. The daemon selects
  one instance and shares it with authority/Gateway/staging; reusable modules stay silent by default.
- Media staging: `FsMediaStager`, `MediaStagerOptions` — injected source, explicit `trustedBaseDir`
  (selected owner workspace), lane and typed limits. Missing or unsafe authority refuses before IO.
- Artifact namespace: `createMediaArtifactName`, `isMediaStagingArtifact`, `MEDIA_PARTIAL_SUFFIX`.
  Generated UUIDv4 names share one grammar with boot cleanup; display names remain metadata.

**Dependencies:** `../ports`, `../profiles`, `../config`, `../security`, and `./adapters`. No `gateway/`,
no `channels/`, no core module.

## The rule this module exists to enforce

Ordering is a security property here, not a style preference:

```
select config path ─▶ take CONFIG lease ─▶ validate INSIDE it ─▶ take WORKSPACE lease ─▶ compose authority
```

- **Validate inside the config lease.** A process that read and validated before holding the lease could
  validate one file and then serve a different one.
- **Acquire config before workspace**, so two processes cannot deadlock by taking them in opposite
  orders.
- **Immediate busy refusal** on a held lease; a stale, unknown or malformed lease is *busy*, never
  silently stolen. No TTL expiry and no automatic unlock.
- **Release only this caller's acquired leases**, token-checked so one process cannot release another's.
- **No prompt, no provider call, no spawned daemon inside a critical section.** Critical sections are
  filesystem metadata only.
- **Composition cannot touch an unowned tree.** `composeOwnerAuthority` requires an
  already-acquired installation and reads/writes only the owner record inside that workspace.

Fresh structural parents and this caller's own lease metadata do not make a fresh install look
non-empty, while genuinely unrelated prior content still refuses under both leases — otherwise setup can
never run twice on a clean directory.

## Acquisition preconditions

A lease is a directory, so it cannot exist before its parent does, and a lease must be claimed before
its resource can be read. Setup therefore does one thing before `acquireOwnership` asks for anything:

```
scaffold config parent dirs (structure only) ─▶ CONFIG lease ─▶ owner lease ─▶ freshness ─▶ publish
```

- **Scaffolding is structure only.** `InstallationService.setup` creates the missing directories on the
  path to the selected document, at 0700, and nothing else — no template, no owner record, no document,
  no authority. This is what makes the advertised first run into `~/.redacted/config.json` work
  without the operator pre-creating a private folder by hand.
- **Scaffolding never touches what it did not create.** An existing ancestor keeps its own mode; a
  directory another process created concurrently is accepted as usable but never `chmod`ed.
- **The config lease is keyed on the real target.** A not-yet-existing document resolves through its
  nearest existing ancestor (`realpath`) plus the validated remainder, so the lease key, the reported
  canonical path and the bytes later written are the same object even when new parents sit below a
  symlinked existing ancestor.
- **The lease claim is the `mkdir`, and it never replaces anything.** `DirectoryLease` claims with one
  non-recursive `mkdir` at the lease path, which refuses with `EEXIST` for every existing entry shape
  — empty or populated directory, regular file, symlink, and dangling symlink that `existsSync` reports
  as absent. An existing entry is always `busy`, is never taken, cleared or repaired, and carries no TTL
  or auto-unlock. A contender that reaches a claim whose holder record has not landed yet refuses
  immediately as `malformed-holder` rather than waiting, stealing or repairing it.

## Concrete composition edges

Media intake preserves one total deadline and one staging attempt at a time; a second upload is refused.
Pre-aborted attempts open no source. Caller abort, core timeout and source failure have distinct results.
Race listeners are detached on settlement; a late source handle is cancelled. Refused pipelines close
their owned writable before unlinking its partial, so a pending open cannot recreate a discarded file.
Exclusive-open failure preserves the colliding entry; ownership begins only when our writable opens.
Final publication uses a same-lane exclusive hard link followed by partial removal, so it cannot replace
another artifact. Source failure keeps its cause while owned file close finishes.
Before source open and again before mutation, the stager validates the directory chain beneath its
explicit owner workspace. It creates missing components individually and checks their type and links.
Saved files are0600 and the lane is0700. Static checks do not provide atomic same-UID race protection.
External cancellation requests do not prove acknowledgement.

`adapters/` holds the concrete filesystem, crypto, lease and media implementations. They are reachable
through the public surface when local administration composes them. Media adapters retain their
existing app wiring. Owner policy still lives behind injected ports; exporting a concrete edge does
not make it a singleton or move its construction into a store.

## Config write durability boundary

A failed validation or refusal leaves the original bytes untouched — that is the preserved-writes rule.
But once a rename has **committed**, a later flush or acknowledgement failure must not restore the old
bytes or claim they survived: the writer inspects current validated state and reports committed vs
uncertain honestly. Durability is never claimed without flush evidence.

Config-temp cleanup tracks successful exclusive creation separately from an open descriptor. A refused
`wx` creation leaves the exact colliding entry alone; owned write/flush/rename failures close and remove
only their own temp. Ownership survives the descriptor close before rename. No temp sweep or restore.

## Extraction notes

Copy `src/runtime/` plus `../ports`, `../profiles`, `../config` and the `../security` helpers it uses. The
lease and ownership machinery is self-contained and filesystem-only; a different storage backend would
supply its own `ResourceLeasePort` adapter and change nothing here.
`ConsoleDiagnosticSink` can be extracted with `../ports` alone. It depends only on that public contract
and its numeric limits; a different output backend supplies a line writer without policy changes.
