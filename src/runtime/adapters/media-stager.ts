
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
  private busy = false;

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

  get isBusy(): boolean {
    return this.busy;
  }

  async stage(ref: MediaReference | undefined, signal: AbortSignal): Promise<MediaStageResult> {
    const startedAt = this.clock.now().getTime();
    if (!ref || (ref.kind !== 'photo' && ref.kind !== 'document')) {
      return this.refuse('unsupported', undefined, startedAt);
    }
    const limits = this.options.limits ?? DEFAULT_MEDIA_LIMITS;
    if (signal.aborted) return this.refuse('aborted', undefined, startedAt);

    // The advertised size is a claim. If it already exceeds the cap we can refuse without opening a stream.
    if (typeof ref.advertisedBytes === 'number' && ref.advertisedBytes > limits.maxFileBytes) {
      return this.refuse('advertised-too-large', undefined, startedAt);
    }

    // Telegram delivers updates in order, so a second upload here is a burst: refuse instead of queueing.
    if (this.busy) return this.refuse('queue-full', undefined, startedAt);
    this.busy = true;

    const intake = AbortSignal.any([signal, AbortSignal.timeout(limits.intakeTimeoutMs)]);
    const abortReason = (): MediaStageReason => (signal.aborted ? 'aborted' : 'timeout');

    let opened: OpenedMedia | undefined;
    let partialPath: string | undefined;
    let ownsPartial = false;

    try {
      try { inspectContainedDirectory(this.options.trustedBaseDir, this.stagingDir); }
      catch (error) { return this.refuse('source-failed', error, startedAt); }

      try {
        let abandoned = false;
        const openPromise = this.source.open(ref, intake).then((handle) => {
          if (abandoned) void handle.cancel().catch(() => undefined);
          return handle;
        });
        try {
          opened = await withinIntake(openPromise, intake);
        } catch (error) {
          abandoned = true;
          throw error;
        }
      } catch (error) {
        return this.refuse(intake.aborted ? abortReason() : 'source-failed', error, startedAt);
      }

      if (intake.aborted) return this.refuse(abortReason(), undefined, startedAt);
      if (typeof opened.advertisedBytes === 'number' && opened.advertisedBytes > limits.maxFileBytes) {
        return this.refuse('too-large', undefined, startedAt);
      }

      // Recheck after asynchronous source work, immediately before any filesystem mutation.
      try {
        createContainedDirectory(this.options.trustedBaseDir, this.stagingDir);
      } catch (error) {
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
        // Raced explicitly as well: a source whose iterator never settles cannot be interrupted by the signal alone.
        await withinIntake(pipeline(readableFrom(opened), counter, sink, { signal: intake }), intake);
      } catch (error) {
        const reason: MediaStageReason = counter.exceeded ? 'too-large' : intake.aborted ? abortReason() : 'source-failed';
        sink.destroy();
        await sinkClosed;
        if (ownsPartial) this.unlinkQuietly(partialPath);
        partialPath = undefined;
        return this.refuse(reason, reason === 'source-failed' ? error : undefined, startedAt);
      }

      if (intake.aborted) return this.refuse(abortReason(), undefined, startedAt);

      if (counter.bytes === 0) {
        // An empty stream is a failed upload, not a zero-byte document to hand to a model.
        return this.refuse('source-failed', undefined, startedAt);
      }

      let published = false;
      try {
        fs.chmodSync(partialPath, 0o600);
        fs.linkSync(partialPath, finalPath);
        published = true;
        fs.unlinkSync(partialPath);
      } catch (error) {
        if (published) this.unlinkQuietly(finalPath);
        return this.refuse('source-failed', error, startedAt);
      }
      partialPath = undefined;

      const bytes = counter.bytes;
      this.emit({ stage: 'media-intake', outcome: 'saved', bytes, durationMs: this.elapsedSince(startedAt) });
      return { kind: 'saved', absolutePath: finalPath, bytes };
    } finally {
      this.busy = false;
      if (ownsPartial && partialPath !== undefined) this.unlinkQuietly(partialPath);
      // Released last: the source is only released once nothing else can touch the stream.
      if (opened) await opened.cancel().catch(() => undefined);
    }
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

function abortError(): Error {
  const error = new Error('media intake aborted');
  error.name = 'AbortError';
  return error;
}
