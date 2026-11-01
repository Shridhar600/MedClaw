export type Authority = 'doctor' | 'lab' | 'report' | 'sensor' | 'user' | 'inference';
export const AUTHORITY_RANK: Record<Authority, number> = {
  doctor: 5, lab: 5, report: 4, sensor: 3, user: 2, inference: 1,
};

export interface Provenance {
  source: Authority;
  confidence: number;
  anchor: string;
  capturedAt: string;
  note?: string;
}

export type FactStatus = 'active' | 'superseded' | 'retracted' | 'discontinued'
  | 'resolved' | 'paused' | 'disputed';

export type FactType = 'medication' | 'condition' | 'symptom' | 'appointment'
  | 'metric' | 'goal' | 'allergy';

export interface LedgerFact {
  id: string;
  profileId: string;
  entity: string;
  type: FactType;
  version: number;
  supersedes?: string;
  supersededBy?: string;
  replaces?: string;
  replacedBy?: string;
  corrects?: string;
  correctedBy?: string;
  status: FactStatus;
  /** Set on a `discontinued` fact. */
  discontinuedReason?: string;
  fields: Record<string, string | number | string[]>;
  provenance: Provenance;
  safetyRelevant: boolean;
  episodeId?: string;
  language: string;
  verbatim?: string;
  visibility: 'private' | 'shareable-summary' | 'shareable-full';
  createdAt: string;
}

export interface ConfirmationToken {
  uuid: string;
  entityId: string;
  changeHash: string;
  expiresAt: string;
  singleUse: true;
}

export interface ConfirmationContext {
  chatId?: string;
  turnId: string;
}

export interface MetricPoint {
  metric: string;
  value: number;
  unit: string;
  ts: string;
  anchor: string;
}

export interface NarrativeNote {
  id: string;
  profileId: string;
  date: string;
  content: string;
  anchor: string;
  language: string;
  createdAt: string;
}

export type CuriosityKind = 'follow-up' | 'medication-reminder' | 'lab-correlation' | 'information-gap' | 'insight' | 'missing-data';

export interface CuriosityItem {
  id: string;
  profileId: string;
  kind: CuriosityKind;
  description: string;
  critical?: boolean;
  relatedEntity?: string;
  createdAt: string;
  dueAt?: string;
}

export interface LedgerFactInput {
  entity: string;
  type: FactType;
  fields: Record<string, string | number | string[]>;
  provenance: Provenance;
  safetyRelevant?: boolean;
  episodeId?: string;
  language?: string;
  verbatim?: string;
  replaces?: string;
  corrects?: string;
  text?: string;
}

/** Input for a narrative-only note: the lossless lane, no structured fact. */
export interface NarrativeNoteInput {
  text: string;
  language?: string;
  verbatim?: string;
  date?: string;
}

export interface MetricPointInput {
  entity: string;
  fields: Record<string, string | number | string[]>;
  date: string;
  provenance: Provenance;
  note?: string;
  language?: string;
  safetyRelevant?: boolean;
}

/** Input for a mistaken-entity correction: retract `wrong`, record `corrected`. */
export interface LedgerCorrectionInput {
  wrong: { entity: string; type: FactType };
  corrected: LedgerFactInput;
  /** Narrative line describing the correction. */
  note: string;
}

export type CaptureEvent =
  | { kind: 'ledger-fact'; payload: LedgerFactInput }
  | { kind: 'narrative-note'; payload: NarrativeNoteInput }
  | { kind: 'metric-point'; payload: MetricPointInput }
  | { kind: 'curiosity-item'; payload: Omit<CuriosityItem, 'id' | 'profileId' | 'createdAt'> }
  | { kind: 'ledger-correction'; payload: LedgerCorrectionInput };

export type PendingOp =
  | { kind: 'write'; entity: string; type: FactType; fields: Record<string, string | number | string[]>; provenance: Provenance; safetyRelevant?: boolean; episodeId?: string; language?: string; verbatim?: string; visibility?: string; resume?: boolean; /** Carried through confirm so a confirmed write stamps the reverse link. */ replaces?: string; corrects?: string; /** Verified at confirm to reject stale-token clobbers. */ baselineCurHash?: string }
  | { kind: 'retract'; entity: string; type: FactType; provenance: Provenance; baselineCurHash: string }
  | { kind: 'dispute'; entity: string; type: FactType; versionA: number; versionB: number; originalId: string }
  | { kind: 'discontinue'; entity: string; type: FactType; provenance: Provenance; reason?: string; replacedBy?: string; baselineCurHash: string }
  | { kind: 'restart'; entity: string; type: FactType; provenance: Provenance; fields: Record<string, string | number | string[]>; restartOf: string; baselineCurHash: string };

export type LedgerMutationResult =
  | { kind: 'applied'; fact: LedgerFact }
  | { kind: 'needs-confirmation'; fact: LedgerFact; token: ConfirmationToken }
  | { kind: 'noop'; reason: string };

export interface StoredToken {
  token: ConfirmationToken;
  op: PendingOp;
  used: boolean;
  confirmationContext?: ConfirmationContext;
}

export type RecordFactResult =
  | { kind: 'applied'; fact: LedgerFact; /** Set when a correction's companion retract needs user confirmation; the tool layer must relay it. */ pendingRetract?: ConfirmationToken }
  | { kind: 'needs-confirmation'; token: ConfirmationToken; current: LedgerFact; proposed: LedgerFact; /** CT: relayed correction-retract token (may accompany a pending corrected arm too). */ pendingRetract?: ConfirmationToken }
  | { kind: 'disputed'; versions: [LedgerFact, LedgerFact]; disputeToken: ConfirmationToken; /** CT: relayed correction-retract token. */ pendingRetract?: ConfirmationToken; /** An existing dispute offered again with a fresh token; nothing was written. */ reopened?: true };

export type RetractResult =
  | { kind: 'applied' | 'needs-confirmation'; fact: LedgerFact; token?: ConfirmationToken }
  | { kind: 'noop'; reason: string };

export const TYPE_TO_FILE: Record<FactType, string> = {
  medication: 'medications.md',
  condition: 'conditions.md',
  symptom: 'symptoms.md',
  appointment: 'appointments.md',
  metric: 'metrics.md',
  goal: 'goals.md',
  allergy: 'allergies.md',
};
