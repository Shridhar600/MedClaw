// src/memcore/token-errors.ts
//
// Typed rejection for confirmation-token failures (W-C/D PPHI fix). The raw
// Error messages interpolated entity names (health content) which previously
// leaked into persisted session JSONL via the ledger_update catch. Carries a
// FIXED-VOCABULARY reason only — never entity names, field values, or raw
// provider/error text.

/** Safe rejection reasons — fixed vocabulary, PHI-free by construction. */
export type TokenRejectionReason =
  | 'token-not-found'
  | 'token-already-used'
  | 'token-expired'
  | 'same-turn-confirm'
  | 'confirmation-context-mismatch'
  | 'state-moved-since-proposal'
  | 'no-active-version'
  | 'dispute-incomplete'
  | 'dispute-version-not-offered'
  | 'entity-already-active'
  | 'unknown-op';

const REASON_TEXT: Record<TokenRejectionReason, string> = {
  'token-not-found': 'confirmation token not found (it may have expired or been issued in a previous session)',
  'token-already-used': 'confirmation token was already used',
  'token-expired': 'confirmation token expired (15-minute window)',
  'same-turn-confirm': 'a confirmation cannot be applied in the same turn that created it',
  'confirmation-context-mismatch': 'the confirmation token belongs to a different chat',
  'state-moved-since-proposal': 'the underlying fact changed since this change was proposed — re-state the change to get a fresh proposal',
  'no-active-version': 'the fact this change applies to no longer has an active version',
  'dispute-incomplete': 'dispute resolution needs a winningVersion',
  'dispute-version-not-offered': 'winningVersion was not one of the offered dispute versions',
  'entity-already-active': 'the fact is already active',
  'unknown-op': 'unsupported confirmation operation',
};

export class TokenRejectedError extends Error {
  constructor(public readonly reason: TokenRejectionReason) {
    super(`CONFIRM_REJECTED: ${REASON_TEXT[reason]}`);
    this.name = 'TokenRejectedError';
  }
}
