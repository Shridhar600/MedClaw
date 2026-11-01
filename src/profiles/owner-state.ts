
import {
  PAIRING_MAX_EVENT_ID_LENGTH,
  PAIRING_MAX_ID_LENGTH,
  type OwnerBinding,
  type OwnerChallenge,
  type OwnerState,
} from '../ports/owner-state';
import { isValidProfileId } from './paths';

export type OwnerStateDecode =
  | { kind: 'ok'; state: OwnerState }
  /** Well-formed record that belongs to a different owner than the configured one. */
  | { kind: 'owner-mismatch' }
  | { kind: 'invalid' };

const OWNER_STATE_KEYS = ['version', 'ownerId', 'createdAt', 'phase', 'challenge', 'binding'] as const;
const CHALLENGE_KEYS = ['verifier', 'issuedAt', 'expiresAt'] as const;
const BINDING_KEYS = ['channel', 'chatId', 'senderId', 'boundAt', 'pairingEventId'] as const;

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

/** `YYYY-MM-DD` in UTC. The pairing allowance is keyed on this. */
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

export function decodeOwnerState(input: unknown, expectedOwnerId: string): OwnerStateDecode {
  if (!isPlainObject(input)) return { kind: 'invalid' };
  if (!hasOnlyKeys(input, OWNER_STATE_KEYS)) return { kind: 'invalid' };
  if (input.version !== 1) return { kind: 'invalid' };
  if (typeof input.ownerId !== 'string' || !isValidProfileId(input.ownerId)) return { kind: 'invalid' };
  if (!isIsoTimestamp(input.createdAt)) return { kind: 'invalid' };

  if (input.ownerId !== expectedOwnerId) return { kind: 'owner-mismatch' };

  const base = { version: 1 as const, ownerId: input.ownerId, createdAt: input.createdAt };

  if (input.phase === 'unpaired') {
    if (input.binding !== undefined) return { kind: 'invalid' };
    const challenge = decodeChallenge(input.challenge);
    if (challenge === undefined && input.challenge !== undefined) return { kind: 'invalid' };
    return {
      kind: 'ok',
      state: { ...base, phase: 'unpaired', ...(challenge ? { challenge } : {}) },
    };
  }

  if (input.phase === 'bound') {
    if (input.challenge !== undefined) return { kind: 'invalid' };
    const binding = decodeBinding(input.binding);
    if (!binding) return { kind: 'invalid' };
    return { kind: 'ok', state: { ...base, phase: 'bound', binding } };
  }

  // A missing, blank or unrecognised phase is not a fresh installation.
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
  };
}
