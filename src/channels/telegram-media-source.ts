
import type { MediaReference, MediaSourcePort, OpenedMedia } from '../ports';
import { MEDIA_MAX_FILE_BYTES, MEDIA_INTAKE_TIMEOUT_MS } from '../ports';
import { summarizeErrorForLog } from '../security';
import type { Api } from 'grammy';

export interface TelegramFileApi {
  /** Resolve a transport file id to its Bot API path plus the transport's size claim. */
  getFile(fileId: string, signal?: AbortSignal | Parameters<Api['getFile']>[1]): Promise<{ file_path?: string; file_size?: number }>;
}

/** Fetches one attachment body. Injectable so tests never touch the network. */
export type TelegramFileFetcher = (url: string, signal: AbortSignal) => Promise<Response>;

export interface TelegramMediaSourceOptions {
  /** Bot token. Used only to build the download URL; never logged and never persisted. */
  token: string;
  api: TelegramFileApi;
  fetchImpl?: TelegramFileFetcher;
  /** Per-attempt deadline for the whole retrieval, in addition to the caller's abort signal. */
  timeoutMs?: number;
}

export class TelegramMediaSource implements MediaSourcePort {
  private readonly token: string;
  private readonly api: TelegramFileApi;
  private readonly fetchImpl: TelegramFileFetcher;
  private readonly timeoutMs: number;

  constructor(options: TelegramMediaSourceOptions) {
    this.token = options.token;
    this.api = options.api;
    this.fetchImpl = options.fetchImpl ?? ((url, signal) => fetch(url, { signal }));
    this.timeoutMs = options.timeoutMs ?? MEDIA_INTAKE_TIMEOUT_MS;
  }

  async open(ref: MediaReference, signal: AbortSignal): Promise<OpenedMedia> {
    throwIfAborted(signal);
    if (ref.channel !== 'telegram') {
      throw new Error(`unsupported media channel: ${ref.channel}`);
    }

    const advertised = ref.advertisedBytes;
    if (typeof advertised === 'number' && advertised > MEDIA_MAX_FILE_BYTES) {
      throw new OversizedMediaError();
    }

    const controller = new AbortController();
    let body: ReadableStream<Uint8Array> | undefined;
    const release = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (!controller.signal.aborted) {
        controller.abort();
        // A locked body is owned by streamToChunks, whose abort listener cancels its reader.
        if (body && !body.locked) void body.cancel().catch(() => undefined);
      }
      release();
    };
    const timer = setTimeout(onAbort, this.timeoutMs);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      if (signal.aborted) onAbort();
      throwIfAborted(controller.signal);
      const file = await withinLifetime(this.api.getFile(ref.fileId, controller.signal), controller.signal);
      throwIfAborted(controller.signal);
      if (typeof file.file_path !== 'string' || file.file_path.length === 0) {
        throw new Error('telegram media lookup returned no file path');
      }
      const apiSize = typeof file.file_size === 'number' ? file.file_size : undefined;
      const effectiveAdvertised = apiSize ?? advertised;
      if (typeof effectiveAdvertised === 'number' && effectiveAdvertised > MEDIA_MAX_FILE_BYTES) {
        throw new OversizedMediaError();
      }
      const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
      const fetching = this.fetchImpl(url, controller.signal).then(response => {
        if (controller.signal.aborted) {
          if (response.body) void response.body.cancel().catch(() => undefined);
          throwIfAborted(controller.signal);
        }
        return response;
      });
      const response = await withinLifetime(fetching, controller.signal);
      body = response.body ?? undefined;
      throwIfAborted(controller.signal);
      if (!response.ok || !body) {
        throw new Error('telegram media fetch returned an unusable response');
      }
      return {
        advertisedBytes: effectiveAdvertised,
        chunks: streamToChunks(body, controller.signal, release),
        cancel: async (): Promise<void> => { onAbort(); },
      };
    } catch (error) {
      onAbort();
      if (error instanceof OversizedMediaError) throw error;
      throw new Error(`telegram media retrieval failed: ${summarizeErrorForLog(error)}`);
    }
  }
}

export class OversizedMediaError extends Error {
  constructor() {
    super('advertised attachment size exceeds the per-file limit');
    this.name = 'OversizedMediaError';
  }
}

async function* streamToChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  release: () => void,
): AsyncGenerator<Uint8Array, void, undefined> {
  throwIfAborted(signal);
  const reader = body.getReader();
  let completed = false;
  let cancelled = false;
  const onAbort = (): void => {
    if (!cancelled) {
      cancelled = true;
      void reader.cancel().catch(() => undefined);
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      // reader.cancel() resolves a pending read as done. That is an aborted upload, not EOF.
      throwIfAborted(signal);
      if (done) { completed = true; return; }
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!completed) onAbort();
    reader.releaseLock();
    release();
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('telegram media retrieval aborted');
  error.name = 'AbortError';
  throw error;
}

/** Observe external losers and detach our listener when either outcome settles. */
async function withinLifetime<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
