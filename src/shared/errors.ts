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
 * A MedClaw-generated media/report validation error (unsupported file, extension/MIME mismatch,
 * no renderable pages, provider not vision-capable, raw-media policy). Its message describes the
 * file or config, never health content, so it is safe to echo to the user. The medical tools use
 * this type to tell it apart from a raw provider error, which must never be echoed because it can
 * carry PHI from the prompt.
 */
export class MediaValidationError extends AppError {
  constructor(message: string) {
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

/** A ledger file is damaged: its readable facts stay visible, but it is read-only until repaired. */
export class LedgerUnreadableError extends AppError {
  constructor() {
    super('This part of the health record is damaged and is read-only until it is repaired. The damaged copy is kept next to the file.');
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

/**
 * A write was refused because the owning `ProfileRuntime` is past the safe point of its shutdown
 * sequence (its SQLite handles are closed). This is the expected, handled outcome of a straggler
 * write racing shutdown, never a crash against a closed native handle. Thrown by the capture
 * mutation coordinator and the session manager, both gated on `ProfileRuntime.isClosed()`.
 * Lives in `src/shared` so both `src/capture` and `src/gateway` can import it within the module
 * boundary rules. `label` is a PHI-free operation or lane name, safe to log and to show in a
 * tool-result error string.
 */
export class DaemonShutdownError extends AppError {
  constructor(public readonly label: string) {
    super(`"${label}" was refused: the runtime is shutting down and its stores are closed.`);
  }
}
