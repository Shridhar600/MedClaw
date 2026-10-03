// src/profiles/owner-state.ts
//
// Pure validation of the raw owner-record document (plan 15 §3: adapters validate raw storage
// through this public decoder, never by importing an internal file).
//
// This module is deliberately total and closed: an unknown document shape, an unknown key, a
// missing/blank phase or a budget overrun is `invalid`, never "a fresh installation". A record
// that cannot be understood refuses serving; it never re-opens first-contact pairing.

import {
  PAIRING_ATTEMPTS_PER_CHAT_PER_DAY,
  PAIRING_MAX_CANDIDATE_CHATS,
  PAIRING_MAX_EVENT_ID_LENGTH,
  PAIRING_MAX_EVENT_IDS_PER_CHAT,
  PAIRING_MAX_ID_LENGTH,
  type OwnerBinding,
  type OwnerChallenge,
  type OwnerState,
  type PairingAttempts,
  type PairingCandidateChat,
} from '../ports/owner-state';
import { isValidProfileId } from './paths';

export type OwnerStateDecode =
  | { kind: 'ok'; state: OwnerState }
  /** Well-formed record that belongs to a different owner than the configured one. */
  | { kind: 'owner-mismatch' }
  | { kind: 'invalid' };

const OWNER_STATE_KEYS = ['version', 'ownerId', 'createdAt', 'phase', 'challenge', 'attempts', 'binding'] as const;
const CHALLENGE_KEYS = ['verifier', 'issuedAt', 'expiresAt'] as const;
const BINDING_KEYS = ['channel', 'chatId', 'senderId', 'boundAt', 'pairingEventId'] as const;
const ATTEMPTS_KEYS = ['day', 'chats'] as const;
const CANDIDATE_KEYS = ['chatId', 'senderId', 'attempts', 'eventIds', 'firstSeenAt', 'lastSeenAt'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A closed record: every key present must be one we declare, and nothing else may appear. */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(new Date(value).getTime());
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PAIRING_MAX_ID_LENGTH;
}

/** `YYYY-MM-DD` in UTC. The allowance is keyed on this and nothing else. */
const UTC_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function utcDayOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

function decodeChallenge(raw: unknown): OwnerChallenge | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, CHALLENGE_KEYS)) return undefined;
  if (typeof raw.verifier !== 'string' || raw.verifier.length === 0) return undefined;
  if (!isIsoTimestamp(raw.issuedAt) || !isIsoTimestamp(raw.expiresAt)) return undefined;
  return {
    verifier: raw.verifier,
    issuedAt: raw.issuedAt,
    expiresAt: raw.expiresAt,
  };
}

function decodeCandidate(raw: unknown): PairingCandidateChat | undefined {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, CANDIDATE_KEYS)) return undefined;
  if (!isBoundedId(raw.chatId) || !isBoundedId(raw.senderId)) return undefined;
  if (
    typeof raw.attempts !== 'number'
    || !Number.isInteger(raw.attempts)
    || raw.attempts < 0
    || raw.attempts > PAIRING_ATTEMPTS_PER_CHAT_PER_DAY
  ) {
    return undefined;
  }
  if (!Array.isArray(raw.eventIds)) return undefined;
  if (raw.eventIds.length > PAIRING_MAX_EVENT_IDS_PER_CHAT) return undefined;
  for (const eventId of raw.eventIds) {
    if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > PAIRING_MAX_EVENT_ID_LENGTH) {
      return undefined;
    }
  }
  if (!isIsoTimestamp(raw.firstSeenAt) || !isIsoTimestamp(raw.lastSeenAt)) return undefined;
  return {
    chatId: raw.chatId,
    senderId: raw.senderId,
    attempts: raw.attempts,
    eventIds: [...raw.eventIds] as string[],
    firstSeenAt: raw.firstSeenAt,
    lastSeenAt: raw.lastSeenAt,
  };
}

function decodeAttempts(raw: unknown): PairingAttempts | undefined {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ATTEMPTS_KEYS)) return undefined;
  if (typeof raw.day !== 'string' || !UTC_DAY_PATTERN.test(raw.day)) return undefined;
  if (!Array.isArray(raw.chats)) return undefined;
  if (raw.chats.length > PAIRING_MAX_CANDIDATE_CHATS) return undefined;
  const chats: PairingCandidateChat[] = [];
  const seen = new Set<string>();
  for (const entry of raw.chats) {
    const candidate = decodeCandidate(entry);
    if (!candidate) return undefined;
    // A duplicate chat row would let one chat hold more than its allowance.
    if (seen.has(candidate.chatId)) return undefined;
    seen.add(candidate.chatId);
    chats.push(candidate);
  }
  return { day: raw.day, chats };
}

