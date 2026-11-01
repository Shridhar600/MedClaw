// Observability boundary. Interface-only: no app module imports.
//
// The event is a CLOSED tagged union: no payload, message, error, detail or path. Each variant is a
// stage, an allowlisted outcome, an allowlisted reason, a measured duration and at most one bounded
// count, so nothing a stranger sends can reach the logs. Adding a field means adding a variant.
//
// A sink must never break the operation it observes; `guardedDiagnosticSink` enforces that.
//
// Reason vocabularies come from sibling ports (`AdmissionReason`, `MediaStageReason`) so each has one
// definition. `PairingDiagnosticReason` is declared here because the diagnostic must say WHICH
// precondition failed, unlike the user-facing `PairingResultKind`.

import type { AdmissionReason } from './owner-state';
import type { MediaStageReason } from './media-source';

/**
 * Which bounded operation produced an event. Closed: a consumer must know which reason vocabulary
 * belongs to each stage.
 */
export type DiagnosticStage = 'owner-admission' | 'pairing' | 'media-intake' | 'start-stop';

/**
 * Why start/stop refused or failed. Deliberately coarse and allowlisted: no cause, exception or
 * resource path.
 *
 * The precise cause of an admission refusal is emitted by the admission module as an
 * `owner-admission` event; this vocabulary only records that boot stopped because of it.
 */
export type StartStopReason =
  /** Boot refused because the owner record was missing, unreadable, corrupt or another owner's. */
  | 'admission-refused'
  /** start() was called on a running gateway. */
  | 'already-running'
  /** Building the owner runtime, its stores or its providers failed. */
  | 'build-failed'
  /**
   * Start was refused because the runtime generation it would replace still has work in flight that
   * can write to this installation. Constant string; no identifier, path or payload.
   */
  | 'previous-work-unsettled'
  /** Owner promotion stopped before a serving runtime became available. */
  | 'shutdown-in-progress'
  /** Releasing a resource during stop failed. */
  | 'release-failed';

/** A measured wall-clock span. Always present, so "how long did this take" is never left to a consumer. */
export interface DiagnosticDuration {
  /** Elapsed milliseconds for the operation. Zero is a real measurement for a refusal that did no work. */
  readonly durationMs: number;
}

/**
 * Why a pairing attempt did not bind. Diagnostic-only and distinct from the user-facing
 * `PairingResultKind`: the chat gets a generic answer, while an operator needs to know which
 * precondition failed.
 */
export type PairingDiagnosticReason =
  /** The owner record belongs to a different owner than the configured one. */
  | 'owner-mismatch'
  /** Another chat is already bound. A stranger gets a generic refusal and never enrollment. */
  | 'already-bound'
  /** Group/supergroup/channel traffic, or a transport identity missing required fields. */
  | 'not-a-private-pairing-identity'
  /** The submitted code did not match the issued challenge. */
  | 'code-mismatch'
  /** The 24-hour challenge window elapsed before the code was used. */
  | 'code-expired'
  /** Today's attempt allowance for this chat is spent. */
  | 'daily-allowance-spent'
  /** Today's bounded candidate table is full; this chat has spent no attempts. */
  | 'candidate-capacity-reached'
  /** The owner record could not be read, or a write finished with an unknown outcome. */
  | 'record-unavailable';

/**
 * The closed event union. Discriminated on `stage`, and within each stage on `outcome`.
 * Refusal variants REQUIRE a reason, so "refused, but nobody said why" is unrepresentable.
 */
export type DiagnosticEvent = DiagnosticDuration &
  (
    | {
        stage: 'owner-admission';
        outcome: 'admitted';
        /** No inbound identity was consulted for an admitted boot, so there is no reason to report. */
      }
    | {
        stage: 'owner-admission';
        /**
         * Admitted to pairing and emergency guidance ONLY: no clinical runtime, index or scheduler.
         * Kept apart from `admitted` because the two are opposite facts about access to health data.
         */
        outcome: 'pairing-only';
      }
    | {
        stage: 'owner-admission';
        outcome: 'refused';
        reason: AdmissionReason;
      }
    | {
        stage: 'pairing';
        /** Progress, not refusal: a bound owner, an idempotent replay, or a prompt to send a code. */
        outcome: 'paired' | 'already-paired' | 'prompt';
      }
    | {
        stage: 'pairing';
        outcome: 'refused' | 'invalid' | 'expired' | 'limited' | 'unavailable';
        reason: PairingDiagnosticReason;
        /**
         * Attempts this chat has spent today, a bounded count in [0, 3]. Never the chat, sender or
         * event id. Present only for outcomes where the allowance is what failed.
         */
        attempts?: number;
      }
    | {
        stage: 'media-intake';
        outcome: 'saved';
        /** Actual streamed bytes. Bounded by the 10 MiB per-file cap before this point. */
        bytes: number;
      }
    | {
        stage: 'media-intake';
        outcome: 'refused';
        reason: MediaStageReason;
      }
    | {
        stage: 'start-stop';
        operation: 'start' | 'promotion' | 'stop';
        outcome: 'started' | 'stopped';
      }
    | {
        stage: 'start-stop';
        operation: 'start' | 'promotion' | 'stop';
        outcome: 'refused' | 'failed';
        reason: StartStopReason;
      }
  );

/**
 * The sink an adapter implements. `emit` MUST NOT throw — see `guardedDiagnosticSink`, which is the
 * supported way to guarantee that for an adapter you do not control.
 */
export interface DiagnosticSink {
  emit(event: DiagnosticEvent): void;
}

/**
 * The default for a call site that has no sink. Reusable modules default to silence; application
 * composition selects a sink explicitly (the daemon uses a value-free console adapter).
 */
export const SILENT_DIAGNOSTIC_SINK: DiagnosticSink = {
  emit: () => {},
};

/**
 * Wrap any sink so it cannot throw into the operation it observes. A failing sink degrades to
 * silence and never changes control flow.
 */
export function guardedDiagnosticSink(sink: DiagnosticSink): DiagnosticSink {
  return {
    emit(event: DiagnosticEvent): void {
      try {
        sink.emit(event);
      } catch {
        // Intentionally swallowed: a diagnostic must not influence control flow.
      }
    },
  };
}
