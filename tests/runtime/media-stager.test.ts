// tests/runtime/media-stager.test.ts
//
// The bounded media path, through the real `FsMediaStager` and a real streaming source.
//
// These are the protections the channel used to (badly) attempt at write time and cannot attempt at
// all now that the transport only emits a reference: a real byte cap enforced while streaming, a
// bounded intake wait, a bounded queue, refusal before any stream is opened, abort that cannot
// write, and cleanup scoped to one operation's own partial file.
//
// The source is a REAL async iterable, not a mocked `pipeline`. Nothing here asserts on a call
// count of the stager's internals; every assertion is about bytes on disk, the typed outcome, or
// what the owner's staging directory is left containing.

import * as fs from 'fs';
import fsModule from 'fs';
import * as path from 'path';
import { getEventListeners } from 'events';

import { FsMediaStager } from '../../src/runtime';
import { TelegramMediaSource } from '../../src/channels';
import type {
  MediaReference,
  MediaSourcePort,
  MediaStageResult,
  OpenedMedia,
} from '../../src/ports/media-source';
import { DEFAULT_MEDIA_LIMITS } from '../../src/ports/media-source';
import type { DiagnosticEvent } from '../../src/ports/diagnostics';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

function reference(overrides: Partial<MediaReference> = {}): MediaReference {
  return {
    channel: 'telegram',
    fileId: 'file-1',
    kind: 'document',
    displayName: 'report.pdf',
    ...overrides,
  };
}

/** A source that yields `chunkSize`-sized pieces until `totalBytes` are produced. */
function streamingSource(totalBytes: number, chunkSize = 64 * 1024): {
  source: MediaSourcePort;
  opens: number;
  cancels: number;
} {
  const state = { opens: 0, cancels: 0 };
  return {
    get opens() { return state.opens; },
    get cancels() { return state.cancels; },
    source: {
      open: async (): Promise<OpenedMedia> => {
        state.opens += 1;
        let sent = 0;
        return {
          chunks: {
            async *[Symbol.asyncIterator]() {
              while (sent < totalBytes) {
                const size = Math.min(chunkSize, totalBytes - sent);
                sent += size;
                yield new Uint8Array(size).fill(65);
              }
            },
          },
          cancel: async () => { state.cancels += 1; },
        };
      },
    },
  };
}

/** A source whose stream blocks forever, for abort/timeout tests. */
function blockingSource(): { source: MediaSourcePort; cancels: number } {
  const state = { cancels: 0 };
  return {
    get cancels() { return state.cancels; },
    source: {
      open: async (): Promise<OpenedMedia> => ({
        chunks: {
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator]() {
            await new Promise<void>(() => { /* never settles */ });
            yield new Uint8Array(0);
          },
        },
        cancel: async () => { state.cancels += 1; },
      }),
    },
  };
}

