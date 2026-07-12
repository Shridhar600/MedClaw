/**
 * Base class for all application-level errors.
 * Extend this for domain-specific typed errors.
 */
export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotImplementedError extends AppError {
  constructor(message = 'Not implemented') {
    super(message);
  }
}

/**
 * A corrupted block in a Markdown ledger file was quarantined with a
 * <!-- PARSE-ERROR --> comment. The store continued loading other blocks.
 */
export class ParseQuarantineError extends AppError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * A write to curated memory exceeded the section's character budget.
 * The caller should relay entries for the model to merge/reduce.
 */
export class BudgetExceededError extends AppError {
  constructor(
    message: string,
    public readonly section: string,
    public readonly gauge: number,
    public readonly currentEntries: string[],
  ) {
    super(message);
  }
}

/**
 * A proposed mutation requires end-user confirmation before it is applied.
 * Carries a token the user must return via the confirm tool.
 */
export class NeedsConfirmationError extends AppError {
  constructor(
    message: string,
    public readonly tokenId: string,
  ) {
    super(message);
  }
}

/**
 * An index is running in degraded mode — keyword-only because embeddings
 * are unavailable. Operation proceeds, but search quality is reduced.
 */
export class IndexDegradedError extends AppError {
  constructor(
    message: string,
    public readonly mode: 'keyword-only',
  ) {
    super(message);
  }
}

/**
 * A store's on-disk state was corrupt and has been rebuilt (or is being
 * rebuilt) from source-of-truth Markdown files.
 */
export class StoreCorruptError extends AppError {
  constructor(
    message: string,
    public readonly rebuilt: boolean,
  ) {
    super(message);
  }
}

/**
 * An invariant required for safe operation was violated.
 * This is a fatal-turn error — the agent must not proceed.
 */
export class InvariantViolationError extends AppError {
  constructor(message: string) {
    super(message);
  }
}
