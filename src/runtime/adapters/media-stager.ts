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
//   * a timeout or abort CANNOT write a file. If the wait expired while the source was still
//     opening, a late completion is cancelled rather than streamed.
//   * cleanup is scoped to THIS operation's own partial file. Another operation's staged file, and
//     anything else in the directory, is untouched.

import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { secureMkdir, summarizeErrorForLog } from '../../security';
import type {
  MediaLimits,
  MediaReference,
  MediaSourcePort,
  MediaStageDiagnostics,
  MediaStageReason,
  MediaStageResult,
  OpenedMedia,
} from '../../ports/media-source';
import { DEFAULT_MEDIA_LIMITS } from '../../ports/media-source';

/**
 * Suffix marking THIS operation's in-progress partial file. Cleanup targets exactly this suffix, so
 * it can never touch a sibling operation's staged file. Final names deliberately do NOT carry it.
 */
const PARTIAL_SUFFIX = '.part';

export interface MediaStagerOptions {
  limits?: MediaLimits;
  diagnostics?: MediaStageDiagnostics;
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

  constructor(
    private readonly source: MediaSourcePort,
    /** Absolute, already-trusted owner-scoped staging directory. */
    private readonly stagingDir: string,
    private readonly options: MediaStagerOptions = {},
  ) {}

  get inFlight(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting };
  }

  async stage(ref: MediaReference | undefined, signal: AbortSignal): Promise<MediaStageResult> {
    if (!ref || (ref.kind !== 'photo' && ref.kind !== 'document')) {
      return this.refuse('unsupported');
    }
    const limits = this.options.limits ?? DEFAULT_MEDIA_LIMITS;

    // The advertised size is a claim. If it already exceeds the cap we can refuse without opening a
    // stream at all — no network, no file.
    if (typeof ref.advertisedBytes === 'number' && ref.advertisedBytes > limits.maxFileBytes) {
      return this.refuse('advertised-too-large');
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

    try {
      if (this.active >= limits.maxActive) {
        if (this.waiting >= limits.maxWaiting) {
          // Refuse rather than queue without bound: an unbounded wait is a denial of service with a
          // memory cap and a timer behind every entry.
          return this.refuse('queue-full');
        }
        this.waiting += 1;
        try {
          await this.awaitSlot(timeout.signal);
        } finally {
          this.waiting -= 1;
        }
      }
      this.active += 1;
      countedAsActive = true;

      if (timeout.signal.aborted) {
        return this.refuse(signal.aborted ? 'aborted' : 'timeout');
      }

      try {
        opened = await this.source.open(ref, timeout.signal);
      } catch (error) {
        // A source that fails to open is a source failure, not a timeout — unless the abort that
        // fired is the one that explains it.
        return this.refuse(timeout.signal.aborted && !signal.aborted ? 'timeout' : 'source-failed', error);
      }

      // The wait may have expired while the source was opening. A late completion must not stream.
      if (timeout.signal.aborted || signal.aborted) {
        await this.cancelOnce(opened);
        return this.refuse(signal.aborted ? 'aborted' : 'timeout');
      }
      if (typeof opened.advertisedBytes === 'number' && opened.advertisedBytes > limits.maxFileBytes) {
        await this.cancelOnce(opened);
        return this.refuse('too-large');
      }

      secureMkdir(this.stagingDir, { recursive: true });
      // The display name is presentation metadata. It is sanitised to a basename and never trusted
      // as a path, and the random stem means two uploads cannot collide.
      const stem = `${process.pid}-${Date.now()}-${randomSuffix()}`;
      const finalName = `${stem}-${sanitizeSegment(ref.displayName) || 'upload'}`;
      partialPath = path.join(this.stagingDir, `${finalName}${PARTIAL_SUFFIX}`);
      const finalPath = path.join(this.stagingDir, finalName);

      const counter = new ByteCap(limits.maxFileBytes);
      const sink = fs.createWriteStream(partialPath, { mode: 0o600, flags: 'wx' });
      sink.on('error', () => undefined);

      try {
        // The signal is raced EXPLICITLY as well as handed to `pipeline`. A source whose iterator
        // never settles cannot be interrupted by an abort signal alone, so relying on the signal
        // alone would let a hung source keep the intake wait open forever.
        await Promise.race([
          pipeline(readableFrom(opened), counter, sink, { signal: timeout.signal }),
          abortRejection(timeout.signal),
        ]);
      } catch (error) {
        await this.cancelOnce(opened);
        this.unlinkQuietly(partialPath);
        partialPath = undefined;
        if (counter.exceeded) return this.refuse('too-large');
        if (signal.aborted) return this.refuse('aborted');
        if (timeout.signal.aborted) return this.refuse('timeout');
        return this.refuse('source-failed', error);
      }

      if (counter.bytes === 0) {
        // An empty stream is a failed upload, not a zero-byte document to hand to a model.
        await this.cancelOnce(opened);
        this.unlinkQuietly(partialPath);
        partialPath = undefined;
        return this.refuse('source-failed');
      }

      try {
        fs.chmodSync(partialPath, 0o600);
        fs.renameSync(partialPath, finalPath);
      } catch (error) {
        this.unlinkQuietly(partialPath);
        partialPath = undefined;
        return this.refuse('source-failed', error);
      }

      const bytes = counter.bytes;
      this.options.diagnostics?.recordMediaStageOutcome({ result: 'saved', bytes });
      return { kind: 'saved', absolutePath: finalPath, bytes };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (countedAsActive) {
        this.active -= 1;
        this.wakeSlot();
      }
      if (partialPath !== undefined) this.unlinkQuietly(partialPath);
      // Released last: the source is only released once nothing else can touch the stream.
      if (opened) await this.cancelOnce(opened);
    }
  }

  /** Wait for an active slot, bounded by the intake signal so a waiter cannot hang forever. */
  private awaitSlot(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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

  private refuse(reason: MediaStageReason, error?: unknown): MediaStageResult {
    this.options.diagnostics?.recordMediaStageOutcome({ result: 'refused', reason });
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
    } catch {
      // best effort: a leftover partial is owner-scoped and never readable as an adopted file
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
function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function abortError(): Error {
  const error = new Error('media intake aborted');
  error.name = 'AbortError';
  return error;
}

/** A basename with every path separator and control character removed. Never a trusted path. */
function sanitizeSegment(name: string | undefined): string {
  if (!name) return '';
  return name
    // Separators and NUL become underscores, so the result is always a single path segment.
    .replace(/[\\/\0]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // A dot run is not needed for presentation and is the classic traversal ingredient. Leading
    // dots (hidden files, `..`) are removed entirely rather than trimmed, so the sanitised segment
    // can never contain `..` at all.
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
