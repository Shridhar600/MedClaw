// src/ports/resource-lease.ts
//
// Ownership seam for the two local resources a MedClaw installation contends on:
// the selected configuration document and the selected owner workspace.
//
// Interface-only. The contract is deliberately small:
//
//  - there is no check-then-create, no TTL, no renewal and no steal;
//  - a contended or unrecognised lease is `busy` with honest local-inspection guidance, never
//    automatic recovery;
//  - release is token-checked and idempotent, and can only ever remove the caller's own lease.
//
// Ports use plain strings so this file never imports an application module upward.

/** Which local resource is being owned. */
export type LeaseResourceKind = 'config' | 'owner';

export interface LeaseTarget {
  kind: LeaseResourceKind;
  /**
   * Canonical path of the resource itself. Two aliases of the same file canonicalize to the same
   * value, so they contend on the same lease.
   */
  canonicalPath: string;
  /**
   * Explicit lease directory, when the resource already names its own lease location (the owner
   * workspace lease is `<workspace>/.state/installation.lease`). When omitted the adapter uses
   * `<canonicalPath>.lease`, which is what a configuration document wants.
   */
  leasePath?: string;
}

/** Private holder metadata written inside the lease directory. */
export interface LeaseHolder {
  token: string;
  pid: number;
  kind: LeaseResourceKind;
}

export type LeaseHolderState =
  /** holder.json parsed and carries a token. */
  | 'readable'
  /** the lease directory exists but its metadata is absent or unparseable. */
  | 'malformed'
  /** the lease directory does not exist at all. */
  | 'absent';

export type LeaseBusyReason = 'held' | 'malformed-holder';

export interface LeaseBusy {
  kind: 'busy';
  resource: LeaseResourceKind;
  reason: LeaseBusyReason;
  holderState: LeaseHolderState;
  /**
   * Whether a process matching the recorded pid currently exists. This is diagnostic only:
   * a live, reused or unknown pid is never proof that a lease is stale, and no automatic
   * clearance is ever offered on the basis of it.
   */
  recordedPidAlive?: boolean;
  /** Operator-facing next step. Never contains the lease path. */
  guidance: string;
}

export interface LeaseAcquired {
  kind: 'acquired';
  resource: LeaseResourceKind;
  token: string;
  /** Release only this caller's lease. Safe to call more than once. */
  release(): Promise<void>;
}

export type LeaseUnavailableReason =
  /** the lease's parent directory does not exist or is not a directory. */
  | 'unsafe-parent'
  /** the filesystem refused the operation. */
  | 'permission';

export interface LeaseUnavailable {
  kind: 'unavailable';
  resource: LeaseResourceKind;
  reason: LeaseUnavailableReason;
  guidance: string;
}

export type LeaseResult = LeaseAcquired | LeaseBusy | LeaseUnavailable;

export interface ResourceLeasePort {
  /** Immediate acquisition or immediate refusal. Never waits and never retries. */
  tryAcquire(target: LeaseTarget): Promise<LeaseResult>;
}
