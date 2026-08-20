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
  // Cross-ENTITY links (distinct from same-entity supersedes/supersededBy).
  // replaces/replacedBy = clinical substitution (naproxen replaces ibuprofen, KNEE-04).
  // corrects/correctedBy = mistaken-entity correction (DAD-10, spec-09 field names).
  replaces?: string;
  replacedBy?: string;
  corrects?: string;
  correctedBy?: string;
  status: FactStatus;
  /** Set on a `discontinued` fact (spec-09 CONTRA-01 `reason` maps here). */
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

export type CuriosityKind = 'follow-up' | 'medication-reminder' | 'lab-correlation' | 'information-gap' | 'insight';

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

/**
 * Input for a NEW ledger fact captured during a turn. The store assigns id/version/
 * createdAt; the caller supplies the semantic content + provenance. Cross-entity link
 * ids (`replaces`/`corrects`) are the TARGET fact ids the caller resolved. `text` is the
 * human-readable narrative log line — omit it to log the entity name.
 */
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

/** Input for a narrative-only note (CHAT-06) — the lossless lane, no structured fact. */
export interface NarrativeNoteInput {
  text: string;
  language?: string;
  verbatim?: string;
  date?: string;
}

/**
 * Input for a metric reading (DIAB-02). Recorded as a `metric`-type ledger fact whose
 * `fields` always carry a `date` (F19) plus a narrative note.
 */
export interface MetricPointInput {
  entity: string;
  fields: Record<string, string | number | string[]>;
  date: string;
  provenance: Provenance;
  note?: string;
  language?: string;
  safetyRelevant?: boolean;
}

/** Input for a mistaken-entity correction (DAD-10): retract `wrong`, record `corrected`. */
export interface LedgerCorrectionInput {
  wrong: { entity: string; type: FactType };
  corrected: LedgerFactInput;
  /** Narrative line describing the correction. */
  note: string;
}

interface CaptureEventBase {
  profileId: string;
  source: string;
}

/**
 * A normalized inbound capture event, discriminated by `kind`. Each payload is an
 * INPUT shape (not a stored record) — the pipeline resolves ids/anchors when it writes.
 */
export type CaptureEvent =
  | (CaptureEventBase & { kind: 'ledger-fact'; payload: LedgerFactInput })
  | (CaptureEventBase & { kind: 'narrative-note'; payload: NarrativeNoteInput })
  | (CaptureEventBase & { kind: 'metric-point'; payload: MetricPointInput })
  | (CaptureEventBase & { kind: 'curiosity-item'; payload: Omit<CuriosityItem, 'id' | 'profileId' | 'createdAt'> })
  | (CaptureEventBase & { kind: 'ledger-correction'; payload: LedgerCorrectionInput });

export type PendingOp =
  | { kind: 'write'; entity: string; type: FactType; fields: Record<string, string | number | string[]>; provenance: Provenance; safetyRelevant?: boolean; episodeId?: string; language?: string; verbatim?: string; visibility?: string; resume?: boolean }
  | { kind: 'retract'; entity: string; type: FactType; provenance: Provenance }
  | { kind: 'dispute'; entity: string; type: FactType; versionA: number; versionB: number }
  | { kind: 'discontinue'; entity: string; type: FactType; provenance: Provenance; reason?: string; replacedBy?: string }
  | { kind: 'restart'; entity: string; type: FactType; provenance: Provenance; fields: Record<string, string | number | string[]>; restartOf: string };

/**
 * Result of a lifecycle mutation (discontinue / restart / pause). `noop` is an
 * idempotent no-change outcome (e.g. discontinue with no active version), so the
 * tool layer can report it without a null-fact sentinel.
 */
export type LedgerMutationResult =
  | { kind: 'applied'; fact: LedgerFact }
  | { kind: 'needs-confirmation'; fact: LedgerFact; token: ConfirmationToken }
  | { kind: 'noop'; reason: string };

export interface StoredToken {
  token: ConfirmationToken;
  op: PendingOp;
  used: boolean;
}

export type RecordFactResult =
  | { kind: 'applied'; fact: LedgerFact }
  | { kind: 'needs-confirmation'; token: ConfirmationToken; current: LedgerFact; proposed: LedgerFact }
  | { kind: 'disputed'; versions: [LedgerFact, LedgerFact]; disputeToken: ConfirmationToken };

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
