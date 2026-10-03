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

import type { MediaReference, MediaSourcePort, OpenedMedia } from '../ports/media-source';
import { MEDIA_MAX_FILE_BYTES } from '../ports/media-source';
import { summarizeErrorForLog } from '../security';

/**
 * The narrow slice of grammY's API this adapter needs. Keeps the adapter testable without a bot.
 *
 * `file_path` is optional because grammY's generated type says so, but the Bot API always returns it on
 * success — so it is treated as required here and a missing one is a `source-failed`, never a fetch
 * against `"undefined"`.
 */
export interface TelegramFileApi {
  /** Resolve a transport file id to its Bot API path plus the transport's size claim. */
  getFile(fileId: string): Promise<{ file_path?: string; file_size?: number }>;
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

const DEFAULT_TIMEOUT_MS = 30_000;

export class TelegramMediaSource implements MediaSourcePort {
  private readonly token: string;
  private readonly api: TelegramFileApi;
  private readonly fetchImpl: TelegramFileFetcher;
  private readonly timeoutMs: number;

  constructor(options: TelegramMediaSourceOptions) {
    this.token = options.token;
    this.api = options.api;
    this.fetchImpl = options.fetchImpl ?? ((url, signal) => fetch(url, { signal }));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async open(ref: MediaReference, signal: AbortSignal): Promise<OpenedMedia> {
    if (ref.channel !== 'telegram') {
      throw new Error(`unsupported media channel: ${ref.channel}`);
    }

    // The advertised size is a claim, not a guarantee. When it ALONE already exceeds the cap we refuse
    // before opening a stream, so an oversized attachment costs nothing.
    const advertised = ref.advertisedBytes;
    if (typeof advertised === 'number' && advertised > MEDIA_MAX_FILE_BYTES) {
      throw new OversizedMediaError();
    }

    const file = await this.api.getFile(ref.fileId);
    if (typeof file.file_path !== 'string' || file.file_path.length === 0) {
      throw new Error('telegram media lookup returned no file path');
    }
    const apiSize = typeof file.file_size === 'number' ? file.file_size : undefined;
    const effectiveAdvertised = apiSize ?? advertised;
    if (typeof effectiveAdvertised === 'number' && effectiveAdvertised > MEDIA_MAX_FILE_BYTES) {
      throw new OversizedMediaError();
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Never hold the event loop open for a pending download.
    timer.unref?.();

    const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, controller.signal);
    } catch (error) {
      this.release(controller, signal, onAbort, timer);
      if (controller.signal.aborted) throw error;
      throw new Error(`telegram media fetch failed: ${summarizeErrorForLog(error)}`);
    }

    if (!response.ok || !response.body) {
      this.release(controller, signal, onAbort, timer);
      throw new Error(`telegram media fetch returned an unusable response (status ${response.status})`);
    }

    const body = response.body;
    const iterator = streamToChunks(body, controller.signal);

    return {
      advertisedBytes: effectiveAdvertised,
      chunks: iterator,
      cancel: async (): Promise<void> => {
        this.release(controller, signal, onAbort, timer);
        // Cancelling must also stop the transfer, not just our bookkeeping.
        try {
          await body.cancel();
        } catch {
          // The body may already be closed; cancelling is best-effort and must not throw into admission.
        }
      },
    };
  }

  private release(
    controller: AbortController,
    signal: AbortSignal,
    onAbort: () => void,
    timer: ReturnType<typeof setTimeout>,
  ): void {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    if (!controller.signal.aborted) controller.abort();
  }
}

/**
 * A refused-too-large advertisement, distinguishable from a transport failure without parsing a message.
 *
 * `FsMediaStager` maps a thrown `OverCapError` to `too-large`; anything else becomes `source-failed`.
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
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
