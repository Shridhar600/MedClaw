// src/runtime/adapters/media-stager.ts
//
// Bounded streaming of admitted owner media into the owner's own staging directory.
//
// The rules this implements exist because the previous path did none of them:
//
//   * the actual byte cap is enforced WHILE STREAMING. A transport's advertised size is inspected
//     where available but never trusted: it can under-report, and by the time `arrayBuffer()`
//     resolves the memory is already spent.
//   * nothing is buffered whole. Chunks are written through a stream with backpressure; there is no
//     chunks array that grows without bound.
//   * intake is bounded: one active, four waiting, and a 30-second total wait. A refusal happens
//     BEFORE a stream is opened where the answer is already known.
//   * a timeout or abort can occur after an owned partial is opened. Refusal cleanup waits for
//     source cancellation and the owned writable to close before removing that partial. Cancellation
//     requests do not prove acknowledgement within the intake deadline. A source that finishes
//     opening after the attempt ends is asked to cancel rather than streamed.
//   * cleanup is scoped to THIS operation's own partial file. Another operation's staged file, and
//     anything else in the directory, is untouched.

import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { inspectContainedDirectory, createContainedDirectory, summarizeErrorForLog } from '../../security';
import { createMediaArtifactName, MEDIA_PARTIAL_SUFFIX } from '../media-artifact';
import type {
  MediaLimits,
  MediaReference,
  MediaSourcePort,
  MediaStageReason,
  MediaStageResult,
  OpenedMedia,
} from '../../ports';
import { DEFAULT_MEDIA_LIMITS } from '../../ports';
import type { Clock } from '../../ports';
import { systemClock } from '../../ports';
import type { DiagnosticEvent, DiagnosticSink } from '../../ports';
import { SILENT_DIAGNOSTIC_SINK, guardedDiagnosticSink } from '../../ports';

export interface MediaStagerOptions {
  /** Explicit selected owner workspace. Missing/unsafe authority refuses before source or IO effects. */
  trustedBaseDir?: string;
  limits?: MediaLimits;
  /** The closed diagnostic contract. Silent by default; see `ports/diagnostics`. */
  diagnostics?: DiagnosticSink;
  /** Presentation metadata is never a trusted path. */
  log?: (message: string) => void;
}

export class FsMediaStager {
  private active = 0;
  private waiting = 0;
  /** Slots released by finishing operations, so a waiter can take one without polling. */
  private readonly slotWaiters: (() => void)[] = [];
  /** Streams already cancelled, so a stream is never asked to abort twice. */
  private readonly cancelledSources = new WeakSet<OpenedMedia>();

  /**
   * Guarded once here rather than at each emit, so an adapter that throws can never fail a download.
   * Intake runs on a request a stranger can trigger, and a broken log must not turn into a failed
   * upload or a stuck intake slot.
   */
  private readonly sink: DiagnosticSink;
  private readonly clock: Clock;

  constructor(
    private readonly source: MediaSourcePort,
    /** Absolute owner-scoped lane, validated against options.trustedBaseDir before effects. */
    private readonly stagingDir: string,
    private readonly options: MediaStagerOptions = {},
    clock: Clock = systemClock,
  ) {
    this.sink = guardedDiagnosticSink(options.diagnostics ?? SILENT_DIAGNOSTIC_SINK);
    this.clock = clock;
  }

  private emit(event: DiagnosticEvent): void {
    this.sink.emit(event);
  }

  private elapsedSince(startedAt: number): number {
    const elapsed = this.clock.now().getTime() - startedAt;
    return elapsed > 0 ? elapsed : 0;
  }

