// src/gateway/index.ts
//
// The inbound pipeline. This file is the ONLY import surface for other modules; everything else in
// `gateway/` is private. App wiring imports from `../gateway`, never from `../gateway/gateway`.
//
// What lives here, and why the split matters:
//
//   - `Gateway` is the composition root for a RUNNING process: it owns the owner admission gate, the
//     owner-scoped `OwnerPaths`, provider construction, the media stager, start/stop and the
//     quiescence report. Plan 15 §5 requires a daemon's root gate its own direct build APIs, and that
//     is only enforceable if there is a single composition point.
//   - `ProfileRuntime` and `ProfileRuntimeManager` build and hold the owner's per-owner runtime. In S1
//     the manager's `buildRuntimeFor` REFUSES any identity that is not the selected owner.
//   - `GatewayMessageRouter` is where an admitted message becomes a turn, and where admission is
//     re-checked (`admission.inspect`) before anything else happens — including before the
//     empty-message check, so a stranger cannot consume a reply slot.
//   - `sweepStagedMedia` clears the owner's crash-left staging lane. It is exported because boot must
//     call it after workspace ownership is taken, which is the only safe moment to delete files.
//
// Nothing here reaches into another module's internals: channels arrive through `../channels`, owner
// authority through `../profiles` and `../runtime`, and IO through `../ports`.

export { Gateway } from './gateway';
export type { GatewayAdmissionDeps } from './gateway';

export { ProfileRuntimeManager } from './manager';
export type { BuildRuntimeFor } from './manager';

export { ProfileRuntime } from './runtime';
export type { ProfileRuntimeDeps } from './runtime';

export { GatewayMessageRouter, sweepStagedMedia, transportIdentityOf } from './router';
export type { GatewayMessageRouterDeps } from './router';

export { TurnCoordinator, TurnQueueFullError, heartbeatTurnId } from './turn-coordinator';
export type { HeartbeatTurnRequest, HeartbeatTurnResult } from './turn-coordinator';

export { SessionManager } from './session';
export type { SessionManagerOptions } from './session';