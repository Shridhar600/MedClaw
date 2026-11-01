// src/profiles/owner-admission.ts
//
// The enrollment state machine. One owner record, explicit phases, an in-memory per-chat daily
// pairing allowance, and no silent path to a clinical turn.
//
// Two rules shape everything here:
//
//  1. Configuration never grants a transport address. Identity and paths come from config;
//     who may talk to this owner comes from the record's binding.
//  2. A record that cannot be understood refuses. Missing, unreadable, corrupt, wrong-owner
//     and bound-to-someone-else all refuse. None of them is "a fresh installation".
//
// No file access, clock, crypto or config import lives here: those arrive as the `OwnerStatePort`,
// `PairingCodePort`, `Clock` and a plain `expectedOwnerId` string (see the `v2-core-boundary` rule).

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
  type OwnerWriteReason,
  type OwnerState,
  type OwnerStatePort,
  type PairingCodePort,
  type PairingResult,
  type TransportIdentity,
} from '../ports/owner-state';
import type { DiagnosticEvent, DiagnosticSink, PairingDiagnosticReason } from '../ports/diagnostics';
import { SILENT_DIAGNOSTIC_SINK, guardedDiagnosticSink } from '../ports/diagnostics';
import { newUnpairedOwnerState, utcDayOf } from './owner-state';

/** One candidate chat's pairing allowance for the current UTC day. */
interface CandidateAttempts {
  attempts: number;
  /** Event IDs already counted, so a redelivered event costs no attempt. */
  eventIds: string[];
}

/** What a pairing attempt produced: the user-facing result plus the diagnostic-only cause. */
interface PairingOutcome {
  result: PairingResult;
  reason: PairingDiagnosticReason;
}

/** Outcomes that are progress rather than refusal, so they carry no reason. */
function isProgressOutcome(kind: PairingResult['kind']): kind is 'paired' | 'already-paired' | 'prompt' {
  return kind === 'paired' || kind === 'already-paired' || kind === 'prompt';
}

// Canned copy. Pairing is never a health answer, and none of these mention health state.

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

export interface OwnerAdmissionDeps {
  store: OwnerStatePort;
  codes: PairingCodePort;
  clock: Clock;
  /** The configured owner identity. Plain string: this module must not import the config layer. */
  expectedOwnerId: string;
  /** Diagnostic sink. Optional; the default is silence, never a stdout print. */
  diagnostics?: DiagnosticSink;
  /** Optional for tests that must not print to stdout. */
  log?: (message: string) => void;
}

/** Boot-time answer, with no inbound identity. The daemon needs it before it builds anything. */
export type InstallationAdmission =
  | { kind: 'bound'; ownerId: string }
  /** Owner exists but is not paired yet: pairing and emergency only, no clinical runtime. */
  | { kind: 'unpaired' }
  | { kind: 'refused'; reason: AdmissionReason };

export type IssueChallengeResult =
  | { kind: 'issued'; plaintext: string; expiresAt: string }
  /**
   * `writeReason` is present only when the record could be read and the replacement was refused
   * before publication. `unavailable` means the record could not be read: a different fault.
   */
  | {
      kind: 'refused';
      reason: 'already-bound' | 'unavailable' | 'uncertain';
      writeReason?: OwnerWriteReason;
    };

/**
 * What `initialize()` achieved.
 *
 * - `created`: published and confirmed.
 * - `exists`: a readable record was already there, so nothing was written.
 * - `unavailable`: an existing record could not be read. Setup must refuse rather than repair it.
 * - `refused`: nothing was published and nothing pre-existed.
 * - `uncertain`: it may be published, with confirmation incomplete.
 */
export type InitializeResult = 'created' | 'exists' | 'unavailable' | 'refused' | 'uncertain';

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
  // A missing chatType is refused, never upgraded to a private chat.
  if (identity.chatType === undefined) return 'missing-transport-identity';

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

