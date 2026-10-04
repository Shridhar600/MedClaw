// src/ports/diagnostics.ts
//
// The observability boundary (plan 15 §7). Interface-only: no app module imports.
//
// This exists because "log something useful" and "ship owner health data" are the same code path
// until you make them different. A diagnostic sink sits on the admission, pairing, intake and
// start/stop paths, which run while a stranger is talking to the process — so if the sink can carry
// arbitrary content, a stranger can put arbitrary content in the logs, and the sink becomes either a
// data leak or a side channel that tells them what the daemon knows.
//
// So the event is a CLOSED tagged union. There is no `payload`, no `message`, no `error`, no `detail`
// and no `path`. Each variant is a stage, an allowlisted outcome, an allowlisted reason, a measured
// duration, and at most one bounded count. Adding a field means adding a variant, which is a
// reviewed contract change instead of an accident at a call site.
//
// A sink is also never allowed to break the operation it observes. `emit` is on the critical path
// of admission: an adapter that throws must not turn a stranger's message into a daemon crash, and
// must not become a denial-of-service lever. `guardedDiagnosticSink` enforces that structurally.
//
// Two vocabularies are imported from sibling ports rather than restated, so there is exactly one
// definition of "why did this refuse" in the system and no drift to police:
//   - `AdmissionReason` from `./owner-state`
//   - `MediaStageReason` from `./media-source`
//
// The pairing vocabulary is NOT imported: `PairingResultKind` is a user-facing answer ("refused"),
// and the diagnostic needs to say WHICH precondition failed, so `PairingDiagnosticReason` is declared
// here. Those are deliberately different surfaces with different granularity.

import type { AdmissionReason } from './owner-state';
import type { MediaStageReason } from './media-source';

/**
 * Which bounded operation produced an event. Closed: a new stage is a contract change, because a
 * consumer that has never seen a stage cannot know which vocabulary its reason belongs to.
 */
export type DiagnosticStage = 'owner-admission' | 'pairing' | 'media-intake' | 'start-stop';

/**
 * Why start/stop refused or failed. Deliberately coarse and allowlisted. In particular there is no
 * `cause`, no exception and no resource path: "the workspace lease was busy" is the whole fact an
 * operator needs, and "…at /Users/someone/MedClaw/config.json" is a disclosure we do not owe anyone.
 *
 * The precise cause of an admission refusal is NOT repeated here. It is emitted by the admission
 * module as an `owner-admission` event carrying the real `AdmissionReason`; this vocabulary only
 * records that the boot stopped because of it.
 */
export type StartStopReason =
  /** Boot refused because the owner record was missing, unreadable, corrupt or another owner's. */
  | 'admission-refused'
  /** start() was called on a running gateway. */
  | 'already-running'
  /** Building the owner runtime, its stores or its providers failed. */
  | 'build-failed'
  /** Releasing a resource during stop failed. */
  | 'release-failed';

/** A measured wall-clock span. Always present, so "how long did this take" is never left to a consumer. */
export interface DiagnosticDuration {
  /** Elapsed milliseconds for the operation. Zero is a real measurement for a refusal that did no work. */
  readonly durationMs: number;
}

/**
 * Why a pairing attempt did not bind. Diagnostic-only and distinct from the user-facing
 * `PairingResultKind`, because those answer different questions: the chat is told a generic
 * `refused`/`invalid`, while an operator needs to know WHICH precondition failed. Collapsing six
 * distinct causes into one `refused` outcome is exactly the "refused, but nobody said why" failure
 * this contract exists to prevent.
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
  /** The owner record could not be read, or a write finished with an unknown outcome. */
  | 'record-unavailable';

/**
 * The closed event union. Discriminated on `stage`, and within each stage on `outcome`.
 *
 * Refusal variants REQUIRE a reason rather than carrying an optional one: the type system then
 * makes "refused, but nobody said why" unrepresentable, which is the failure mode that turns a
 * diagnostic into noise you stop reading.
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
         * Admitted to pairing and emergency guidance ONLY — no clinical runtime, no index, no
         * scheduler. This is its own outcome rather than a flavour of `admitted` because the two are
         * opposite security facts: `admitted` means the owner reached their health data, while
         * `pairing-only` means the daemon correctly withheld it. Collapsing them would make the
         * diagnostic useless for the one question it exists to answer.
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
         * Attempts this chat has spent today, as a bounded count in [0, 3]. Never the chat, sender or
         * event id — those are the values a rate-limit oracle would need. Present only for outcomes
         * where the allowance is what failed, so a reader is not misled into thinking an unrelated
         * refusal consumed an attempt.
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
        outcome: 'started' | 'stopped';
      }
    | {
        stage: 'start-stop';
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
 * The default for a call site that has no sink. Also the honest answer for "who is this for?": the
 * brief requires useful admission/pairing/intake/start-stop OUTCOMES to be emittable, and requires
 * local explicit inspection to be a different surface. Silence is the correct default precisely so
 * that a sink that IS wired up is a deliberate choice.
 */
export const SILENT_DIAGNOSTIC_SINK: DiagnosticSink = {
  emit: () => {},
};

/**
 * Wrap any sink so it cannot throw into the operation it observes.
 *
 * This is the difference between "diagnostics are best-effort" as a comment and as a guarantee. A
 * diagnostic adapter that throws on an unexpected value would otherwise be reachable from a
 * stranger's message: `admit()` would reject, and the failure would look like a denial bug rather
 * than a logging bug. Swallowing here also means a failing sink degrades to silence, which is the
 * same outcome as having no sink at all — so a broken adapter can never change control flow.
 */
export function guardedDiagnosticSink(sink: DiagnosticSink): DiagnosticSink {
  return {
    emit(event: DiagnosticEvent): void {
      try {
        sink.emit(event);
      } catch {
        // Intentionally swallowed. See the note above: a diagnostic must not influence control flow.
      }
    },
  };
}