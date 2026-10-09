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
creation/updates use installed `node-cron`, also used directly by config semantic validation. Config
does not import this scheduler barrel, so the policy/config relationship introduces no cycle.

Dependencies: Node filesystem/crypto, `node-cron`, security helpers and typed config inputs for policy.
Copy this module with those dependencies; callers inject paths/destinations and trigger callbacks.
No config-file or registry lookup occurs inside a store. Provider/channel delivery stays injected.
