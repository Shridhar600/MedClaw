// src/ports/media-source.ts
//
// The media boundary. Interface-only: no app module imports.
//
// The split is the whole point of this file:
//
//   the TRANSPORT emits an opaque `MediaReference` — an identity, never bytes;
//   the CORE decides admission first, and only then asks a `MediaSourcePort` to open a stream.
//
// A transport that fetched bytes, wrote a file or buffered the body before admission would let an
// unauthenticated stranger make the process do work on their behalf. That is what this seam exists
// to prevent.

/**
 * An opaque handle to media at the transport. It carries an identity and whatever the transport
 * advertises — and deliberately NOTHING else: no local path (a path would be authority), no URL the
 * core would fetch (a fetch would be work before admission), and no executable callback.
 */
export interface MediaReference {
  channel: string;
  /** Opaque transport handle. Never a URL, never a filesystem path. */
  fileId: string;
  kind: 'photo' | 'document';
  /** Presentation metadata only. Never trusted as a path component. */
  displayName?: string;
  mime?: string;
  /** The transport's size claim. Inspected where available; never trusted as the cap. */
  advertisedBytes?: number;
}

/**
 * An opened media stream. `advertisedBytes` is the transport's claim, not a guarantee — the caller
 * enforces the real limit while streaming, because a claim can lie.
 *
 * `chunks` is an `AsyncIterable`, never a `Buffer` or a chunks array: an upload must not be
 * buffered whole in memory before its size is known.
 */
export interface OpenedMedia {
  /** Transport-advertised size, when the transport knows one. Never trusted as the cap. */
  advertisedBytes?: number;
  chunks: AsyncIterable<Uint8Array>;
  /** Abort an in-flight retrieval. Must be safe to call more than once. */
  cancel(): Promise<void>;
}

export interface MediaSourcePort {
  open(ref: MediaReference, signal: AbortSignal): Promise<OpenedMedia>;
}

/** Why staging refused. Typed, bounded, and never an exception payload or a remote URL. */
export type MediaStageReason =
  /** No media reference, or one that is not for a kind we admit. */
  | 'unsupported'
  /** Over the per-file byte cap, discovered while streaming. */
  | 'too-large'
  /** Total intake wait exceeded. */
  | 'timeout'
  /** Another upload was still staging. Refused BEFORE opening a stream. */
  | 'queue-full'
  /** Intake was aborted (stop, or authority lost) while the stream was open. */
  | 'aborted'
  /** The transport or the filesystem failed. Detail goes to diagnostics, never to a reply. */
  | 'source-failed'
  /** The advertised size alone already exceeded the cap, so nothing was opened. */
  | 'advertised-too-large';

export type MediaStageResult =
  | { kind: 'saved'; absolutePath: string; bytes: number }
  | { kind: 'refused'; reason: MediaStageReason };

/**
 * Typed owning-module limits. Deliberately constants, not setup knobs: they are
 * safety bounds, and an operator tuning them by hand is how they stop being safety bounds.
 */
export const MEDIA_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MEDIA_INTAKE_TIMEOUT_MS = 30_000;

export interface MediaLimits {
  maxFileBytes: number;
  intakeTimeoutMs: number;
}

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  maxFileBytes: MEDIA_MAX_FILE_BYTES,
  intakeTimeoutMs: MEDIA_INTAKE_TIMEOUT_MS,
};

/** One bounded, identifier-free diagnostic per staging attempt. No analytics, no filenames. */
export interface MediaStageDiagnostics {
  recordMediaStageOutcome(outcome: { result: 'saved'; bytes: number } | { result: 'refused'; reason: MediaStageReason }): void;
}