export class OwnerAdmissionService {
  /**
   * Serializes every mutation of the record. The owner workspace lease already excludes other
   * processes, so this only orders this process's attempts. It must cover the read that computes
   * the allowance, or two concurrent attempts could each see allowance remaining.
   */
  private tail: Promise<unknown> = Promise.resolve();

  /** Today's pairing allowance per candidate chat. In memory on purpose: a restart resets it. */
  private allowanceDay = '';
  private readonly allowance = new Map<string, CandidateAttempts>();

  /** Every event goes through this sink, guarded once at construction so it cannot throw into a decision. */
  private readonly sink: DiagnosticSink;

  constructor(private readonly deps: OwnerAdmissionDeps) {
    this.sink = guardedDiagnosticSink(deps.diagnostics ?? SILENT_DIAGNOSTIC_SINK);
  }

  /**
   * Boot check. A missing, unreadable, corrupt or wrong-owner record refuses: the daemon must not
   * come up in a state where it would serve on a default identity.
   */
  inspectInstallation(): InstallationAdmission {
    const startedAt = this.deps.clock.now().getTime();
    const decision = this.readInstallation();
    this.emit(this.installationEvent(decision, startedAt));
    return decision;
  }

  /** The boot answer itself, without the diagnostic. Split out so the emit has exactly one exit. */
  private readInstallation(): InstallationAdmission {
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
    const startedAt = this.deps.clock.now().getTime();
    const decision = this.decide(identity);
    this.emit(this.admissionEvent(decision, startedAt));
    return decision;
  }

