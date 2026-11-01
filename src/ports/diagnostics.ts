
import type { AdmissionReason } from './owner-state';
import type { MediaStageReason } from './media-source';

export type DiagnosticStage = 'owner-admission' | 'pairing' | 'media-intake' | 'start-stop';

export type StartStopReason =
  /** Boot refused because the owner record was missing, unreadable, corrupt or another owner's. */
  | 'admission-refused'
  /** start() was called on a running gateway. */
  | 'already-running'
  /** Building the owner runtime, its stores or its providers failed. */
  | 'build-failed'
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

export type DiagnosticEvent = DiagnosticDuration &
  (
    | {
        stage: 'owner-admission';
        outcome: 'admitted';
        /** No inbound identity was consulted for an admitted boot, so there is no reason to report. */
      }
    | {
        stage: 'owner-admission';
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

export interface DiagnosticSink {
  emit(event: DiagnosticEvent): void;
}

export const SILENT_DIAGNOSTIC_SINK: DiagnosticSink = {
  emit: () => {},
};

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
