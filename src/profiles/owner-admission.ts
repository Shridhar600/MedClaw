// src/profiles/owner-admission.ts
//
// The enrollment state machine (plan 15 §2.3). One owner record, explicit phases, a bounded
// per-day allowance, and no silent path to a clinical turn.
//
// Two hard rules shape everything here:
//
//  1. **Configuration never grants a transport address.** Identity and paths come from config;
//     who may talk to this owner comes from the record's binding. They are separate authorities.
//  2. **A record that cannot be understood refuses.** Missing, unreadable, corrupt, wrong-owner
//     and bound-to-someone-else all refuse. None of them is "a fresh installation".
//
// No file access, no clock, no crypto and no config import lives here: those arrive as the
// `OwnerStatePort`, `PairingCodePort`, `Clock` and a plain `expectedOwnerId` string, which keeps
// this module inside the v2-core boundary (`.dependency-cruiser.cjs` rule `v2-core-boundary`).

import type { Clock } from '../ports/clock';
import {
  PAIRING_ATTEMPTS_PER_CHAT_PER_DAY,
  PAIRING_MAX_CANDIDATE_CHATS,
  PAIRING_MAX_EVENT_ID_LENGTH,
  PAIRING_MAX_EVENT_IDS_PER_CHAT,
  PAIRING_MAX_ID_LENGTH,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_SYMBOLS,
  PAIRING_CODE_EXPIRY_MS,
  type AdmissionDecision,
  type AdmissionReason,
  type OwnerBinding,
  type OwnerReadReason,
  type OwnerState,
  type OwnerStatePort,
  type PairingCandidateChat,
  type PairingCodePort,
  type PairingResult,
  type TransportIdentity,
} from '../ports/owner-state';
import { newUnpairedOwnerState, utcDayOf } from './owner-state';

// ── Canned copy ──────────────────────────────────────────────────────────────────────────
// Pairing is never a health answer, and none of these mention health state.

export const PAIRING_PROMPT_TEXT =
  'This is a private health assistant for one person. To connect your chat, send the ' +
  `${PAIRING_CODE_LENGTH}-character pairing code shown on the owner's own computer.`;

export const PAIRING_INVALID_TEXT =
  'That code is not correct. Send the pairing code shown on the owner\'s own computer.';

export const PAIRING_EXPIRED_TEXT =
  'That pairing code has expired. Generate a new one on the owner\'s own computer with ' +
  '`pairing issue`.';

export const PAIRING_LIMITED_TEXT = 'No further pairing attempts are available right now.';

export const PAIRING_COMPLETE_TEXT =
  'Pairing complete. This chat is now connected to the owner.';

export const PAIRING_REFUSED_TEXT =
  'This chat is not connected to this assistant. This is a private health assistant for one person.';

export const PAIRING_UNAVAILABLE_TEXT =
  'The owner record could not be read, so no request is being served. On the owner\'s computer, ' +
  're-run setup.';


const REFUSAL_TEXT: Record<AdmissionReason, string> = {
  unavailable: PAIRING_UNAVAILABLE_TEXT,
  'owner-mismatch': PAIRING_UNAVAILABLE_TEXT,
  'not-owner': PAIRING_REFUSED_TEXT,
  'non-private-chat': PAIRING_REFUSED_TEXT,
  'missing-transport-identity': PAIRING_REFUSED_TEXT,
  'already-bound': PAIRING_REFUSED_TEXT,
};

const READ_REASON_TO_ADMISSION: Record<OwnerReadReason, AdmissionReason> = {
  unreadable: 'unavailable',
  'too-large': 'unavailable',
  'invalid-document': 'unavailable',
  'owner-mismatch': 'owner-mismatch',
};

/** Text the Gateway should send for an admission decision. Exported so status/CLI agree. */
export function refusalTextFor(reason: AdmissionReason): string {
  return REFUSAL_TEXT[reason] ?? PAIRING_REFUSED_TEXT;
}

export interface PairingOutcomeEvent {
  result: PairingResult['kind'];
  chatType: TransportIdentity['chatType'] | 'unknown';
}