function decodeBinding(raw: unknown): OwnerBinding | undefined {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, BINDING_KEYS)) return undefined;
  if (typeof raw.channel !== 'string' || raw.channel.length === 0) return undefined;
  if (!isBoundedId(raw.chatId) || !isBoundedId(raw.senderId)) return undefined;
  if (!isIsoTimestamp(raw.boundAt)) return undefined;
  if (typeof raw.pairingEventId !== 'string' || raw.pairingEventId.length === 0) return undefined;
  if (raw.pairingEventId.length > PAIRING_MAX_EVENT_ID_LENGTH) return undefined;
  return {
    channel: raw.channel,
    chatId: raw.chatId,
    senderId: raw.senderId,
    boundAt: raw.boundAt,
    pairingEventId: raw.pairingEventId,
  };
}

/**
 * Validate one raw document against the configured owner identity.
 *
 * `expectedOwnerId` is a plain string, not a `ProfileId`, because this module never needs the
 * brand — the config layer is not reachable from here. Comparison is exact: a record for another
 * owner is a refusal (`owner-mismatch`), never a silent adoption.
 */
export function decodeOwnerState(input: unknown, expectedOwnerId: string): OwnerStateDecode {
  if (!isPlainObject(input)) return { kind: 'invalid' };
  if (!hasOnlyKeys(input, OWNER_STATE_KEYS)) return { kind: 'invalid' };
  if (input.version !== 1) return { kind: 'invalid' };
  if (typeof input.ownerId !== 'string' || !isValidProfileId(input.ownerId)) return { kind: 'invalid' };
  if (!isIsoTimestamp(input.createdAt)) return { kind: 'invalid' };

  // Identity is checked before shape so a wrong-owner record reports the accurate reason even
  // when the rest of the document is also malformed.
  if (input.ownerId !== expectedOwnerId) return { kind: 'owner-mismatch' };

  const base = { version: 1 as const, ownerId: input.ownerId, createdAt: input.createdAt };

  if (input.phase === 'unpaired') {
    if (input.binding !== undefined) return { kind: 'invalid' };
    const challenge = decodeChallenge(input.challenge);
    if (challenge === undefined && input.challenge !== undefined) return { kind: 'invalid' };
    const attempts = decodeAttempts(input.attempts);
    if (!attempts) return { kind: 'invalid' };
    return {
      kind: 'ok',
      state: { ...base, phase: 'unpaired', ...(challenge ? { challenge } : {}), attempts },
    };
  }

  if (input.phase === 'bound') {
    if (input.challenge !== undefined || input.attempts !== undefined) return { kind: 'invalid' };
    const binding = decodeBinding(input.binding);
    if (!binding) return { kind: 'invalid' };
    return { kind: 'ok', state: { ...base, phase: 'bound', binding } };
  }

  // Missing, blank or unrecognised phase is NOT a fresh installation.
  return { kind: 'invalid' };
}

/** Serialize for the atomic whole-record replacement. Deterministic key order. */
export function encodeOwnerState(state: OwnerState): string {
  if (state.phase === 'bound') {
    return `${JSON.stringify(
      {
        version: state.version,
        ownerId: state.ownerId,
        createdAt: state.createdAt,
        phase: state.phase,
        binding: state.binding,
      },
      null,
      2,
    )}\n`;
  }
  return `${JSON.stringify(
    {
      version: state.version,
      ownerId: state.ownerId,
      createdAt: state.createdAt,
      phase: state.phase,
      ...(state.challenge ? { challenge: state.challenge } : {}),
      attempts: state.attempts,
    },
    null,
    2,
  )}\n`;
}

/** A brand-new unpaired record. The only way a record legitimately starts. */
export function newUnpairedOwnerState(ownerId: string, createdAt: Date): OwnerState {
  return {
    version: 1,
    ownerId,
    createdAt: createdAt.toISOString(),
    phase: 'unpaired',
    attempts: { day: utcDayOf(createdAt), chats: [] },
  };
}