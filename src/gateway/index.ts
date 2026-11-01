// The inbound pipeline. This file is the only import surface for other modules; everything else in
// `gateway/` is private. App wiring imports from `../gateway`, never from `../gateway/gateway`.
//
// - `Gateway` is the composition root for a running process: owner admission gate, owner-scoped paths,
//   provider construction, the media stager, start/stop and the quiescence report.
// - `ProfileRuntime` and `ProfileRuntimeManager` build and hold the owner's runtime; the manager
//   refuses any identity that is not the selected owner.
// - `GatewayMessageRouter` turns an admitted message into a turn and re-checks admission first.
// - `sweepStagedMedia` clears the owner's crash-left staging lane. Boot calls it after workspace
//   ownership is taken, the only safe moment to delete files.
//
// Channels arrive through `../channels`, owner authority through `../profiles` and `../runtime`, and
// IO through `../ports`.
export { Gateway } from './gateway';
export type { GatewayAdmissionDeps } from './gateway';

export { ProfileRuntimeManager } from './manager';
export type { BuildRuntimeFor } from './manager';

export { ProfileRuntime } from './runtime';
export type { ProfileRuntimeDeps } from './runtime';

export { GatewayMessageRouter, transportIdentityOf } from './router';
export { sweepStagedMedia, MEDIA_SWEEP_ENTRY_LIMIT } from './media-sweep';
export type { MediaSweepResult } from './media-sweep';
export type { GatewayMessageRouterDeps } from './router';

export { TurnCoordinator, TurnQueueFullError, heartbeatTurnId } from './turn-coordinator';
export type { HeartbeatTurnRequest, HeartbeatTurnResult } from './turn-coordinator';

export { SessionManager } from './session';
export type { SessionManagerOptions } from './session';
