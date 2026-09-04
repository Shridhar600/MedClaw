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
 * FILE or CONFIG — never health content — so it is safe to echo to the user. This TYPE is how the
 * medical tools tell a self-generated validation error (echo it) apart from a raw provider error
 * (never echo — it can carry PHI from the prompt). See medical-tools `buildReportErrorMessage` (F-2).
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
 * RR-STRUCT R-S4 (mini-plan v3 §3.9): a write was refused because the owning `ProfileRuntime`
 * has progressed past the safe point of its `running -> stopping -> closed` shutdown sequence
 * (its SQLite handles are closed). This is the EXPECTED, HANDLED outcome of a straggler/abandoned
 * write racing shutdown — never an unhandled crash against a closed native handle. Thrown by
 * `MutationCoordinator.enqueue/mutate/selfHeal` (src/capture) and `SessionManager.recordTurn/
 * recordPromptUsage/runCompaction` (src/gateway), both gated on `ProfileRuntime.isClosed()`.
 * Lives here (not in mutation-coordinator.ts, where `ReentrantMutationError` lives) because BOTH
 * `src/capture` (v2-core) and `src/gateway` (legacy) must be able to import it without a
 * module-law violation (`v2-core-boundary` in .dependency-cruiser.cjs permits v2-core modules to
 * import only from `src/ports/`, `src/shared/`, their own directory, and external packages).
 * `label` is a PHI-free operation/lane name (a tool/method label, never health content) — safe to
 * log and safe to surface in a tool-result error string.
 */
export class DaemonShutdownError extends AppError {
  constructor(public readonly label: string) {
    super(`"${label}" was refused: the runtime is shutting down and its stores are closed.`);
  }
}
