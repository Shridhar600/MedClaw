# gateway

**Purpose:** The inbound pipeline and the composition root for a running process. A message arrives
through a channel, is admitted, becomes a turn, and reaches the owner's runtime — and only then.

**Public API (`index.ts` — the only import surface):**
- `Gateway`, `GatewayAdmissionDeps` — process-level composition: the admission gate, owner `OwnerPaths`,
  provider construction, the media stager, start/stop, quiescence reporting.
- `GatewayMessageRouter`, `GatewayMessageRouterDeps`, `transportIdentityOf`, `sweepStagedMedia`.
- `ProfileRuntime`, `ProfileRuntimeDeps`, `ProfileRuntimeManager`, `BuildRuntimeFor`.
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
   mandatory — there is no optional fallback. This replaced `if (this.admission)` branches that silently
   skipped the entire refusal policy on any Gateway composed without authority, and a text pass-through
   that handed an unadmitted sender a clinical turn.
2. **Admission runs before the empty-message check**, so a chat that is not the owner cannot consume a
   reply slot at all.
3. **Media is fetched only after admission.** The channel hands over an identity; the stager opens the
   stream. 10 MiB per file, 30-second total intake, one active download plus four waiting, and overload
   refuses *before* a stream is opened.

`buildRuntimeFor` refuses any identity that is not the selected owner, so no secondary fixture, job or
address can activate against owner state.

## Diagnostics

`Gateway` accepts an optional `DiagnosticSink` and guards it in its constructor. `emit` sits on the
critical path of `start()` and of media intake, so an adapter that throws would be reachable from a
stranger's message; the guard makes a throwing sink degrade to silence instead. Production supplies no
sink and therefore prints nothing — see `../ports/README.md`.

## Boot-time sweep

`sweepStagedMedia` is exported because boot must call it, and boot is the only safe moment: after the
workspace lease is acquired (so it cannot delete a live contender's media) and before intake is
accepted. It uses bounded directory iteration, never a recursive or global scan, and never follows a
symlink. Accepted as S1-R-01; proven through the real installation E2E.

## Extraction notes

Copy `src/gateway/` plus `../ports`, `../profiles`, `../channels` and the legacy core it composes. The
Gateway is the one module that is *meant* to know about all of them — it is the composition root, so it
sits at the top of the graph rather than inside it. A test that needs a Gateway should construct one
with real injected collaborators, never by patching private fields: several tests used to assign
`gateway.sessions` directly, which asserted against a machine production never builds.