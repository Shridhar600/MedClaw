# gateway

**Purpose:** The inbound pipeline and the composition root for a running process. A message arrives
through a channel, is admitted, becomes a turn, and reaches the owner's runtime — and only then.

**Public API (`index.ts` — the only import surface):**
- `Gateway`, `GatewayAdmissionDeps` — process-level composition: the admission gate, owner `OwnerPaths`,
  provider construction, the media stager, start/stop, quiescence reporting.
- `GatewayMessageRouter`, `GatewayMessageRouterDeps`, `transportIdentityOf`.
- `sweepStagedMedia`, `MediaSweepResult`, `MEDIA_SWEEP_ENTRY_LIMIT`; actual consumer outcome is available
  as `Gateway.stagingCleanupResult`.
- `ProfileRuntime`, `ProfileRuntimeDeps`, `ProfileRuntimeManager`, `BuildRuntimeFor`.
  `ProfileRuntime.getShutdownDisposition()` reports `'pending'` while any continuation that can touch
  owner resources is still unsettled — including a `drainAndClose()` phase abandoned at the shared
  10s budget. It deliberately disagrees with `isClosed()`: `closed` means the stores were closed, not
  that the work finished. `Gateway.getShutdownDisposition()` aggregates it over every built runtime,
  and only `'quiescent'` authorises the root to release installation ownership.
  `Gateway.start()` refuses (throws, and `start()` emits `start-stop`/`refused` with reason
  `previous-work-unsettled`) rather than *replacing* a generation that still reports `'pending'`:
  draining the old manager is bounded and memoized, so overwriting it would not prove anything
  finished — it would only make the live continuation unreachable from the disposition above. The
  check runs twice, before any provider is built and again immediately after the drain, because that
  drain can itself abandon a phase and make a previously-quiescent generation pending. Neither
  refusal builds a runtime, router or scheduler, and neither drops or loses the old generation, so a
  later `start()` succeeds once the old work really settles. The FIRST refusal additionally happens
  before any provider/semaphore/workspace work, so it is side-effect free; the post-drain re-check
  necessarily runs after the provider and semaphore construction `serveOwner` does ahead of the drain,
  which is why it exists at all.
- `TurnCoordinator`, `TurnQueueFullError`, `heartbeatTurnId`, `HeartbeatTurnRequest/Result`.
- `SessionManager`, `SessionManagerOptions`.

Everything else in `gateway/` — `router.ts`, `turn-coordinator.ts`, `session.ts`, `session-window.ts`,
`manager.ts`, `runtime.ts` — is private. `index.ts` is a re-export surface over those, not a
re-implementation.

**Dependencies:** `../channels`, `../profiles`, `../runtime`, `../ports`, `../security`, plus legacy core
(`agent`, `memory`, `scheduler`, `tools`, `providers`, `workspace`). This module is above them, never
inside them.

## The ordering this module exists to enforce

```
inbound ─▶ admission ─▶ media staging ─▶ route ─▶ turn ─▶ owner runtime
```

Three properties depend on that order, and each has a test that fails if it is broken:

1. **Admission is required and runs first.** `GatewayAdmissionDeps.admission` and `ownerId` are
   mandatory — there is no optional fallback. An optional admission would silently skip the entire
   refusal policy on a Gateway composed without authority and hand an unadmitted sender a clinical turn.
2. **Admission runs before the empty-message check**, so a chat that is not the owner cannot consume a
   reply slot at all.
3. **Media is fetched only after admission.** The channel hands over an identity; the stager opens the
   stream. 10 MiB per file, 30-second total intake, one upload staging at a time, and a second
   upload refuses *before* a stream is opened.

`buildRuntimeFor` refuses any identity that is not the selected owner, so no secondary fixture, job or
address can activate against owner state.

## Diagnostics

`Gateway` accepts an optional `DiagnosticSink` and guards it in its constructor. `emit` sits on the
critical path of `start()` and of media intake, so an adapter that throws would be reachable from a
stranger's message; the guard makes a throwing sink degrade to silence instead. The daemon root supplies
one `ConsoleDiagnosticSink` to authority/Gateway/staging. Direct constructors remain silent. Router has
no raw incoming-message log. Start and promotion each emit one terminal result per attempt/flight,
distinguished by closed `operation`; Gateway stop completion does not prove root ownership release.

## Boot-time sweep

`sweepStagedMedia` is exported because boot must call it, and boot is the only safe moment: after the
workspace lease is acquired (so it cannot delete a live contender's media) and before intake is
accepted, including unpaired boot. One attempt visits at most256 entries through a directory handle;
unrelated files, directories and links consume that budget. It removes only regular files in the shared
`medclaw-media-`/UUIDv4 namespace (including `.part`), preserving all links and other content. A safe
missing lane completes with zero work and creates nothing.

`complete`, `partial` and `unavailable` report actual inspected/removed counts. Reaching the cap without
observed EOF is partial. IO/close failures cannot complete. Gateway retains the actual result and emits
at most one closed-field warning for an incomplete attempt. It never retries during promotion or live
intake; a fresh Gateway boot can revisit leftovers. Cleanup does not erase authority or block owner text.
This bounds userland work, not IO elapsed time, and provides static containment rather than atomic
protection against hostile same-UID replacement races. Clinical inbox retention is separate.

## Extraction notes

Copy `src/gateway/` plus `../ports`, `../profiles`, `../channels` and the legacy core it composes. The
Gateway is the one module that is *meant* to know about all of them — it is the composition root, so it
sits at the top of the graph rather than inside it. A test that needs a Gateway should construct one
with real injected collaborators, never by patching private fields, such as assigning `gateway.sessions` directly: that asserts
against a machine production never builds.
