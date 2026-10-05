// src/ports/owner-state.ts
//
// Interface-only enrollment records and IO seams (plan 15 §3). Nothing here imports an app
// module: `ownerId` is a plain string so this file stays inside the v2-core boundary and does
// not reach up into `src/profiles`.
//
// Policy (the state machine, the limits and the messages) lives in
// `src/profiles/owner-admission.ts`; raw-document validation lives in
// `src/profiles/owner-state.ts`. This file only declares the shapes and the fixed budgets that
// both sides must agree on.

// ── Fixed budgets (plan 15 §2.3). Owning-module constants, not configuration knobs. ────────

/** Pairing code alphabet: no I/O/1/0 ambiguity, no easily-confused glyphs. */
export const PAIRING_CODE_SYMBOLS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
/** A submitted code is exactly this many symbols from the alphabet above. */
export const PAIRING_CODE_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Shared byte budget for the persisted owner record.
 *
 * ONE number, declared here because policy, writer and reader must agree on it: a writer that may
 * publish more bytes than the reader will accept is how one owner's own pairing traffic made the app's
 * record unreadable after a restart (S1 C03/R11 — at the ordinary 256-candidate/three-attempt bounds a
 * real day of traffic encodes to about 100 KiB, which the previous 64 KiB reader refused as
 * `too-large`). Policy enforces it on the ENCODED write before publication, the reader enforces it on
 * the bytes actually read, and Plan 15 §2.3 caps it at 256 KiB.
 *
 * It is a ceiling, not a promise: worst-case legal escaping still exceeds it (256 KiB holds every
 * ASCII-legal record, not every pathological Unicode one). A record that cannot fit is refused before
 * publication, with the previous readable bytes untouched — never truncated into a shorter lie.
 */
export const OWNER_RECORD_MAX_BYTES = 256 * 1024;

/** Attempts allowed per private chat per UTC day. The fourth attempt is silent. */
export const PAIRING_ATTEMPTS_PER_CHAT_PER_DAY = 3;
/** Candidate chats retained for the current day before new candidates are refused. */
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

// ── Publication ──────────────────────────────────────────────────────────────────────────
//
// Publication truth belongs HERE, at the seam that owns the rename, not in policy. Policy used to
// guess it from an errno (`EACCES`/`EPERM`/`EROFS`/`ENOSPC`/`EIO` meant "definitely did not
// happen"), which is unsound in both directions: those same codes are raised AFTER a rename has
// landed, and any other code — including a lost acknowledgement — leaves the outcome unknown. Only
// the adapter knows which side of the rename it failed on.

/** Why a replacement was not confirmed published. A closed set: never an errno, message or path. */
export type OwnerWriteReason = 'too-large' | 'write-failed' | 'flush-failed';

export type OwnerStateWriteResult =
  /** The replacement is published and its required flush is confirmed. */
  | { status: 'committed' }
  /**
   * Published, or possibly published: a later step failed, so confirmation is incomplete. The NEW
   * bytes are the file's content and are readable. Never restore, delete or deny them, and never
   * claim the previous record is unchanged — reload authoritative state instead.
   */
  | { status: 'uncertain'; reason: OwnerWriteReason }
  /**
   * Not published, and known not to be. Existing bytes are unchanged and a missing record is still
   * missing. Cleanup owns only this attempt's unpublished temp file.
   */
  | { status: 'failed'; reason: OwnerWriteReason };

// ── Transport identity ────────────────────────────────────────────────────────────────────

/**
 * Who is speaking and which exact message this is. `eventId` must be stable across transport
 * redelivery (`telegram:<chatId>:<messageId>`) so a duplicate cannot spend a second attempt.
 */
export interface TransportIdentity {
  channel: string;
  chatId: string;
  userId: string;
  /**
   * The chat type the transport ASSERTED, or `undefined` when it asserted none.
   *
   * The key stays required so every producer must state the field explicitly, but `undefined` is a
   * representable value on purpose. It was previously impossible to represent absence here, which is
   * exactly why `transportIdentityOf` had to fabricate `'private'` for an omitted field — the single
   * chat type that grants owner health access. Plan 15 §3 also requires that "missing transport
   * identity is refused", which cannot hold while absence is unrepresentable.
   *
   * `undefined` is refused as `missing-transport-identity`, never treated as private.
   */
  chatType: 'private' | 'group' | 'supergroup' | 'channel' | 'local' | undefined;
  eventId: string;
}

// ── The owner record ─────────────────────────────────────────────────────────────────────

/** One private chat's allowance for the current UTC day. */
export interface PairingCandidateChat {
  chatId: string;
  senderId: string;
  /** Attempts already RESERVED (reserved before verification, so a crash cannot refund). */
  attempts: number;
  /** Event IDs already counted, oldest first, bounded by `PAIRING_MAX_EVENT_IDS_PER_CHAT`. */
  eventIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

/** The whole allowance for one UTC day. Replaced wholesale on day rollover. */
export interface PairingAttempts {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  chats: PairingCandidateChat[];
}

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
      attempts: PairingAttempts;
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
  /**
   * One atomic whole-record replacement (binding + challenge consumption together), reporting
   * whether it actually published. Implementations MUST refuse before touching the filesystem when
   * the encoded document exceeds `OWNER_RECORD_MAX_BYTES`.
   */
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