/**
 * Bounded, identifier-free outcome channel. One event per attempt, no identifiers, no code, no
 * exception payload — so a diagnostic can never become a pairing oracle.
 */
export interface OwnerAccessDiagnostics {
  recordPairingOutcome(outcome: PairingOutcomeEvent): void;
}

export interface OwnerAdmissionDeps {
  store: OwnerStatePort;
  codes: PairingCodePort;
  clock: Clock;
  /** The configured owner identity. Plain string: this module must not import the config layer. */
  expectedOwnerId: string;
  diagnostics: OwnerAccessDiagnostics;
  /** Optional for tests that must not print to stdout. */
  log?: (message: string) => void;
}

/**
 * Boot-time answer, with no inbound identity involved. A daemon needs this BEFORE it can decide
 * whether it may build anything at all.
 */
export type InstallationAdmission =
  | { kind: 'bound'; ownerId: string }
  /** Owner exists but is not paired yet: pairing and emergency only, no clinical runtime. */
  | { kind: 'unpaired' }
  | { kind: 'refused'; reason: AdmissionReason };

export type IssueChallengeResult =
  | { kind: 'issued'; plaintext: string; expiresAt: string }
  | { kind: 'refused'; reason: 'already-bound' | 'unavailable' | 'uncertain' };

// ── Transport identity validation ─────────────────────────────────────────────────────────

/** A code submission is only considered when it is exactly the trimmed, upcased alphabet form. */
function normalizeSubmission(text: string): string | undefined {
  const candidate = text.trim().toUpperCase();
  if (candidate.length !== PAIRING_CODE_LENGTH) return undefined;
  for (const symbol of candidate) {
    if (!PAIRING_CODE_SYMBOLS.includes(symbol)) return undefined;
  }
  return candidate;
}

export function isWellFormedSubmission(text: string): boolean {
  return normalizeSubmission(text) !== undefined;
}

function transportIdentityProblem(identity: TransportIdentity): AdmissionReason | undefined {
  const fields: [string, number][] = [
    [identity.channel, 64],
    [identity.chatId, PAIRING_MAX_ID_LENGTH],
    [identity.userId, PAIRING_MAX_ID_LENGTH],
    [identity.eventId, PAIRING_MAX_EVENT_ID_LENGTH],
  ];
  for (const [value, max] of fields) {
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
      return 'missing-transport-identity';
    }
  }
  return undefined;
}

function bindingMatches(identity: TransportIdentity, binding: OwnerBinding): boolean {
  return identity.channel === binding.channel
    && identity.chatId === binding.chatId
    && identity.userId === binding.senderId;
}

// ── The service ──────────────────────────────────────────────────────────────────────────

