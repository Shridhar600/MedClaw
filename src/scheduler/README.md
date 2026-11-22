# scheduler

Durable heartbeat scheduling and bounded local inspection. The public surface is `index.ts`.

- `HeartbeatStore`, `HeartbeatScheduler`: runtime storage, cron registration, delivery/retry state.
- `buildDesiredHeartbeatJobs`, `reconcilePolicyJobs`: desired policy jobs and durable reconciliation.
- `inspectHeartbeats(path): HeartbeatInspection`: synchronous, non-mutating snapshot for local admin.
- `MAX_HEARTBEAT_INSPECTION_BYTES`, `InspectedHeartbeatJob`: explicit byte budget and rendered projection.

Inspection distinguishes missing, valid array (empty or populated), corrupt and unavailable. It validates
the fields the formatter renders and defaults only absent `deliveryState` to the existing `ready` value.
It does not certify unrelated runtime fields, migrate records, construct a recovering store, quarantine,
create directories, chmod, schedule or cache. Reads are bounded on the opened descriptor at 256 KiB,
with one extra byte solely to detect excess after metadata checks. Every opened descriptor closes in
finally. Nonblocking/no-follow open refuses unsupported nonfiles/links without waiting on a FIFO.

Runtime recovery and normalization remain in `HeartbeatStore`; inspection never invokes them. Cron
creation, enabled updates, resume and startup registration use the config public API's pure resource
preflight before installed `node-cron`: at most1024 UTF16 input units and512 conservatively reserved
range values. Recovery applies the same guard before TimeMatcher even if a startup disable write fails.
Refused edits preserve existing jobs; startup normally disables unsafe stored jobs and marks an error.
Failed disable writes do not count as persisted disable; recovery skips that unsafe job. Paused records
remain editable/deletable without expanding cron. Errors do not echo the submitted expression. Installed
cron semantics stay authoritative within the budget; no calendar-feasibility promise or recurrence engine.
Config does not import this scheduler barrel, so this policy relationship introduces no cycle.

Dependencies: Node filesystem/crypto, `node-cron`, security helpers and config's pure policy/public API.
Copy this module with those dependencies; callers inject paths/destinations and trigger callbacks.
No config-file or registry lookup occurs inside a store. Provider/channel delivery stays injected.
