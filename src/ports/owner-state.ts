
// ── Fixed budgets. Owning-module constants, not configuration knobs. ───────────────────────

/** Pairing code alphabet: no I/O/1/0 ambiguity, no easily-confused glyphs. */
export const PAIRING_CODE_SYMBOLS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
/** A submitted code is exactly this many symbols from the alphabet above. */
export const PAIRING_CODE_EXPIRY_MS = 60 * 60 * 1000;

/** Byte budget for the persisted owner record, shared by the writer and the reader. */
export const OWNER_RECORD_MAX_BYTES = 64 * 1024;

/** Attempts allowed per private chat per UTC day. The fourth attempt is silent. */
export const PAIRING_ATTEMPTS_PER_CHAT_PER_DAY = 3;
/** Candidate chats tracked for the current day before new candidates are refused. */
export const PAIRING_MAX_CANDIDATE_CHATS = 256;
/** Transport event IDs remembered per candidate chat, so a redelivered event costs no attempt. */
export const PAIRING_MAX_EVENT_IDS_PER_CHAT = 3;
export const PAIRING_MAX_EVENT_ID_LENGTH = 128;
/** Chat and sender identifiers are bounded before they are ever persisted. */
export const PAIRING_MAX_ID_LENGTH = 32;

/** Refusal reasons that the admission policy may return. No free-form strings. */
export type AdmissionReason =
  /** Record unavailable (unreadable/oversized/invalid): refuse serving, never fall back. */
  | 'unavailable'
  /** Record belongs to a different owner than the configured one. */
  | 'owner-mismatch'
  /** Not the bound private chat. */
  | 'not-owner'
  /** Group/supergroup/channel traffic never gains health state. */
  | 'non-private-chat'
  /** Required transport identity is absent or malformed. */
  | 'missing-transport-identity'
  /** Bound already; strangers get only a generic refusal, never enrollment. */
  | 'already-bound';

/** Why an owner record could not be read. Never an exception payload and never a path. */
export type OwnerReadReason = 'unreadable' | 'too-large' | 'invalid-document' | 'owner-mismatch';

/** Why a replacement was not confirmed published. A closed set: never an errno, message or path. */
export type OwnerWriteReason = 'too-large' | 'write-failed' | 'flush-failed';

export type OwnerStateWriteResult =
  /** The replacement is published and its required flush is confirmed. */
  | { status: 'committed' }
  | { status: 'uncertain'; reason: OwnerWriteReason }
  | { status: 'failed'; reason: OwnerWriteReason };

// ── Transport identity ────────────────────────────────────────────────────────────────────

export interface TransportIdentity {
  channel: string;
  chatId: string;
  userId: string;
  chatType: 'private' | 'group' | 'supergroup' | 'channel' | 'local' | undefined;
  eventId: string;
}

// ── The owner record ─────────────────────────────────────────────────────────────────────

/** An issued, not-yet-consumed or already-consumed challenge. The plaintext is never stored. */
export interface OwnerChallenge {
  /** Opaque salted SHA-256 verifier. Never the plaintext. */
  verifier: string;
  issuedAt: string;
  expiresAt: string;
}

/** Who the owner is bound to. Separate from configuration, which never grants an address. */
export interface OwnerBinding {
  channel: string;
  chatId: string;
  senderId: string;
  boundAt: string;
  /** The transport event that completed pairing. Replay of this exact event is idempotent. */
  pairingEventId: string;
}

interface OwnerRecordBase {
  version: 1;
  /** Must equal the configured owner identity on every read. */
  ownerId: string;
  createdAt: string;
}

/** The closed union. There is no third phase and no "missing phase means fresh install". */
export type OwnerState =
  | (OwnerRecordBase & {
      phase: 'unpaired';
      challenge?: OwnerChallenge;
    })
  | (OwnerRecordBase & {
      phase: 'bound';
      binding: OwnerBinding;
    });

export function isBoundOwnerState(state: OwnerState): state is Extract<OwnerState, { phase: 'bound' }> {
  return state.phase === 'bound';
}

export function isUnpairedOwnerState(state: OwnerState): state is Extract<OwnerState, { phase: 'unpaired' }> {
  return state.phase === 'unpaired';
}

// ── IO seams ─────────────────────────────────────────────────────────────────────────────

export type OwnerStateRead =
  | { kind: 'available'; state: OwnerState }
  | { kind: 'missing' }
  | { kind: 'unavailable'; reason: OwnerReadReason };

export interface OwnerStatePort {
  /** Fresh read every call. No mtime cache, no quarantine-to-empty. */
  read(): OwnerStateRead;
  /** MUST refuse before touching the filesystem when the encoded document exceeds `OWNER_RECORD_MAX_BYTES`. */
  replace(next: OwnerState): Promise<OwnerStateWriteResult>;
}

export interface PairingCodePort {
  /** Returns the plaintext for local display AFTER commit, and the verifier to store. */
  issue(): { plaintext: string; verifier: string };
  /** Constant-time comparison against the stored verifier. */
  matches(submission: string, verifier: string): boolean;
}

// ── Decisions ────────────────────────────────────────────────────────────────────────────

export type AdmissionDecision =
  | { kind: 'owner'; ownerId: string }
  /** Unpaired but eligible to try pairing: pairing/emergency only, no clinical runtime. */
  | { kind: 'pairing-only' }
  | { kind: 'refused'; reason: AdmissionReason };

/** No health payload, no exception detail, no code echo. */
export type PairingResultKind =
  | 'paired'
  | 'already-paired'
  | 'prompt'
  | 'invalid'
  | 'expired'
  | 'limited'
  | 'refused'
  | 'unavailable';

export interface PairingResult {
  kind: PairingResultKind;
  /** Present only on `paired`, for local/diagnostic use. Never sent to a stranger. */
  boundOwnerId?: string;
}
