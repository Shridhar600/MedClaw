// src/channels/telegram-media-source.ts
//
// The production `MediaSourcePort`: retrieves Telegram attachment bytes AFTER admission.
//
// This is the adapter that makes T4's media path real. Until it existed, `src/` contained no
// `MediaSourcePort` implementation at all, so every attachment was refused with "Attachments cannot be
// accepted by this installation right now" — while the transport quietly substituted placeholder text
// ("Sent a photo") that reached the model as if it were the whole message.
//
// Three properties this must have, and why:
//
// 1. **It is only ever reached after admission.** The Gateway calls it from `admitAndStage`, after
//    `admission.inspect()` has returned `owner`. Nothing in the channel calls it. That ordering is the
//    entire security value of the seam; this file must not be reachable from a message handler.
// 2. **It streams and never buffers whole.** `TelegramChannel.downloadFile` — the dead predecessor —
//    did `Buffer.from(await response.arrayBuffer())`, so a 10 MB cap was enforced only AFTER the whole
//    body was in memory. Here the body is a `ReadableStream` exposed as an `AsyncIterable`, and the
//    caller's byte counter is what stops it. A lying or absent `file_size` cannot get past it.
// 3. **It carries no authority.** The `fileId` is treated as opaque. It is never logged, never placed
//    in a path, and never used to build a filename.

import type { MediaReference, MediaSourcePort, OpenedMedia } from '../ports';
import { MEDIA_MAX_FILE_BYTES, MEDIA_INTAKE_TIMEOUT_MS } from '../ports';
import { summarizeErrorForLog } from '../security';
import type { Api } from 'grammy';

/**
 * The narrow slice of grammY's API this adapter needs. Keeps the adapter testable without a bot.
 *
 * `file_path` is optional because grammY's generated type says so, but the Bot API always returns it on
 * success — so it is treated as required here and a missing one is a `source-failed`, never a fetch
 * against `"undefined"`.
 */
export interface TelegramFileApi {
  /** Resolve a transport file id to its Bot API path plus the transport's size claim. */
  // grammY's Node declarations use its abort-controller shim. Its runtime consumes the standard
  // abort state/listener methods, so both that API and native-signal injected edges fit this seam.
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

    // The advertised size is a claim, not a guarantee. When it ALONE already exceeds the cap we refuse
    // before opening a stream, so an oversized attachment costs nothing.
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
    // This one timer covers metadata, body start and consumption. The caller's core timer also
    // includes queue wait, so this adapter can shorten the lifetime but can never extend it.
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
        // An injected fetch may ignore cancellation. Observe its loser and release a late body
        // without acquiring a reader, even after open() has already refused.
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
        // Cancellation is requested synchronously; an uncooperative external cancel promise is
        // observed, not allowed to hold the core's intake slot indefinitely.
        cancel: async (): Promise<void> => { onAbort(); },
      };
    } catch (error) {
      onAbort();
      if (error instanceof OversizedMediaError) throw error;
      throw new Error(`telegram media retrieval failed: ${summarizeErrorForLog(error)}`);
    }
  }
}

/**
 * A refused-too-large advertisement, distinguishable from a transport failure without parsing a message.
 *
 * The core checks the reference advertisement and actual streamed bytes separately. A failed
 * transport metadata lookup (including an unusable size claim) remains a source failure there.
 */
export class OversizedMediaError extends Error {
  constructor() {
    super('advertised attachment size exceeds the per-file limit');
    this.name = 'OversizedMediaError';
  }
}

/**
 * Expose a `ReadableStream` as the `AsyncIterable<Uint8Array>` the stager consumes.
 *
 * No buffering and no whole-body accumulation: each chunk is handed over as it arrives so the caller's
 * running byte total can stop the transfer at the cap. The reader is always released, so an early exit
 * at the cap does not leave the socket open.
 */
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