export class OwnerAdmissionService {
  /**
   * Serializes every mutation of the record. Supported cross-process writers are already
   * excluded by the owner workspace lease (plan 15 §2.2), so this only has to order this
   * process's own attempts — but it must do so *around the read that computes the reserve*,
   * or two concurrent attempts could each see allowance remaining.
   */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: OwnerAdmissionDeps) {}

  /**
   * Boot check. A missing, unreadable, corrupt or wrong-owner record refuses: the daemon must not
   * come up in a state where it would serve on a default identity.
   */
  inspectInstallation(): InstallationAdmission {
    const read = this.deps.store.read();
    if (read.kind === 'missing') return { kind: 'refused', reason: 'unavailable' };
    if (read.kind === 'unavailable') {
      return { kind: 'refused', reason: READ_REASON_TO_ADMISSION[read.reason] };
    }
    const state = read.state;
    if (state.ownerId !== this.deps.expectedOwnerId) {
      return { kind: 'refused', reason: 'owner-mismatch' };
    }
    return state.phase === 'bound'
      ? { kind: 'bound', ownerId: state.ownerId }
      : { kind: 'unpaired' };
  }

  /**
   * Fresh read, no mutation. Called for every inbound event and before every scheduled dispatch,
   * so a binding change takes effect without a restart.
   */
  inspect(identity: TransportIdentity): AdmissionDecision {
    const read = this.deps.store.read();
    if (read.kind === 'missing') {
      // No record is not a fresh installation: setup owns creating it.
      return { kind: 'refused', reason: 'unavailable' };
    }
    if (read.kind === 'unavailable') {
      return { kind: 'refused', reason: READ_REASON_TO_ADMISSION[read.reason] };
    }
    const state = read.state;
    if (state.ownerId !== this.deps.expectedOwnerId) {
      return { kind: 'refused', reason: 'owner-mismatch' };
    }

    const problem = transportIdentityProblem(identity);
    if (problem) return { kind: 'refused', reason: problem };

    if (state.phase === 'bound') {
      if (identity.chatType !== 'private') return { kind: 'refused', reason: 'non-private-chat' };
      return bindingMatches(identity, state.binding)
        ? { kind: 'owner', ownerId: state.ownerId }
        // A stranger arriving after binding gets only a generic refusal: never enrollment,
        // never reassignment.
        : { kind: 'refused', reason: 'already-bound' };
    }

    if (identity.chatType !== 'private') return { kind: 'refused', reason: 'non-private-chat' };
    // Unpaired but eligible: pairing and emergency guidance only. No clinical runtime.
    return { kind: 'pairing-only' };
  }

  /**
   * Whether this chat is the bound owner's addressable destination for SCHEDULED work.
   *
   * This is the authority the RR2-B1 destination guard must consult. It used to read
   * `ProfileRegistry.getProfileForChat`, but S1 made pairing the ONLY way to reach a profile, so nothing
   * ever paired the registry — the predicate returned `false` for the owner's own chat, and with
   * `heartbeat.enabled` defaulting to true the owner's entire reminder subsystem was inert in the shipped
   * daemon, silently. Jobs were still ARMED at boot for a destination that was then always refused.
   *
   * The invariant is unchanged and still fail-closed: a destination is authorized only by the CURRENT
   * binding, re-read at the moment of the check (never cached), and an unreadable, missing,
   * wrong-owner or not-yet-bound record authorizes nothing. `job.chatId` is a destination, never authority.
   *
   * `channel` is deliberately not compared. A scheduled job addresses a chat id, and the binding's channel
   * records how that chat was paired; requiring both would silently refuse a legitimate job if the binding
   * were ever re-paired on another transport.
   */
  ownsDestination(chatId: string): boolean {
    if (typeof chatId !== 'string' || chatId.length === 0) return false;
    const read = this.deps.store.read();
    if (read.kind !== 'available') return false;
    if (read.state.ownerId !== this.deps.expectedOwnerId) return false;
    if (read.state.phase !== 'bound') return false;
    return read.state.binding.chatId === chatId;
  }

  /**
   * True only when this exact inbound event is the one that established the current binding — i.e. a
   * genuine redelivery of the owner's pairing message.
   *
   * This exists because the owner-side "is this a re-delivered code?" shortcut used to match the pairing
   * *alphabet* alone. That alphabet is 32 symbols, so ordinary eight-letter health words qualify:
   * `headache`, `diabetes`, `insomnia`, `swelling`, `dizziness`, `vomiting`, `weakness`, `appetite`,
   * `coughing`. Each was answered "pairing complete" and silently dropped — never answered, never
   * recorded, never shown to the model. Requiring the recorded pairing event id means a redelivery is
   * still handled as pairing, and anything else from the owner is narrative.
   *
   * Fails closed: an unreadable record is not a pairing event.
   */
  isRedeliveredPairingEvent(identity: TransportIdentity): boolean {
    const read = this.deps.store.read();
    if (read.kind !== 'available') return false;
    if (read.state.phase !== 'bound') return false;
    return read.state.binding.pairingEventId === identity.eventId;
  }

  /**
   * Handle one pairing attempt. Serialized end to end, and the allowance is RESERVED before
   * verification so a crash mid-attempt cannot refund it.
   */
  async handlePairing(identity: TransportIdentity, text: string): Promise<PairingResult> {
    const run = this.tail.then(
      () => this.handlePairingLocked(identity, text),
      () => this.handlePairingLocked(identity, text),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async handlePairingLocked(identity: TransportIdentity, text: string): Promise<PairingResult> {
    const read = this.deps.store.read();

    if (read.kind === 'missing' || read.kind === 'unavailable') {
      return this.finish('unavailable', identity);
    }
    let state = read.state;
    if (state.ownerId !== this.deps.expectedOwnerId) {
      return this.finish('refused', identity);
    }

    if (state.phase === 'bound') {
      // Replay of the exact pairing event is idempotent and answers with pairing-complete.
      if (identity.eventId === state.binding.pairingEventId) {
        return this.finish('already-paired', identity);
      }
      return this.finish('refused', identity);
    }

    const problem = transportIdentityProblem(identity);
    if (problem || identity.chatType !== 'private') {
      // No allowance is spent for a request that is not a private pairing attempt.
      return this.finish('refused', identity);
    }

    const today = utcDayOf(this.deps.clock.now());
    const attempts = state.attempts.day === today
      ? { day: state.attempts.day, chats: state.attempts.chats.map((chat) => ({ ...chat, eventIds: [...chat.eventIds] })) }
      // Old-day rows expire; the allowance is keyed to the day, never carried forward.
      : { day: today, chats: [] };

    const candidate = attempts.chats.find((chat) => chat.chatId === identity.chatId);

    // A redelivered transport event is the same attempt, not a new one.
    if (candidate?.eventIds.includes(identity.eventId)) {
      // No reserve, no verification, no binding. The outcome class of the original attempt is
      // unknowable from the stored record, so answer with the neutral prompt rather than
      // guessing; a successful original has already bound and returned 'already-paired'.
      return this.finish('prompt', identity);
    }

    const isNewCandidate = candidate === undefined;
    if (isNewCandidate && attempts.chats.length >= PAIRING_MAX_CANDIDATE_CHATS) {
      // Saturation refuses rather than evicting, because eviction would reset live limits.
      return this.finish('limited', identity);
    }

    const allowanceLeft = (candidate?.attempts ?? 0) < PAIRING_ATTEMPTS_PER_CHAT_PER_DAY;
    if (!allowanceLeft) {
      // Fourth attempt: silent, even when the code is correct.
      return this.finish('limited', identity);
    }

    const now = this.deps.clock.now();
    const reserved: PairingCandidateChat = {
      chatId: identity.chatId,
      senderId: identity.userId,
      attempts: (candidate?.attempts ?? 0) + 1,
      eventIds: [...(candidate?.eventIds ?? []), identity.eventId].slice(-PAIRING_MAX_EVENT_IDS_PER_CHAT),
      firstSeenAt: candidate?.firstSeenAt ?? now.toISOString(),
      lastSeenAt: now.toISOString(),
    };
    if (candidate) {
      attempts.chats[attempts.chats.indexOf(candidate)] = reserved;
    } else {
      attempts.chats.push(reserved);
    }

    const submission = normalizeSubmission(text);
    const nextState: OwnerState = { ...state, phase: 'unpaired', attempts };

    // ── Reserve first, then verify ──────────────────────────────────────────────────────
    const committed = await this.replace(nextState);
    if (committed.kind !== 'committed') {
      return this.finish('unavailable', identity);
    }
    state = committed.state;

    if (submission === undefined) {
      // A well-formed private message that is not a code still consumes the allowance, so the
      // prompt channel cannot be used for free unlimited retries.
      return this.finish('prompt', identity);
    }

    const challenge = state.phase === 'unpaired' ? state.challenge : undefined;
    if (!challenge) {
      return this.finish('invalid', identity);
    }
    const expiry = new Date(challenge.expiresAt).getTime();
    if (!Number.isFinite(expiry) || this.deps.clock.now().getTime() >= expiry) {
      return this.finish('expired', identity);
    }
    if (!this.deps.codes.matches(submission, challenge.verifier)) {
      return this.finish('invalid', identity);
    }

    const bound: OwnerState = {
      version: 1,
      ownerId: state.ownerId,
      createdAt: state.createdAt,
      phase: 'bound',
      binding: {
        channel: identity.channel,
        chatId: identity.chatId,
        senderId: identity.userId,
        boundAt: this.deps.clock.now().toISOString(),
        pairingEventId: identity.eventId,
      },
    };

    const bindCommit = await this.replace(bound);
    if (bindCommit.kind === 'committed') {
      return this.finish('paired', identity, bound.ownerId);
    }
    if (bindCommit.kind === 'uncertain') {
      // The acknowledgement failed, but the replacement may have landed. Reload before
      // answering: never claim an outcome the record does not support, and never undo a
      // binding that did land.
      const reread = this.deps.store.read();
      if (
        reread.kind === 'available'
        && reread.state.phase === 'bound'
        && reread.state.binding.pairingEventId === identity.eventId
      ) {
        return this.finish('paired', identity, reread.state.ownerId);
      }
      return this.finish('unavailable', identity);
    }
    return this.finish('unavailable', identity);
  }

  /**
   * Issue (or reissue) a pairing challenge. Local writer only, unpaired only. The plaintext is
   * returned only after the record is committed, so a failed commit can never print a code that
   * was never stored.
   */
  async issueChallenge(): Promise<IssueChallengeResult> {
    const read = this.deps.store.read();
    if (read.kind === 'missing' || read.kind === 'unavailable') {
      return { kind: 'refused', reason: 'unavailable' };
    }
    const state = read.state;
    if (state.ownerId !== this.deps.expectedOwnerId) {
      return { kind: 'refused', reason: 'unavailable' };
    }
    if (state.phase === 'bound') {
      // Rebinding or removing an owner is not supported in S1.
      return { kind: 'refused', reason: 'already-bound' };
    }

    const issued = this.deps.codes.issue();
    const now = this.deps.clock.now();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_EXPIRY_MS).toISOString();
    const nextState: OwnerState = {
      ...state,
      phase: 'unpaired',
      challenge: { verifier: issued.verifier, issuedAt: now.toISOString(), expiresAt },
    };

    const committed = await this.replace(nextState);
    if (committed.kind === 'committed') {
      return { kind: 'issued', plaintext: issued.plaintext, expiresAt };
    }
    if (committed.kind === 'uncertain') {
      const reread = this.deps.store.read();
      if (
        reread.kind === 'available'
        && reread.state.phase === 'unpaired'
        && reread.state.challenge !== undefined
      ) {
        // The stored challenge exists but its plaintext is unrecoverable by design. Say so
        // rather than printing a code that does not match the record.
        return { kind: 'refused', reason: 'uncertain' };
      }
    }
    return { kind: 'refused', reason: 'uncertain' };
  }

  /** Create the initial unpaired record when none exists. Used by setup only. */
  async initialize(): Promise<'created' | 'exists' | 'unavailable'> {
    const read = this.deps.store.read();
    if (read.kind === 'available') return 'exists';
    if (read.kind === 'unavailable') return 'unavailable';
    await this.replace(newUnpairedOwnerState(this.deps.expectedOwnerId, this.deps.clock.now()));
    return 'created';
  }

  private async replace(
    next: OwnerState,
  ): Promise<
    | { kind: 'committed'; state: OwnerState }
    | { kind: 'failed' }
    | { kind: 'uncertain' }
  > {
    try {
      await this.deps.store.replace(next);
      return { kind: 'committed', state: next };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOSPC' || code === 'EIO') {
        // The write demonstrably did not happen.
        this.log(`[admission] owner record write refused (${code})`);
        return { kind: 'failed' };
      }
      // Anything else: we do not know whether it landed. The caller must reload.
      this.log('[admission] owner record write outcome uncertain');
      return { kind: 'uncertain' };
    }
  }

  private finish(kind: PairingResult['kind'], identity: TransportIdentity, boundOwnerId?: string): PairingResult {
    this.deps.diagnostics.recordPairingOutcome({
      result: kind,
      chatType: identity?.chatType ?? 'unknown',
    });
    return kind === 'paired' && boundOwnerId !== undefined
      ? { kind, boundOwnerId }
      : { kind };
  }

  private log(message: string): void {
    if (this.deps.log) this.deps.log(message);
  }
}
