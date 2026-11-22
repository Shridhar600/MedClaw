export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Message describes the file or config, never health content, so it is safe to echo to the user. */
export class MediaValidationError extends AppError {
  constructor(message: string) {
    super(message);
  }
}

/** A corrupted ledger block was quarantined with a parse-error comment; the rest of the file loaded. */
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

/** The caller should relay `currentEntries` for the model to merge/reduce. */
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

export class InvariantViolationError extends AppError {
  constructor(message: string) {
    super(message);
  }
}

/** A straggler write that raced shutdown; `label` is PHI-free and safe to log and show. */
export class DaemonShutdownError extends AppError {
  constructor(public readonly label: string) {
    super(`"${label}" was refused: the runtime is shutting down and its stores are closed.`);
  }
}