  /**
   * The admission decision itself, with no diagnostic side effect. Reporting happens in one place
   * (`inspect`), so a new early return cannot skip its diagnostic.
   */
  private decide(identity: TransportIdentity): AdmissionDecision {
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
   * Whether this chat is the bound owner's addressable destination for scheduled work.
   *
   * Fail-closed: only the current binding authorizes a destination, re-read at the moment of the
   * check (never cached). An unreadable, missing, wrong-owner or not-yet-bound record authorizes
   * nothing. `channel` is deliberately not compared: a job addresses a chat id.
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
   * True only when this exact inbound event is the one that established the current binding, i.e. a
   * genuine redelivery of the owner's pairing message.
   *
   * Matching the event id, not the code alphabet, matters: ordinary eight-letter health words
   * (`headache`, `diabetes`) fit the alphabet and must reach the model as narrative.
   * Fails closed: an unreadable record is not a pairing event.
   */
  isRedeliveredPairingEvent(identity: TransportIdentity): boolean {
    const read = this.deps.store.read();
    if (read.kind !== 'available') return false;
    if (read.state.phase !== 'bound') return false;
    return read.state.binding.pairingEventId === identity.eventId;
  }

  /** Handle one pairing attempt. Serialized end to end; the attempt is counted before verification. */
  async handlePairing(identity: TransportIdentity, text: string): Promise<PairingResult> {
    const startedAt = this.deps.clock.now().getTime();
    const { result, reason } = await this.pair(identity, text);
    // Only `kind` and the reason are emitted. A chat id or owner id in a log line would disclose it.
    this.emit(this.pairingEvent(result.kind, reason, startedAt));
    return result;
  }

  /** The pairing state machine itself. `handlePairing` reports its outcome from one place. */
  private async pair(
    identity: TransportIdentity,
    text: string,
  ): Promise<PairingOutcome> {
    const run = this.tail.then(
      () => this.handlePairingLocked(identity, text),
      () => this.handlePairingLocked(identity, text),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async handlePairingLocked(identity: TransportIdentity, text: string): Promise<PairingOutcome> {
    const read = this.deps.store.read();

    if (read.kind === 'missing' || read.kind === 'unavailable') {
      return this.finish('unavailable', identity, undefined, 'record-unavailable');
    }
    const state = read.state;
    if (state.ownerId !== this.deps.expectedOwnerId) {
      return this.finish('refused', identity, undefined, 'owner-mismatch');
    }

    if (state.phase === 'bound') {
      // Replay of the exact pairing event is idempotent and answers with pairing-complete.
      if (identity.eventId === state.binding.pairingEventId) {
        return this.finish('already-paired', identity);
      }
      return this.finish('refused', identity, undefined, 'already-bound');
    }

    const problem = transportIdentityProblem(identity);
    if (problem || identity.chatType !== 'private') {
      // No allowance is spent for a request that is not a private pairing attempt.
      return this.finish('refused', identity, undefined, 'not-a-private-pairing-identity');
    }

    const today = utcDayOf(this.deps.clock.now());
    if (this.allowanceDay !== today) {
      this.allowanceDay = today;
      this.allowance.clear();
    }
    const candidate = this.allowance.get(identity.chatId);

    if ((candidate?.attempts ?? 0) >= PAIRING_ATTEMPTS_PER_CHAT_PER_DAY) {
      // Spent allowance also silences failed-event replay; replay cannot reopen the prompt channel.
      return this.finish('limited', identity, undefined, 'daily-allowance-spent');
    }
    // A redelivered transport event is the same attempt, not a new one.
    if (candidate?.eventIds.includes(identity.eventId)) return this.finish('prompt', identity);
    if (!candidate && this.allowance.size >= PAIRING_MAX_CANDIDATE_CHATS) {
      // Bounded so strangers cannot grow it; this new chat has spent no attempts.
      return this.finish('refused', identity, undefined, 'candidate-capacity-reached');
    }
    this.allowance.set(identity.chatId, {
      attempts: (candidate?.attempts ?? 0) + 1,
      eventIds: [...(candidate?.eventIds ?? []), identity.eventId].slice(-PAIRING_MAX_EVENT_IDS_PER_CHAT),
    });

    const submission = normalizeSubmission(text);
    if (submission === undefined) {
      // A message that is not a code still counts, so the prompt channel is not free to retry.
      return this.finish('prompt', identity);
    }

    const challenge = state.phase === 'unpaired' ? state.challenge : undefined;
    if (!challenge) {
      return this.finish('invalid', identity, undefined, 'code-mismatch');
    }
    const expiry = new Date(challenge.expiresAt).getTime();
    if (!Number.isFinite(expiry) || this.deps.clock.now().getTime() >= expiry) {
      return this.finish('expired', identity, undefined, 'code-expired');
    }
    if (!this.deps.codes.matches(submission, challenge.verifier)) {
      return this.finish('invalid', identity, undefined, 'code-mismatch');
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
      return this.finish('unavailable', identity, undefined, 'record-unavailable');
    }
    return this.finish('unavailable', identity, undefined, 'record-unavailable');
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
      // Rebinding or removing an owner is not supported.
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
    if (committed.kind === 'failed') {
      // Nothing was published, so the record still holds the previous code. This is `unavailable`,
      // not `uncertain`. The specific cause travels as `writeReason`.
      return { kind: 'refused', reason: 'unavailable', writeReason: committed.reason };
    }
    // The stored challenge may exist but its plaintext is unrecoverable by design. Reissue for a usable code.
    return { kind: 'refused', reason: 'uncertain' };
  }

  /**
   * Create the initial unpaired record when none exists. Used by setup only.
   * `created` is reported only for a confirmed publication; every other outcome is propagated.
   */
  async initialize(): Promise<InitializeResult> {
    const read = this.deps.store.read();
    if (read.kind === 'available') return 'exists';
    if (read.kind === 'unavailable') return 'unavailable';
    const published = await this.replace(newUnpairedOwnerState(this.deps.expectedOwnerId, this.deps.clock.now()));
    if (published.kind === 'committed') return 'created';
    if (published.kind === 'uncertain') return 'uncertain';
    return 'refused';
  }

  /**
   * Publish a whole record and reduce the port's typed result to what policy needs.
   * The port states which side of the rename failed. A throw is mapped to `uncertain`.
   */
  private async replace(
    next: OwnerState,
  ): Promise<
    | { kind: 'committed'; state: OwnerState }
    | { kind: 'failed'; reason: OwnerWriteReason }
    | { kind: 'uncertain' }
  > {
    try {
      const outcome = await this.deps.store.replace(next);
      if (outcome.status === 'committed') return { kind: 'committed', state: next };
      if (outcome.status === 'failed') {
        this.log(`[admission] owner record write refused (${outcome.reason})`);
        return { kind: 'failed', reason: outcome.reason };
      }
      this.log(`[admission] owner record write unconfirmed (${outcome.reason})`);
      return { kind: 'uncertain' };
    } catch {
      this.log('[admission] owner record write outcome uncertain');
      return { kind: 'uncertain' };
    }
  }

  /**
   * Build a pairing result. `reason` says why a non-progress outcome failed; every refusal branch
   * passes it explicitly. The default exists only for progress branches.
   */
  private finish(
    kind: PairingResult['kind'],
    identity: TransportIdentity,
    boundOwnerId?: string,
    reason: PairingDiagnosticReason = 'record-unavailable',
  ): PairingOutcome {
    this.log(`[admission] pairing outcome ${kind}${isProgressOutcome(kind) ? '' : ` (${reason})`}`);
    const result: PairingResult = kind === 'paired' && boundOwnerId !== undefined
      ? { kind, boundOwnerId }
      : { kind };
    return { result, reason };
  }

  /** Narrow a pairing outcome into its exact event variant. */
  private pairingEvent(
    kind: PairingResult['kind'],
    reason: PairingDiagnosticReason,
    startedAt: number,
  ): DiagnosticEvent {
    const durationMs = this.elapsedSince(startedAt);
    if (isProgressOutcome(kind)) return { stage: 'pairing', outcome: kind, durationMs };
    // `daily-allowance-spent` is the only refusal where the spent count is the interesting fact.
    return reason === 'daily-allowance-spent'
      ? { stage: 'pairing', outcome: kind, reason, attempts: PAIRING_ATTEMPTS_PER_CHAT_PER_DAY, durationMs }
      : { stage: 'pairing', outcome: kind, reason, durationMs };
  }

  /**
   * Emit through the guarded sink. It runs inside the admission decision, so a throwing adapter
   * must not be reachable from a stranger's message.
   */
  private emit(event: DiagnosticEvent): void {
    this.sink.emit(event);
  }

  /** Narrow an inbound-message decision into its exact event variant. */
  private admissionEvent(decision: AdmissionDecision, startedAt: number): DiagnosticEvent {
    const durationMs = this.elapsedSince(startedAt);
    if (decision.kind === 'owner') return { stage: 'owner-admission', outcome: 'admitted', durationMs };
    if (decision.kind === 'pairing-only') {
      return { stage: 'owner-admission', outcome: 'pairing-only', durationMs };
    }
    return { stage: 'owner-admission', outcome: 'refused', reason: decision.reason, durationMs };
  }

  /** Narrow a boot-time answer into its exact event variant. */
  private installationEvent(decision: InstallationAdmission, startedAt: number): DiagnosticEvent {
    const durationMs = this.elapsedSince(startedAt);
    if (decision.kind === 'bound') return { stage: 'owner-admission', outcome: 'admitted', durationMs };
    if (decision.kind === 'unpaired') return { stage: 'owner-admission', outcome: 'pairing-only', durationMs };
    return { stage: 'owner-admission', outcome: 'refused', reason: decision.reason, durationMs };
  }

  private elapsedSince(startedAt: number): number {
    const elapsed = this.deps.clock.now().getTime() - startedAt;
    return elapsed > 0 ? elapsed : 0;
  }

  private log(message: string): void {
    if (this.deps.log) this.deps.log(message);
  }
}
