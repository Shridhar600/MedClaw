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

## `adapters/` is deliberately not re-exported

`adapters/` holds the concrete filesystem, crypto, lease and media implementations. They are reachable
from app wiring and test fixtures but intentionally absent from this barrel, so that production
composition stays visible in `src/index.ts` instead of hiding behind an import. `OwnerAuthority` is the
one exception: composing owner authority *is* this module's job.

## Config write durability boundary

A failed validation or refusal leaves the original bytes untouched — that is the preserved-writes rule.
But once a rename has **committed**, a later flush or acknowledgement failure must not restore the old
bytes or claim they survived: the writer inspects current validated state and reports committed vs
uncertain honestly. Durability is never claimed without flush evidence.

## Extraction notes

Copy `src/runtime/` plus `../ports`, `../profiles`, `../config` and the `../security` helpers it uses. The
lease and ownership machinery is self-contained and filesystem-only; a different storage backend would
supply its own `ResourceLeasePort` adapter and change nothing here.