  get inFlight(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting };
  }

  async stage(ref: MediaReference | undefined, signal: AbortSignal): Promise<MediaStageResult> {
    // Measured across the whole attempt, queue wait included: that wait is the interesting number when
    // an owner asks why their photo was slow.
    const startedAt = this.clock.now().getTime();
    if (!ref || (ref.kind !== 'photo' && ref.kind !== 'document')) {
      return this.refuse('unsupported', undefined, startedAt);
    }
    const limits = this.options.limits ?? DEFAULT_MEDIA_LIMITS;
    if (signal.aborted) return this.refuse('aborted', undefined, startedAt);

    // The advertised size is a claim. If it already exceeds the cap we can refuse without opening a
    // stream at all — no network, no file.
    if (typeof ref.advertisedBytes === 'number' && ref.advertisedBytes > limits.maxFileBytes) {
      return this.refuse('advertised-too-large', undefined, startedAt);
    }

    // The slot is RESERVED synchronously, before the first await. Deciding queue membership after
    // an await would let every concurrent caller observe a free slot and blow past the limit.
    const timeout = new AbortController();
    const onAbort = (): void => timeout.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => timeout.abort(), limits.intakeTimeoutMs);

    let opened: OpenedMedia | undefined;
    let countedAsActive = false;
    let partialPath: string | undefined;
    let ownsPartial = false;

    try {
      if (this.active >= limits.maxActive) {
        if (this.waiting >= limits.maxWaiting) {
          // Refuse rather than queue without bound: an unbounded wait is a denial of service with a
          // memory cap and a timer behind every entry.
          return this.refuse('queue-full', undefined, startedAt);
        }
        this.waiting += 1;
        try {
          await this.awaitSlot(timeout.signal);
        } catch (error) {
          // `awaitSlot` rejects when the intake signal fires while this attempt is QUEUED, and that
          // rejection used to escape `stage()` entirely: the queue wait had a `finally` but no
          // `catch`, so a timeout or caller abort mid-wait threw out of a method declared
          // `Promise<MediaStageResult>` (saved-or-refused, never a rejection). In the Gateway that
          // throw travelled `admitAndStage` -> `deliverMessage`, so the owner got NO reply at all for
          // that message and no `media-intake` diagnostic was emitted.
          //
          // Reachable in production because `Gateway.stop()` aborts the intake controller, so every
          // attempt queued at shutdown took this path.
          //
          // `signal.aborted` separates the two causes: the caller's own abort is `aborted`, while the
          // internal intake budget running out is `timeout`. Same distinction as every other abort
          // path in this method.
          // `awaitSlot` has exactly one reject path today (its abort listener), so an abort error is
          // provably all that can arrive. Anything else means the primitive changed underneath us,
          // and reporting it as 'timeout' would hide it with no diagnostic — so it is logged rather
          // than laundered.
          if (!isAbortError(error)) {
            console.warn('[media-stager] Queue wait failed unexpectedly:', summarizeErrorForLog(error));
          }
          return this.refuse(signal.aborted ? 'aborted' : 'timeout', undefined, startedAt);
        } finally {
          this.waiting -= 1;
        }
      }
      this.active += 1;
      countedAsActive = true;

      if (timeout.signal.aborted) {
        return this.refuse(signal.aborted ? 'aborted' : 'timeout', undefined, startedAt);
      }

      try { inspectContainedDirectory(this.options.trustedBaseDir, this.stagingDir); }
      catch (error) { return this.refuse('source-failed', error, startedAt); }

      try {
        // Raced against the intake signal. `MediaSourcePort` is a documented swap point (specs/16
        // §2) and `open()` is allowed to ignore its signal, so awaiting it bare made a
        // signal-ignoring source hold `maxActive: 1` FOREVER: `active` was never decremented, every
        // later owner upload queued, and each then expired in the queue wait — all reported as
        // 'timeout'. One wedged fetch permanently killed the owner's media path for the life of the
        // daemon. Racing the abort is what makes "one active download" a real bound.
        // Losing the race must still CLEAN UP the loser. If the abort wins, `open()` may resolve
        // later with a live handle — a Telegram file connection, say — and dropping it on the floor
        // would leak the transport for its own lifetime. So the open promise carries its own cleanup,
        // armed only once we have actually stopped waiting. Without this, racing `open()` regressed
        // the existing guarantee that a source finishing after the deadline is cancelled.
        let abandoned = false;
        const openPromise = this.source.open(ref, timeout.signal).then((handle) => {
          if (abandoned) void this.cancelOnce(handle);
          return handle;
        });
        try {
          opened = await withinIntake(openPromise, timeout.signal);
        } catch (error) {
          abandoned = true;
          throw error;
        }
      } catch (error) {
        // A source that fails to open is a source failure, not a timeout — unless the abort that
        // fired is the one that explains it.
        return this.refuse(signal.aborted ? 'aborted' : timeout.signal.aborted ? 'timeout' : 'source-failed', error, startedAt);
      }

      // The wait may have expired while the source was opening. A late completion must not stream.
      if (timeout.signal.aborted || signal.aborted) {
        await this.cancelOnce(opened);
        return this.refuse(signal.aborted ? 'aborted' : 'timeout', undefined, startedAt);
      }
      if (typeof opened.advertisedBytes === 'number' && opened.advertisedBytes > limits.maxFileBytes) {
        await this.cancelOnce(opened);
        return this.refuse('too-large', undefined, startedAt);
      }

      // Recheck after asynchronous source work, immediately before any filesystem mutation.
      try {
        createContainedDirectory(this.options.trustedBaseDir, this.stagingDir);
      } catch (error) {
        await this.cancelOnce(opened);
        return this.refuse('source-failed', error, startedAt);
      }
      // Naming permits bounded orphan recognition; exclusive creation still owns the partial.
      const finalName = createMediaArtifactName(ref.displayName);
      partialPath = path.join(this.stagingDir, `${finalName}${MEDIA_PARTIAL_SUFFIX}`);
      const finalPath = path.join(this.stagingDir, finalName);

      const counter = new ByteCap(limits.maxFileBytes);
      const sink = fs.createWriteStream(partialPath, { mode: 0o600, flags: 'wx' });
      sink.once('open', () => { ownsPartial = true; });
      sink.on('error', () => undefined);
      const sinkClosed = new Promise<void>(resolve => { sink.once('close', resolve); });

      try {
        // The signal is raced EXPLICITLY as well as handed to `pipeline`. A source whose iterator
        // never settles cannot be interrupted by an abort signal alone, so relying on the signal
        // alone would let a hung source keep the intake wait open forever.
        await withinIntake(pipeline(readableFrom(opened), counter, sink, { signal: timeout.signal }), timeout.signal);
      } catch (error) {
        // Preserve the cause at failure, even if cancellation/descriptor close spans a later deadline.
        const reason: MediaStageReason = counter.exceeded ? 'too-large'
          : signal.aborted ? 'aborted' : timeout.signal.aborted ? 'timeout' : 'source-failed';
        await this.cancelOnce(opened);
        // Closing our sink precedes unlink: a pending exclusive open must not create a new partial
        // after cleanup has already looked for it. We do not await an uncooperative source iterator.
        sink.destroy();
        await sinkClosed;
        if (ownsPartial) this.unlinkQuietly(partialPath);
        partialPath = undefined;
        return this.refuse(reason, reason === 'source-failed' ? error : undefined, startedAt);
      }

      if (timeout.signal.aborted || signal.aborted) {
        return this.refuse(signal.aborted ? 'aborted' : 'timeout', undefined, startedAt);
      }

      if (counter.bytes === 0) {
        // An empty stream is a failed upload, not a zero-byte document to hand to a model.
        await this.cancelOnce(opened);
        this.unlinkQuietly(partialPath);
        partialPath = undefined;
        return this.refuse('source-failed', undefined, startedAt);
      }

      let published = false;
      try {
        fs.chmodSync(partialPath, 0o600);
        // A same-lane hard link publishes without replacing an existing final artifact. Rename would
        // overwrite a collision. The partial remains ours until this exclusive publication succeeds.
        fs.linkSync(partialPath, finalPath);
        published = true;
        fs.unlinkSync(partialPath);
      } catch (error) {
        if (published) this.unlinkQuietly(finalPath);
        this.unlinkQuietly(partialPath);
        partialPath = undefined;
        return this.refuse('source-failed', error, startedAt);
      }

      const bytes = counter.bytes;
      this.emit({ stage: 'media-intake', outcome: 'saved', bytes, durationMs: this.elapsedSince(startedAt) });
      return { kind: 'saved', absolutePath: finalPath, bytes };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (countedAsActive) {
        this.active -= 1;
        this.wakeSlot();
      }
      if (ownsPartial && partialPath !== undefined) this.unlinkQuietly(partialPath);
      // Released last: the source is only released once nothing else can touch the stream.
      if (opened) await this.cancelOnce(opened);
    }
  }

  /** Wait for an active slot, bounded by the intake signal so a waiter cannot hang forever. */
  private awaitSlot(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      const onAbort = (): void => {
        const index = this.slotWaiters.indexOf(wake);
        if (index >= 0) this.slotWaiters.splice(index, 1);
        reject(abortError());
      };
      const wake = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.slotWaiters.push(wake);
    });
  }

  private wakeSlot(): void {
    this.slotWaiters.shift()?.();
  }

  /**
   * Cancel an opened stream AT MOST ONCE.
   *
   * Several refusal paths want to cancel, and the `finally` block always tries as well; issuing it
   * twice would double-count a source-side abort and could be read by a source as two requests.
   */
  private async cancelOnce(opened: OpenedMedia): Promise<void> {
    if (this.cancelledSources.has(opened)) return;
    this.cancelledSources.add(opened);
    await opened.cancel().catch(() => undefined);
  }

  private refuse(reason: MediaStageReason, error?: unknown, startedAt?: number): MediaStageResult {
    this.emit({
      stage: 'media-intake',
      outcome: 'refused',
      reason,
      durationMs: startedAt === undefined ? 0 : this.elapsedSince(startedAt),
    });
    if (error !== undefined && this.options.log) {
      // Sanitized frame only: a source failure detail must never carry a URL, token or filename.
      this.options.log(`[media] staging refused (${reason}): ${summarizeErrorForLog(error)}`);
    }
    return { kind: 'refused', reason };
  }

  private unlinkQuietly(target: string | undefined): void {
    if (!target) return;
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.options.log?.(`[media] partial cleanup failed: ${summarizeErrorForLog(error)}`);
      }
    }
  }
}

/**
 * Fails the stream the moment the real byte total exceeds the cap, so an over-large upload stops
 * consuming disk and network instead of being discovered after the fact.
 */
class ByteCap extends Transform {
  bytes = 0;
  exceeded = false;

  constructor(private readonly cap: number) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.cap) {
      this.exceeded = true;
      done(new Error('media exceeds the per-file byte limit'));
      return;
    }
    this.push(chunk);
    done();
  }
}

/** The source's async iterable is already a valid pipeline source; `pipeline` gives backpressure. */
function readableFrom(opened: OpenedMedia): AsyncIterable<Uint8Array> {
  return opened.chunks;
}

/**
 * Rejects as soon as `signal` aborts, and otherwise never settles. Racing this against `pipeline`
 * makes a bounded intake wait a real bound even when the source ignores its signal.
 */
async function withinIntake<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const onAbort = (): void => rejectAbort(abortError());
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** True for the abort rejection produced by `abortError()`. Keeps a catch from swallowing a bug. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.message === 'media intake aborted';
}

function abortError(): Error {
  const error = new Error('media intake aborted');
  error.name = 'AbortError';
  return error;
}