function listStaging(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

describe('FsMediaStager: bounded streaming into owner-scoped staging', () => {
  let root: string;
  let staging: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-stager');
    staging = path.join(root, 'state', 'profiles', 'default', '.state', 'media-staging');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  it('streams an upload to a unique 0600 file and reports the real byte count', async () => {
    const { source } = streamingSource(300 * 1024);
    const stager = new FsMediaStager(source, staging);

    const result = await stager.stage(reference(), new AbortController().signal);

    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('unreachable');
    expect(result.bytes).toBe(300 * 1024);
    expect(fs.statSync(result.absolutePath).size).toBe(300 * 1024);
    expect(fs.statSync(result.absolutePath).mode & 0o777).toBe(0o600);
    // No partial left behind.
    expect(listStaging(staging).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('never lets a transport-supplied name become a path', async () => {
    const { source } = streamingSource(1024, 1024);
    const stager = new FsMediaStager(source, staging);

    const result = await stager.stage(
      reference({ displayName: '../../../../etc/passwd' }),
      new AbortController().signal,
    );

    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('unreachable');
    // Still inside the owner's staging directory, and the separators were neutralised.
    expect(path.dirname(result.absolutePath)).toBe(staging);
    // No traversal ingredient survives sanitisation at all.
    expect(path.basename(result.absolutePath)).not.toContain('..');
  });

  it('refuses an advertised oversize upload without opening a stream at all', async () => {
    const { source, opens } = streamingSource(1024);
    const stager = new FsMediaStager(source, staging, {
      limits: { maxFileBytes: 1024, intakeTimeoutMs: 5_000, maxActive: 1, maxWaiting: 4 },
    });

    const result = await stager.stage(
      reference({ advertisedBytes: 5_000 }),
      new AbortController().signal,
    );

    expect(result).toEqual({ kind: 'refused', reason: 'advertised-too-large' });
    expect(opens).toBe(0);
    expect(listStaging(staging)).toEqual([]);
  });

  it('refuses an upload that lies about its size, once the real bytes exceed the cap', async () => {
    // The advertised size claims 100 bytes; the stream is 50 KiB. A trusted claim would pass this.
    const { source } = streamingSource(50 * 1024, 4096);
    const stager = new FsMediaStager(source, staging, {
      limits: { maxFileBytes: 8 * 1024, intakeTimeoutMs: 5_000, maxActive: 1, maxWaiting: 4 },
    });

    const result = await stager.stage(
      reference({ advertisedBytes: 100 }),
      new AbortController().signal,
    );

    expect(result).toEqual({ kind: 'refused', reason: 'too-large' });
    // The partial was cleaned up and nothing adoptable remains.
    expect(listStaging(staging)).toEqual([]);
  });

  it('refuses an empty stream rather than handing a zero-byte file onward', async () => {
    const { source } = streamingSource(0);
    const stager = new FsMediaStager(source, staging);

    expect(await stager.stage(reference(), new AbortController().signal)).toEqual({
      kind: 'refused',
      reason: 'source-failed',
    });
    expect(listStaging(staging)).toEqual([]);
  });

  it('refuses a media kind it does not admit', async () => {
    const { source, opens } = streamingSource(1024);
    const stager = new FsMediaStager(source, staging);

    const unsupported = await stager.stage(
      { ...reference(), kind: 'video' as unknown as MediaReference['kind'] },
      new AbortController().signal,
    );
    const missing = await stager.stage(undefined, new AbortController().signal);

    expect(unsupported).toEqual({ kind: 'refused', reason: 'unsupported' });
    expect(missing).toEqual({ kind: 'refused', reason: 'unsupported' });
    expect(opens).toBe(0);
  });

  it('refuses a queued upload when the waiting room is full, before opening a stream', async () => {
    const blocker = blockingSource();
    const stager = new FsMediaStager(blocker.source, staging, {
      limits: { maxFileBytes: 1024, intakeTimeoutMs: 60_000, maxActive: 1, maxWaiting: 1 },
    });

    const active = stager.stage(reference({ fileId: 'a' }), new AbortController().signal);
    // Let the first take the single active slot.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const waiting = stager.stage(reference({ fileId: 'b' }), new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const overflow = await stager.stage(reference({ fileId: 'c' }), new AbortController().signal);

    expect(overflow).toEqual({ kind: 'refused', reason: 'queue-full' });
    expect(stager.inFlight).toEqual({ active: 1, waiting: 1 });

    // The blocked attempts are abandoned by the stager's own timeout path; nothing is left running.
    void active;
    void waiting;
    void blocker;
  });

  it('REFUSES (never throws) when a queued attempt is released by the ACTIVE one timing out', async () => {
    // A queued attempt whose wait ends because the ACTIVE attempt finished — the ordinary
    // queue-drain shape. The stager never rejects here, and this is the regression guard for the
    // sibling case below: it must keep passing after the fix.
    const blocker = blockingSource();
    const stager = new FsMediaStager(blocker.source, staging, {
      limits: { maxFileBytes: 1024, intakeTimeoutMs: 40, maxActive: 1, maxWaiting: 2 },
    });

    const active = stager.stage(reference({ fileId: 'a' }), new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const queued = stager.stage(reference({ fileId: 'b' }), new AbortController().signal);

    await expect(queued).resolves.toMatchObject({ kind: 'refused' });
    await expect(active).resolves.toMatchObject({ kind: 'refused' });
    expect(listStaging(staging)).toEqual([]);
    expect(stager.inFlight.waiting).toBe(0);
  });

  it('REFUSES (never throws) when the slot is wedged by a source that ignores its signal', async () => {
    // This is the case my first attempt at this coverage got WRONG, and the correction matters.
    //
    // I originally drove the queue wait with `blockingSource()` and a short budget, and reasoned that
    // a queued attempt could never time out because the ACTIVE attempt's own timer fires first and
    // wakes it. A cold re-reviewer deleted the new `catch` from a copy of this module and the test
    // STILL PASSED — it never reached the changed line, so it pinned nothing.
    //
    // The timeout branch IS reachable, and this is how: `source.open()` was awaited bare, so a source
    // that ignores its signal held the single `maxActive: 1` slot FOREVER. `active` was never
    // decremented, every later owner upload queued, and each then expired in the queue wait — all
    // reported as 'timeout'. One wedged fetch permanently killed the owner's media path for the life
    // of the daemon. `open()` is now raced against the intake signal, which is what makes the bound
    // real; this case is what proves it.
    let opens = 0;
    const wedged: MediaSourcePort = {
      open: async (): Promise<OpenedMedia> => {
        opens += 1;
        // `open()` itself never settles and ignores the signal — the exact shape the race exists for.
        // My first version of this case resolved `open()` and blocked the CHUNK iterator instead,
        // which the pipeline race already handled, so the case passed with the open() race removed
        // and pinned nothing. Verified by mutation.
        await new Promise<void>(() => { /* never settles */ });
        throw new Error('unreachable');
      },
    };
    const stager = new FsMediaStager(wedged, staging, {
      limits: { maxFileBytes: 1024, intakeTimeoutMs: 40, maxActive: 1, maxWaiting: 2 },
    });

    // This attempt takes the only slot. With `open()` awaited bare it would hold it forever; with the
    // race it is released at the intake deadline.
    const wedgedAttempt = stager.stage(reference({ fileId: 'a' }), new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stager.inFlight.active).toBe(1);

    // These queue behind it. With the wedge in place their only way out is the queue-wait timeout.
    const first = stager.stage(reference({ fileId: 'b' }), new AbortController().signal);
    const second = stager.stage(reference({ fileId: 'c' }), new AbortController().signal);

    await expect(first).resolves.toEqual({ kind: 'refused', reason: 'timeout' });
    await expect(second).resolves.toEqual({ kind: 'refused', reason: 'timeout' });
    expect(stager.inFlight.waiting).toBe(0);

    // The load-bearing assertion: the wedge is RELEASED. Without the race on `open()`, `active` stays
    // 1 for the life of the stager and every later owner upload expires in the queue wait — one
    // signal-ignoring fetch permanently killing the owner's media path. Bounded by a wall clock so the
    // failure is an assertion rather than a suite timeout.
    const released = await Promise.race([
      wedgedAttempt,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('wedged slot was never released')), 1000)),
    ]);
    expect(released).toEqual({ kind: 'refused', reason: 'timeout' });
    expect(stager.inFlight.active).toBe(0);
    expect(listStaging(staging)).toEqual([]);
    // Each of the three attempts reached `open()` exactly once. Nothing retried in a loop, which is
    // what a wedged slot used to cause.
    expect(opens).toBe(3);
  });

  it('REFUSES (never throws) when the CALLER aborts while the attempt is waiting for a slot', async () => {
    // The reachable form of the same contract break. `awaitSlot` is handed the INTERNAL timeout
    // signal, but the caller's signal is bridged onto it (`onAbort = () => timeout.abort()`), so a
    // caller abort reaches `awaitSlot` too and rejects it.
    //
    // This matters in production because `Gateway.stop()` aborts the intake controller — so every
    // queued attempt in flight at shutdown took this path, and the rejection escaped `stage()`.
    const blocker = blockingSource();
    const stager = new FsMediaStager(blocker.source, staging, {
      limits: { maxFileBytes: 1024, intakeTimeoutMs: 60_000, maxActive: 1, maxWaiting: 2 },
    });

    const active = stager.stage(reference({ fileId: 'a' }), new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // A long intake budget, so ONLY the caller's abort can end this wait.
    const caller = new AbortController();
    const queued = stager.stage(reference({ fileId: 'b' }), caller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stager.inFlight).toEqual({ active: 1, waiting: 1 });

    caller.abort();

    // Awaited: a rejection fails this test instead of becoming an unhandled rejection.
    await expect(queued).resolves.toEqual({ kind: 'refused', reason: 'aborted' });
    expect(stager.inFlight.waiting).toBe(0);

    void active;
    void blocker;
  });

  it('cannot write a file when the intake wait expires mid-stream', async () => {
    const blocker = blockingSource();
    const stager = new FsMediaStager(blocker.source, staging, {
      limits: { maxFileBytes: 1024, intakeTimeoutMs: 40, maxActive: 1, maxWaiting: 1 },
    });

    const result = await stager.stage(reference(), new AbortController().signal);

    expect(result).toEqual({ kind: 'refused', reason: 'timeout' });
    // The critical assertion: a timed-out intake leaves nothing on disk at all.
    expect(listStaging(staging)).toEqual([]);
    expect(blocker.cancels).toBeGreaterThan(0);
  });

  it('cannot write a file when the caller aborts intake', async () => {
    const blocker = blockingSource();
    const stager = new FsMediaStager(blocker.source, staging, {
      limits: { maxFileBytes: 1024, intakeTimeoutMs: 60_000, maxActive: 1, maxWaiting: 1 },
    });

    const controller = new AbortController();
    const pending = stager.stage(reference(), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    const result = await pending;
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('unreachable');
    expect(result.reason).toBe('aborted');
    expect(listStaging(staging)).toEqual([]);
  });

  it('cancels a source that finishes opening after intake already expired', async () => {
    let openCalls = 0;
    let cancels = 0;
    const slowSource: MediaSourcePort = {
      open: async (): Promise<OpenedMedia> => {
        openCalls += 1;
        // The open itself outlives the intake budget: a late completion must not stream.
        await new Promise((resolve) => setTimeout(resolve, 120));
        return {
          chunks: {
            // eslint-disable-next-line @typescript-eslint/require-await
            async *[Symbol.asyncIterator]() {
              yield new Uint8Array(1024);
            },
          },
          cancel: async () => { cancels += 1; },
        };
      },
    };
    const stager = new FsMediaStager(slowSource, staging, {
      limits: { maxFileBytes: 1024, intakeTimeoutMs: 30, maxActive: 1, maxWaiting: 1 },
    });

    const result = await stager.stage(reference(), new AbortController().signal);

    expect(openCalls).toBe(1);
    // The refusal now arrives at the intake deadline (~30ms) instead of waiting out `open()` (~120ms),
    // because `open()` is raced against the abort signal. The late handle is cancelled by the losing
    // side's own cleanup, which necessarily happens AFTER the refusal — so wait for it to land before
    // asserting. This is the behavioural improvement: `stage()` no longer blocks on a source that
    // ignores its signal.
    expect(result).toEqual({ kind: 'refused', reason: 'timeout' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(cancels).toBe(1);
    expect(listStaging(staging)).toEqual([]);
  });

  it('cleans up only its own partial file and leaves a sibling staged file alone', async () => {
    const { source: slowSource } = streamingSource(64 * 1024);
    // A pre-existing staged file belonging to some earlier successful operation.
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const sibling = path.join(staging, 'earlier-operation-report.pdf');
    fs.writeFileSync(sibling, 'kept', { mode: 0o600 });

    const stager = new FsMediaStager(slowSource, staging, {
      limits: { maxFileBytes: 8, intakeTimeoutMs: 5_000, maxActive: 1, maxWaiting: 1 },
    });
    const result = await stager.stage(reference(), new AbortController().signal);

    expect(result).toEqual({ kind: 'refused', reason: 'too-large' });
    expect(listStaging(staging)).toEqual(['earlier-operation-report.pdf']);
    expect(fs.readFileSync(sibling, 'utf8')).toBe('kept');
  });

  it('reports a bounded, identifier-free diagnostic per attempt', async () => {
    const outcomes: DiagnosticEvent[] = [];
    const { source } = streamingSource(1024);
    const stager = new FsMediaStager(source, staging, {
      diagnostics: { emit: (event) => outcomes.push(event) },
    });

    await stager.stage(reference(), new AbortController().signal);
    await stager.stage(reference({ kind: 'video' as unknown as MediaReference['kind'] }), new AbortController().signal);

    // One event per attempt, each naming its stage and carrying a measured duration. The old channel
    // could not say which operation produced an event, nor how long it took.
    expect(outcomes).toEqual([
      { stage: 'media-intake', outcome: 'saved', bytes: 1024, durationMs: expect.any(Number) },
      { stage: 'media-intake', outcome: 'refused', reason: 'unsupported', durationMs: expect.any(Number) },
    ]);
    // No chat, sender, file id, filename or URL in the diagnostic channel.
    const serialised = JSON.stringify(outcomes);
    expect(serialised).not.toContain('report.pdf');
    expect(serialised).not.toContain('file-1');
  });

  it('reports a source failure without leaking a URL or token into the sanitized log', async () => {
    const logs: string[] = [];
    const leakySource: MediaSourcePort = {
      open: async () => {
        throw new Error('GET https://api.telegram.org/file/bot123:SECRET/documents/a.pdf failed');
      },
    };
    const stager = new FsMediaStager(leakySource, staging, { log: (message) => logs.push(message) });

    const result: MediaStageResult = await stager.stage(reference(), new AbortController().signal);

    expect(result).toEqual({ kind: 'refused', reason: 'source-failed' });
    const joined = logs.join('\n');
    expect(joined).not.toContain('SECRET');
    expect(joined).not.toContain('api.telegram.org');
    expect(joined).toContain('source-failed');
  });
});

/** Controlled external waits; production source, queue, pipeline and filesystem remain real. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settleContinuations(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function responseWithBytes(text = 'allowed streamed bytes'): Response {
  const bytes = Buffer.from(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes.subarray(0, 7));
      controller.enqueue(bytes.subarray(7));
      controller.close();
    },
  }));
}

describe('Telegram retrieval and real disk staging share one lifetime (C07)', () => {
  let root: string;
  let staging: string;

  beforeEach(() => {
    root = makeTestTemp('c07-telegram-lifetime');
    staging = path.join(root, 'media-staging');
    fs.mkdirSync(staging, { mode: 0o700 });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    removeTestTemp(root);
  });

  async function savedControl(stager: FsMediaStager): Promise<string[]> {
    const before = listStaging(staging);
    const saved = await stager.stage(reference({ fileId: 'retry' }), new AbortController().signal);
    expect(saved.kind).toBe('saved');
    if (saved.kind !== 'saved') throw new Error('positive control refused');
    expect(fs.readFileSync(saved.absolutePath, 'utf8')).toBe('allowed streamed bytes');
    expect(fs.statSync(saved.absolutePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(staging).mode & 0o777).toBe(0o700);
    expect(listStaging(staging)).toEqual([...before, path.basename(saved.absolutePath)].sort());
    return listStaging(staging);
  }

  it.each(['deadline', 'caller'] as const)('late metadata after %s cannot start a body fetch; the same lane retries', async (cause) => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    const metadata = deferred<{ file_path: string }>();
    const entered = deferred<void>();
    const metadataSignals: (AbortSignal | undefined)[] = [];
    const fetchSignals: AbortSignal[] = [];
    const fetchEntryStates: boolean[] = [];
    const outcomes: DiagnosticEvent[] = [];
    const source = new TelegramMediaSource({
      token: 'synthetic-token',
      api: { getFile: async (id: string, signal?: AbortSignal): Promise<{ file_path: string }> => {
        metadataSignals.push(signal);
        if (id === 'retry') return { file_path: 'files/retry' };
        entered.resolve();
        return metadata.promise;
      } },
      fetchImpl: async (_url, signal): Promise<Response> => {
        fetchEntryStates.push(signal.aborted);
        fetchSignals.push(signal);
        return responseWithBytes();
      },
    });
    const stager = new FsMediaStager(source, staging, {
      limits: { ...DEFAULT_MEDIA_LIMITS, intakeTimeoutMs: 25 },
      diagnostics: { emit: (event): void => { outcomes.push(event); } },
    });
    const caller = new AbortController();
    const pending = stager.stage(reference(), caller.signal);
    await entered.promise;
    expect(stager.inFlight).toEqual({ active: 1, waiting: 0 });
    expect(fetchSignals).toHaveLength(0);
    if (cause === 'deadline') await jest.advanceTimersByTimeAsync(25);
    else caller.abort();
    const refused = await pending;
    expect(stager.inFlight).toEqual({ active: 0, waiting: 0 });
    expect(listStaging(staging)).toEqual([]);
    metadata.resolve({ file_path: 'files/late' });
    await settleContinuations();
    const lateFetchStates = [...fetchEntryStates];
    expect(listStaging(staging)).toEqual([]);
    jest.useRealTimers();
    await savedControl(stager);
    // Decisive RED: received source starts one fetch with a fresh, non-aborted signal.
    expect(lateFetchStates).toEqual([]);
    expect(metadataSignals[0]?.aborted).toBe(true);
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
    expect(getEventListeners(metadataSignals[0]!, 'abort')).toEqual([]);
    expect(refused).toEqual({ kind: 'refused', reason: cause === 'deadline' ? 'timeout' : 'aborted' });
    expect(outcomes).toHaveLength(2);
    if (cause === 'deadline') expect(outcomes[0]).toMatchObject({ durationMs: 25 });
  });

  it('pre-aborted intake and standalone open perform no metadata/body/write, followed by a saved control', async () => {
    const getFile = jest.fn(async () => ({ file_path: 'files/allowed' }));
    const fetchImpl = jest.fn(async () => responseWithBytes());
    const source = new TelegramMediaSource({ token: 'synthetic-token', api: { getFile }, fetchImpl });
    const stager = new FsMediaStager(source, staging);
    const caller = new AbortController();
    caller.abort();
    const refused = await stager.stage(reference(), caller.signal);
    const opened = await source.open(reference(), caller.signal).catch(() => undefined);
    await opened?.cancel();
    const metadataCalls = getFile.mock.calls.length;
    const fetchCalls = fetchImpl.mock.calls.length;
    const entries = listStaging(staging);
    await savedControl(stager);
    expect(metadataCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(entries).toEqual([]);
    expect(opened).toBeUndefined();
    expect(refused).toEqual({ kind: 'refused', reason: 'aborted' });
  });

  it('a late fetch response is cancelled without opening a reader or writing; retry still streams', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    const fetched = deferred<Response>();
    const entered = deferred<void>();
    const cancelled = jest.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const reader = jest.spyOn(body, 'getReader');
    let attempts = 0;
    const source = new TelegramMediaSource({
      token: 'synthetic-token', api: { getFile: async (): Promise<{ file_path: string }> => ({ file_path: 'files/held' }) },
      fetchImpl: async (): Promise<Response> => {
        attempts += 1;
        if (attempts > 1) return responseWithBytes();
        entered.resolve();
        return fetched.promise;
      },
    });
    const stager = new FsMediaStager(source, staging, { limits: { ...DEFAULT_MEDIA_LIMITS, intakeTimeoutMs: 25 } });
    const pending = stager.stage(reference(), new AbortController().signal);
    await entered.promise;
    await jest.advanceTimersByTimeAsync(25);
    expect(await pending).toEqual({ kind: 'refused', reason: 'timeout' });
    fetched.resolve(new Response(body));
    await settleContinuations();
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(reader).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
    expect(listStaging(staging)).toEqual([]);
    jest.useRealTimers();
    await savedControl(stager);
  });

  it('source timeout during a real held reader refuses truncated bytes and releases the reader, then retries', async () => {
    const reading = deferred<void>();
    const releaseBody = deferred<void>();
    const cancelled = jest.fn(() => { releaseBody.resolve(); });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        pulls += 1;
        if (pulls === 1) controller.enqueue(Buffer.from('partial'));
        else { reading.resolve(); await releaseBody.promise; }
      },
      cancel: cancelled,
    });
    let attempts = 0;
    const source = new TelegramMediaSource({
      token: 'synthetic-token', timeoutMs: 100_000,
      api: { getFile: async (): Promise<{ file_path: string }> => ({ file_path: 'files/held' }) },
      fetchImpl: async (): Promise<Response> => ++attempts === 1 ? new Response(body) : responseWithBytes(),
    });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    const stager = new FsMediaStager(source, staging, { limits: { ...DEFAULT_MEDIA_LIMITS, intakeTimeoutMs: 200_000 } });
    const pending = stager.stage(reference(), new AbortController().signal);
    await reading.promise;
    expect(body.locked).toBe(true);
    await jest.advanceTimersByTimeAsync(100_000);
    const result = await pending;
    const entries = listStaging(staging);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    jest.useRealTimers();
    await savedControl(stager);
    expect(result).toEqual({ kind: 'refused', reason: 'source-failed' });
    expect(entries).toEqual([]);
  });

  it('one active/four waiting retain queue time in their deadline, settle late rejection, and accept a retry', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    const metadata = deferred<{ file_path: string }>();
    const opens: string[] = [];
    const fetches = jest.fn(async () => responseWithBytes());
    const outcomes: DiagnosticEvent[] = [];
    const source = new TelegramMediaSource({ token: 'synthetic-token',
      api: { getFile: async (id): Promise<{ file_path: string }> => {
        opens.push(id);
        return id === 'retry' ? { file_path: 'files/retry' } : metadata.promise;
      } }, fetchImpl: fetches,
    });
    const stager = new FsMediaStager(source, staging, {
      limits: { ...DEFAULT_MEDIA_LIMITS, intakeTimeoutMs: 25 },
      diagnostics: { emit: (event): void => { outcomes.push(event); } },
    });
    const active = stager.stage(reference({ fileId: 'active' }), new AbortController().signal);
    expect(opens).toEqual(['active']);
    await jest.advanceTimersByTimeAsync(10);
    const waiting = Array.from({ length: 4 }, (_unused, i) =>
      stager.stage(reference({ fileId: `waiting-${i}` }), new AbortController().signal));
    expect(stager.inFlight).toEqual({ active: 1, waiting: 4 });
    expect(await stager.stage(reference({ fileId: 'overflow' }), new AbortController().signal))
      .toEqual({ kind: 'refused', reason: 'queue-full' });
    expect(opens).toEqual(['active']);
    await jest.advanceTimersByTimeAsync(15);
    expect(await active).toEqual({ kind: 'refused', reason: 'timeout' });
    expect(opens).toEqual(['active', 'waiting-0']);
    expect(stager.inFlight).toEqual({ active: 1, waiting: 3 });
    await jest.advanceTimersByTimeAsync(10);
    expect(await Promise.all(waiting)).toEqual(Array.from({ length: 4 }, () => ({ kind: 'refused', reason: 'timeout' })));
    expect(stager.inFlight).toEqual({ active: 0, waiting: 0 });
    // A rejecting external loser is observed too; it cannot become an unhandled rejection.
    metadata.reject(new Error('synthetic external failure'));
    await settleContinuations();
    expect(fetches).not.toHaveBeenCalled();
    expect(listStaging(staging)).toEqual([]);
    expect(outcomes.filter(event => event.stage === 'media-intake' && event.outcome === 'refused' && event.reason === 'timeout'))
      .toEqual(Array.from({ length: 5 }, () => ({ stage: 'media-intake', outcome: 'refused', reason: 'timeout', durationMs: 25 })));
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
    await savedControl(stager);
    expect(outcomes).toHaveLength(7);
  });

  it('the source budget starts before metadata and is not reset for body consumption', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    const metadata = deferred<{ file_path: string }>();
    const reading = deferred<void>();
    const releaseBody = deferred<void>();
    let attempts = 0;
    let retrievalSignal: AbortSignal | undefined;
    const source = new TelegramMediaSource({ token: 'synthetic-token', timeoutMs: 25,
      api: { getFile: async (id): Promise<{ file_path: string }> => id === 'retry' ? { file_path: 'files/retry' } : metadata.promise },
      fetchImpl: async (_url, signal): Promise<Response> => {
        retrievalSignal = signal;
        if (++attempts > 1) return responseWithBytes();
        let pulls = 0;
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller): Promise<void> {
            if (++pulls === 1) controller.enqueue(Buffer.from('partial'));
            else { reading.resolve(); await releaseBody.promise; }
          },
          cancel(): void { releaseBody.resolve(); },
        }));
      },
    });
    const stager = new FsMediaStager(source, staging, { limits: { ...DEFAULT_MEDIA_LIMITS, intakeTimeoutMs: 100 } });
    const pending = stager.stage(reference(), new AbortController().signal);
    await jest.advanceTimersByTimeAsync(15);
    metadata.resolve({ file_path: 'files/held' });
    await reading.promise;
    await jest.advanceTimersByTimeAsync(10);
    const abortedAtDeadline = retrievalSignal?.aborted;
    // Settle the controlled loser even on an inverse, so failure is an assertion, not a timeout.
    await jest.advanceTimersByTimeAsync(75);
    const result = await pending;
    releaseBody.resolve();
    const entries = listStaging(staging);
    jest.useRealTimers();
    await savedControl(stager);
    expect(abortedAtDeadline).toBe(true);
    expect(result).toEqual({ kind: 'refused', reason: 'source-failed' });
    expect(entries).toEqual([]);
  });

  it('abort retains the intake slot until its held filesystem open closes and its partial is removed', async () => {
    const opening = deferred<void>();
    const closed = deferred<void>();
    let finishOpen!: () => void;
    const createWriteStream = fsModule.createWriteStream;
    jest.spyOn(fsModule, 'createWriteStream').mockImplementationOnce((target, options) => {
      if (typeof options === 'string') throw new Error('unexpected encoding option');
      const stream = createWriteStream(target, { ...options, fs: {
        ...fsModule,
        open: ((...args: unknown[]) => {
          finishOpen = (): void => { Reflect.apply(fsModule.open, fsModule, args); };
          opening.resolve();
        }) as typeof fsModule.open,
      } });
      stream.once('close', () => { closed.resolve(); });
      return stream;
    });
    let attempts = 0;
    const source = new TelegramMediaSource({ token: 'synthetic-token',
      api: { getFile: async (): Promise<{ file_path: string }> => ({ file_path: 'files/held' }) },
      fetchImpl: async (): Promise<Response> => ++attempts === 1
        ? new Response(new ReadableStream<Uint8Array>()) : responseWithBytes(),
    });
    const stager = new FsMediaStager(source, staging);
    const caller = new AbortController();
    let settled = false;
    const pending = stager.stage(reference(), caller.signal).then(result => { settled = true; return result; });
    await opening.promise;
    caller.abort();
    await settleContinuations();
    const settledBeforeOwnedClose = settled;
    const inFlightBeforeOwnedClose = stager.inFlight;
    finishOpen();
    const result = await pending;
    await closed.promise;
    const entries = listStaging(staging);
    await savedControl(stager);
    expect(entries).toEqual([]);
    expect(settledBeforeOwnedClose).toBe(false);
    expect(inFlightBeforeOwnedClose).toEqual({ active: 1, waiting: 0 });
    expect(result).toEqual({ kind: 'refused', reason: 'aborted' });
  });
});
