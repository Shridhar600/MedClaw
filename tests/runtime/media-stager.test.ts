// The bounded media path through the real `FsMediaStager`, a real streaming source and a real disk.
// Every assertion is about bytes on disk, the typed outcome, or what the staging directory is left holding.

import * as fs from 'fs';
import crypto from 'crypto';
import * as path from 'path';

import { FsMediaStager } from '../../src/runtime';
import { TelegramMediaSource } from '../../src/channels';
import type { MediaReference, MediaSourcePort, OpenedMedia } from '../../src/ports/media-source';
import { DEFAULT_MEDIA_LIMITS } from '../../src/ports/media-source';
import type { DiagnosticEvent } from '../../src/ports/diagnostics';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

const limits = (overrides: Partial<typeof DEFAULT_MEDIA_LIMITS>): typeof DEFAULT_MEDIA_LIMITS =>
  ({ ...DEFAULT_MEDIA_LIMITS, ...overrides });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function reference(overrides: Partial<MediaReference> = {}): MediaReference {
  return { channel: 'telegram', fileId: 'file-1', kind: 'document', displayName: 'report.pdf', ...overrides };
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

/** A source whose stream never produces a byte, for abort and timeout cases. */
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe('FsMediaStager: bounded streaming into owner-scoped staging', () => {
  let root: string;
  let staging: string;

  beforeEach(() => {
    root = makeTestTemp('stager');
    staging = path.join(root, 'state', 'profiles', 'default', '.state', 'media-staging');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  it('streams an upload to a 0600 file inside staging, whatever name the transport supplied', async () => {
    const { source } = streamingSource(300 * 1024);
    const stager = new FsMediaStager(source, staging, { trustedBaseDir: root });

    const result = await stager.stage(
      reference({ displayName: '../../../../etc/passwd' }),
      new AbortController().signal,
    );

    expect(result.kind).toBe('saved');
    if (result.kind !== 'saved') throw new Error('unreachable');
    expect(result.bytes).toBe(300 * 1024);
    expect(fs.statSync(result.absolutePath).size).toBe(300 * 1024);
    expect(fs.statSync(result.absolutePath).mode & 0o777).toBe(0o600);
    expect(path.dirname(result.absolutePath)).toBe(staging);
    expect(path.basename(result.absolutePath)).not.toContain('..');
    expect(listStaging(staging).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it.each(['missing-authority', 'outside', 'non-directory'] as const)(
    'refuses %s staging authority before any source or filesystem effect',
    async (shape) => {
      const stream = streamingSource(32, 8);
      const outside = path.join(root, 'outside');
      fs.mkdirSync(outside, { mode: 0o750 });
      fs.chmodSync(outside, 0o750);
      const sentinel = path.join(outside, 'sentinel');
      fs.writeFileSync(sentinel, 'outside bytes', { mode: 0o600 });
      const trusted = path.join(root, 'owner');
      fs.mkdirSync(trusted, { mode: 0o700 });
      const lane = shape === 'outside' ? path.join(outside, 'media-staging') : path.join(trusted, '.state', 'media-staging');
      if (shape === 'non-directory') fs.writeFileSync(path.join(trusted, '.state'), 'component bytes', { mode: 0o600 });
      const stager = new FsMediaStager(stream.source, lane, { trustedBaseDir: shape === 'missing-authority' ? undefined : trusted });

      const refused = await stager.stage(reference(), new AbortController().signal);

      expect(refused).toEqual({ kind: 'refused', reason: 'source-failed' });
      expect(stream.opens).toBe(0);
      expect(fs.existsSync(lane)).toBe(false);
      expect(fs.readdirSync(outside)).toEqual(['sentinel']);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside bytes');
      expect(fs.statSync(outside).mode & 0o777).toBe(0o750);
    },
  );

  it('opens no stream for an unsupported kind or an advertised size over the cap', async () => {
    const { source, opens } = streamingSource(1024);
    const stager = new FsMediaStager(source, staging, { trustedBaseDir: root, limits: limits({ maxFileBytes: 1024 }) });
    const signal = new AbortController().signal;

    expect(await stager.stage({ ...reference(), kind: 'video' as unknown as MediaReference['kind'] }, signal))
      .toEqual({ kind: 'refused', reason: 'unsupported' });
    expect(await stager.stage(undefined, signal)).toEqual({ kind: 'refused', reason: 'unsupported' });
    expect(await stager.stage(reference({ advertisedBytes: 5_000 }), signal))
      .toEqual({ kind: 'refused', reason: 'advertised-too-large' });

    expect(opens).toBe(0);
    expect(listStaging(staging)).toEqual([]);
  });

  it('stops an upload that lies about its size and removes only its own partial', async () => {
    const { source } = streamingSource(50 * 1024, 4096);
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const sibling = path.join(staging, 'earlier-report.pdf');
    fs.writeFileSync(sibling, 'kept', { mode: 0o600 });
    const stager = new FsMediaStager(source, staging, { trustedBaseDir: root, limits: limits({ maxFileBytes: 8 * 1024 }) });

    const result = await stager.stage(reference({ advertisedBytes: 100 }), new AbortController().signal);

    expect(result).toEqual({ kind: 'refused', reason: 'too-large' });
    expect(listStaging(staging)).toEqual(['earlier-report.pdf']);
    expect(fs.readFileSync(sibling, 'utf8')).toBe('kept');
  });

  it('refuses an empty stream rather than handing a zero-byte file onward', async () => {
    const { source } = streamingSource(0);
    const stager = new FsMediaStager(source, staging, { trustedBaseDir: root });

    expect(await stager.stage(reference(), new AbortController().signal))
      .toEqual({ kind: 'refused', reason: 'source-failed' });
    expect(listStaging(staging)).toEqual([]);
  });

  it('leaves nothing on disk when the caller aborts, before or during the stream', async () => {
    const blocker = blockingSource();
    const stager = new FsMediaStager(blocker.source, staging, { trustedBaseDir: root, limits: limits({ intakeTimeoutMs: 60_000 }) });

    const early = new AbortController();
    early.abort();
    expect(await stager.stage(reference(), early.signal)).toEqual({ kind: 'refused', reason: 'aborted' });

    const controller = new AbortController();
    const pending = stager.stage(reference(), controller.signal);
    await sleep(10);
    controller.abort();

    expect(await pending).toEqual({ kind: 'refused', reason: 'aborted' });
    expect(listStaging(staging)).toEqual([]);
    expect(blocker.cancels).toBeGreaterThan(0);
  });

  it('times out a stalled stream and a source that ignores its signal, then accepts the next upload', async () => {
    const good = streamingSource(1024);
    let opens = 0;
    const source: MediaSourcePort = {
      open: (ref, signal) => {
        opens += 1;
        // Neither the first (never settles) nor the second (stalled stream) honours the signal.
        if (opens === 1) return new Promise<OpenedMedia>(() => { /* wedged open */ });
        if (opens === 2) return blockingSource().source.open(ref, signal);
        return good.source.open(ref, signal);
      },
    };
    const stager = new FsMediaStager(source, staging, { trustedBaseDir: root, limits: limits({ intakeTimeoutMs: 40 }) });

    expect(await stager.stage(reference(), new AbortController().signal)).toEqual({ kind: 'refused', reason: 'timeout' });
    expect(await stager.stage(reference(), new AbortController().signal)).toEqual({ kind: 'refused', reason: 'timeout' });
    expect(listStaging(staging)).toEqual([]);

    const saved = await stager.stage(reference(), new AbortController().signal);
    expect(saved.kind).toBe('saved');
  });

  it('refuses a second upload while one is staging, before opening a stream, and recovers afterwards', async () => {
    const gate = deferred<void>();
    let opens = 0;
    const source: MediaSourcePort = {
      open: async (): Promise<OpenedMedia> => {
        opens += 1;
        return {
          chunks: (async function* (): AsyncGenerator<Uint8Array> { await gate.promise; yield Buffer.from('bytes'); })(),
          cancel: async () => undefined,
        };
      },
    };
    const stager = new FsMediaStager(source, staging, { trustedBaseDir: root });

    const first = stager.stage(reference(), new AbortController().signal);
    await sleep(10);
    const second = await stager.stage(reference({ fileId: 'file-2' }), new AbortController().signal);

    expect(second).toEqual({ kind: 'refused', reason: 'queue-full' });
    expect(opens).toBe(1);

    gate.resolve();
    expect((await first).kind).toBe('saved');
    expect((await stager.stage(reference(), new AbortController().signal)).kind).toBe('saved');
  });

  it.each(['partial', 'final'] as const)('a name collision on the %s file keeps the earlier bytes', async (shape) => {
    const stream = streamingSource(32, 8);
    const stager = new FsMediaStager(stream.source, staging, { trustedBaseDir: root });
    const identity = jest.spyOn(crypto, 'randomUUID').mockReturnValue('12345678-1234-4234-8234-123456789abc');
    try {
      const first = await stager.stage(reference(), new AbortController().signal);
      if (first.kind !== 'saved') throw new Error('collision fixture did not stage');
      const existing = shape === 'partial' ? `${first.absolutePath}.part` : first.absolutePath;
      if (shape === 'partial') fs.renameSync(first.absolutePath, existing);
      fs.writeFileSync(existing, 'earlier owned bytes', { mode: 0o600 });

      const refused = await stager.stage(reference(), new AbortController().signal);

      expect(refused).toEqual({ kind: 'refused', reason: 'source-failed' });
      expect(fs.readFileSync(existing, 'utf8')).toBe('earlier owned bytes');
      identity.mockRestore();
      expect((await stager.stage(reference(), new AbortController().signal)).kind).toBe('saved');
    } finally {
      identity.mockRestore();
    }
  });

  it('reports one identifier-free diagnostic per attempt and keeps URLs and tokens out of the log', async () => {
    const outcomes: DiagnosticEvent[] = [];
    const logs: string[] = [];
    const leaky: MediaSourcePort = {
      open: async () => { throw new Error('GET https://api.telegram.org/file/bot123:SECRET/documents/a.pdf failed'); },
    };
    const diagnostics = { emit: (event: DiagnosticEvent): void => { outcomes.push(event); } };
    const saved = new FsMediaStager(streamingSource(1024).source, staging, { trustedBaseDir: root, diagnostics });
    const failing = new FsMediaStager(leaky, staging, { trustedBaseDir: root, diagnostics, log: (message) => logs.push(message) });

    await saved.stage(reference(), new AbortController().signal);
    await failing.stage(reference(), new AbortController().signal);

    expect(outcomes).toEqual([
      { stage: 'media-intake', outcome: 'saved', bytes: 1024, durationMs: expect.any(Number) },
      { stage: 'media-intake', outcome: 'refused', reason: 'source-failed', durationMs: expect.any(Number) },
    ]);
    const everything = JSON.stringify(outcomes) + logs.join('\n');
    for (const secret of ['report.pdf', 'file-1', 'SECRET', 'api.telegram.org']) expect(everything).not.toContain(secret);
    expect(logs.join('\n')).toContain('source-failed');
  });
});

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

describe('FsMediaStager over the Telegram source: a timed-out or aborted intake cannot fetch or write late', () => {
  let root: string;
  let staging: string;

  beforeEach(() => {
    root = makeTestTemp('stager-telegram');
    staging = path.join(root, 'media-staging');
    fs.mkdirSync(staging, { mode: 0o700 });
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  async function expectStagedControl(stager: FsMediaStager): Promise<void> {
    const saved = await stager.stage(reference({ fileId: 'retry' }), new AbortController().signal);
    if (saved.kind !== 'saved') throw new Error('positive control refused');
    expect(fs.readFileSync(saved.absolutePath, 'utf8')).toBe('allowed streamed bytes');
    expect(fs.statSync(saved.absolutePath).mode & 0o777).toBe(0o600);
    expect(listStaging(staging)).toEqual([path.basename(saved.absolutePath)]);
  }

  it.each(['deadline', 'caller'] as const)('late metadata after %s starts no body fetch; the lane then stages again', async (cause) => {
    const metadata = deferred<{ file_path: string }>();
    const entered = deferred<void>();
    let fetches = 0;
    const source = new TelegramMediaSource({
      token: 'synthetic-token',
      api: { getFile: async (id: string): Promise<{ file_path: string }> => {
        if (id === 'retry') return { file_path: 'files/retry' };
        entered.resolve();
        return metadata.promise;
      } },
      fetchImpl: async (): Promise<Response> => { fetches += 1; return responseWithBytes(); },
    });
    const stager = new FsMediaStager(source, staging, { trustedBaseDir: root, limits: limits({ intakeTimeoutMs: 40 }) });
    const caller = new AbortController();

    const pending = stager.stage(reference(), caller.signal);
    await entered.promise;
    if (cause === 'caller') caller.abort();
    const refused = await pending;
    metadata.resolve({ file_path: 'files/late' });
    await sleep(20);

    expect(refused).toEqual({ kind: 'refused', reason: cause === 'deadline' ? 'timeout' : 'aborted' });
    expect(fetches).toBe(0);
    expect(listStaging(staging)).toEqual([]);
    await expectStagedControl(stager);
  });

  it('cancels a fetch response that arrives after the deadline without reading it', async () => {
    const fetched = deferred<Response>();
    const entered = deferred<void>();
    const cancelled = jest.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    let attempts = 0;
    const source = new TelegramMediaSource({
      token: 'synthetic-token',
      api: { getFile: async (): Promise<{ file_path: string }> => ({ file_path: 'files/held' }) },
      fetchImpl: async (): Promise<Response> => {
        if (++attempts > 1) return responseWithBytes();
        entered.resolve();
        return fetched.promise;
      },
    });
    const stager = new FsMediaStager(source, staging, { trustedBaseDir: root, limits: limits({ intakeTimeoutMs: 40 }) });

    const pending = stager.stage(reference(), new AbortController().signal);
    await entered.promise;
    expect(await pending).toEqual({ kind: 'refused', reason: 'timeout' });
    fetched.resolve(new Response(body));
    await sleep(20);

    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(listStaging(staging)).toEqual([]);
    await expectStagedControl(stager);
  });

  it('a body that stalls mid-stream is refused as truncated, its reader released, and the lane stays usable', async () => {
    const releaseBody = deferred<void>();
    const cancelled = jest.fn(() => { releaseBody.resolve(); });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        if (++pulls === 1) controller.enqueue(Buffer.from('partial'));
        else await releaseBody.promise;
      },
      cancel: cancelled,
    });
    let attempts = 0;
    const source = new TelegramMediaSource({
      token: 'synthetic-token',
      timeoutMs: 60,
      api: { getFile: async (): Promise<{ file_path: string }> => ({ file_path: 'files/held' }) },
      fetchImpl: async (): Promise<Response> => ++attempts === 1 ? new Response(body) : responseWithBytes(),
    });
    const stager = new FsMediaStager(source, staging, { trustedBaseDir: root, limits: limits({ intakeTimeoutMs: 5_000 }) });

    const result = await stager.stage(reference(), new AbortController().signal);

    expect(result).toEqual({ kind: 'refused', reason: 'source-failed' });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(listStaging(staging)).toEqual([]);
    await expectStagedControl(stager);
  });
});
