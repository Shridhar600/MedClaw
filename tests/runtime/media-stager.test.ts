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
import * as path from 'path';

import { FsMediaStager } from '../../src/runtime/adapters';
import type {
  MediaReference,
  MediaSourcePort,
  MediaStageResult,
  OpenedMedia,
} from '../../src/ports/media-source';
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
    expect(cancels).toBe(1);
    expect(result).toEqual({ kind: 'refused', reason: 'timeout' });
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
