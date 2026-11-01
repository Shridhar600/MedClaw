
/** Which local resource is being owned. */
export type LeaseResourceKind = 'config' | 'owner';

export interface LeaseTarget {
  kind: LeaseResourceKind;
  canonicalPath: string;
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
