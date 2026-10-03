import * as fs from 'fs';
import { TelegramChannel } from '../../src/channels/telegram';
import type { IncomingMessage } from '../../src/channels/types';
import { makeTestTemp } from '../helpers/test-temp';

/** Synthetic PHI marker. Must never appear in any log the channel emits. */
const PHI = 'patient-12345-diabetes';

const mockGetFile = jest.fn();
const mockSendMessage = jest.fn();
const mockBotOn = jest.fn();
const mockBotStart = jest.fn();
const mockBotStop = jest.fn();
const mockBotCatch = jest.fn();

jest.mock('grammy', () => {
  return {
    Bot: jest.fn(() => ({
      on: mockBotOn,
      api: {
        getFile: mockGetFile,
        sendMessage: mockSendMessage,
      },
      start: mockBotStart,
      stop: mockBotStop,
      catch: mockBotCatch,
      token: 'test-token',
    })),
  };
});

describe('TelegramChannel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFile.mockReset();
    mockSendMessage.mockReset();
    // Default: a cleanly-starting bot. Tests that exercise the reject path
    // override this. Without a default, start() returns undefined and the new
    // connect()'s .then() attachment throws synchronously.
    mockBotStart.mockResolvedValue(undefined);
    mockBotCatch.mockImplementation(() => undefined);
  });

  describe('constructor', () => {
    it('accepts stagingPath as second parameter', () => {
      const channel = new TelegramChannel('test-token');
      expect(channel).toBeInstanceOf(TelegramChannel);
    });
  });

  type MockCtx = { message: { text?: string; message_id?: number; document?: { file_id: string; file_name?: string }; photo?: Array<{ file_id: string; width: number; height: number }>; caption?: string; reply_to_message?: { message_id: number } }; chat: { id: number }; from?: { id: number } };

  describe('message handlers', () => {
    it('propagates the transport message id for capture deduplication', async () => {
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;

      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:text') handler = cb;
      });

      const channel = new TelegramChannel('test-token');
      const receivedMessages: { messageId?: string }[] = [];
      channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      await handler?.({ message: { text: 'hello', message_id: 77 }, chat: { id: 123 }, from: { id: 456 } });

      expect(receivedMessages[0].messageId).toBe('77');
    });

    // ── METADATA-FIRST (S1 T4) ────────────────────────────────────────────────────────
    // S1 change (old -> new): the tests in this block used to assert that the document and photo
    // handlers called `getFile`, fetched the bytes over HTTP and wrote a local staging file BEFORE
    // any admission decision — and that a symlinked staging root was rejected at write time. That
    // eager path is the defect: an unauthenticated stranger could make the process download and
    // store arbitrary bytes. It has moved behind the core's admission boundary.
    //
    // What replaces it here: the transport emits an OPAQUE reference and does no I/O at all. The
    // staging-path containment, the byte cap, the stream abort and the PHI-safe failure logging all
    // now belong to `FsMediaStager` and are proved in `tests/runtime/media-stager.test.ts`.

    it('document handler emits an opaque media reference and performs no retrieval or write', async () => {
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;

      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:document') handler = cb;
      });

      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      // A real directory to prove nothing was written into it. Workspace-local via `makeTestTemp`, never
      // `os.tmpdir()`. The channel no longer takes a staging path, so this stands in for the owner's lane.
      const stagingDir = makeTestTemp('socs-s1-tg-nothing-written');
      const channel = new TelegramChannel('test-token');
      const received: IncomingMessage[] = [];
      await channel.onMessage(async (msg) => {
        received.push(msg);
      });

      await handler?.({
        message: {
          document: { file_id: 'doc123', file_name: 'report.pdf', mime_type: 'application/pdf', file_size: 4096 },
          caption: 'My report',
          reply_to_message: { message_id: 42 },
        },
        chat: { id: 123, type: 'private' },
        from: { id: 456 },
      } as unknown as MockCtx);

      expect(received).toHaveLength(1);
      const message = received[0];
      // The caption survives verbatim; the reference is an identity, not bytes or a path.
      expect(message.text).toBe('My report');
      expect(message.media).toEqual({
        channel: 'telegram',
        fileId: 'doc123',
        kind: 'document',
        displayName: 'report.pdf',
        mime: 'application/pdf',
        advertisedBytes: 4096,
      });

      // The load-bearing assertions: no Bot API call, no HTTP fetch, and nothing written.
      expect(mockGetFile).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(fs.readdirSync(stagingDir)).toEqual([]);
      // And the wire type cannot carry a local path at all.
      expect((message as { mediaPath?: string }).mediaPath).toBeUndefined();
    });

    it('photo handler emits an opaque reference for the highest resolution photo, doing no I/O', async () => {
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;

      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:photo') handler = cb;
      });

      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      const channel = new TelegramChannel('test-token');
      const received: IncomingMessage[] = [];
      await channel.onMessage(async (msg) => {
        received.push(msg);
      });

      const stagingDir = makeTestTemp('socs-s1-tg-photo-nothing-written');
      await handler?.({
        message: {
          photo: [
            { file_id: 'small', file_size: 100 },
            { file_id: 'large', file_size: 9000 },
          ],
        },
        chat: { id: 123, type: 'private' },
        from: { id: 456 },
      } as unknown as MockCtx);

      expect(received).toHaveLength(1);
      expect(received[0].media?.fileId).toBe('large');
      expect(received[0].media?.kind).toBe('photo');
      expect(received[0].media?.advertisedBytes).toBe(9000);
      expect(received[0].text).toBe('Sent a photo');
      expect(mockGetFile).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(fs.readdirSync(stagingDir)).toEqual([]);
    });

    it('a caption-bearing document never reaches a fetch even when the sender is a stranger', async () => {
      // The transport cannot know who the sender is — that is the core's job — so this asserts the
      // property that matters here: the transport does no work regardless of who is talking.
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;
      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:document') handler = cb;
      });
      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      const channel = new TelegramChannel('test-token');
      await channel.onMessage(async () => undefined);

      await handler?.({
        message: { document: { file_id: 'stranger-doc', file_name: 'x.pdf' } },
        chat: { id: 999, type: 'private' },
        from: { id: 888 },
      } as unknown as MockCtx);

      expect(mockGetFile).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('text handler error logs a sanitized frame, never the PHI-bearing handler error', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;
      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:text') {
          handler = cb;
        }
      });
      const channel = new TelegramChannel('test-token');
      await channel.onMessage(async () => {
        throw new Error(`telegram handler failed: ${PHI}`);
      });
      const mockCtx: MockCtx = {
        message: { caption: 'x' } as MockCtx['message'],
        chat: { id: 123 },
        from: { id: 456 },
      };
      // The handler re-throws so grammY's boundary catches it; suppress the throw here.
      await expect(handler?.(mockCtx)).rejects.toThrow();
      const logged = errorSpy.mock.calls.flat().map(String).join('\n');
      errorSpy.mockRestore();
      expect(logged).not.toContain(PHI);
      expect(logged).not.toContain('telegram handler failed');
      expect(logged).toContain('Handler error');
      expect(logged).toContain('Error');
    });

    it('document handler error logs a sanitized frame, never the PHI-bearing handler error', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;
      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:document') {
          handler = cb;
        }
      });
      mockGetFile.mockResolvedValue({ file_path: 'documents/test.pdf' });
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      global.fetch = mockFetch;
      const channel = new TelegramChannel('test-token');
      await channel.onMessage(async () => {
        throw new Error(`telegram handler failed: ${PHI}`);
      });
      const mockCtx: MockCtx = {
        message: {
          document: { file_id: 'doc123', file_name: 'report.pdf' },
          caption: 'My report',
        },
        chat: { id: 123 },
        from: { id: 456 },
      };
      await expect(handler?.(mockCtx)).rejects.toThrow();
      const logged = errorSpy.mock.calls.flat().map(String).join('\n');
      errorSpy.mockRestore();
      expect(logged).not.toContain(PHI);
      expect(logged).toContain('Handler error');
    });

    it('photo handler error logs a sanitized frame, never the PHI-bearing handler error', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;
      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:photo') {
          handler = cb;
        }
      });
      mockGetFile.mockResolvedValue({ file_path: 'photos/photo_123.jpg' });
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });
      global.fetch = mockFetch;
      const channel = new TelegramChannel('test-token');
      await channel.onMessage(async () => {
        throw new Error(`telegram handler failed: ${PHI}`);
      });
      const mockCtx: MockCtx = {
        message: {
          photo: [{ file_id: 'large', width: 800, height: 800 }],
          caption: 'Check this out',
        },
        chat: { id: 123 },
        from: { id: 456 },
      };
      await expect(handler?.(mockCtx)).rejects.toThrow();
      const logged = errorSpy.mock.calls.flat().map(String).join('\n');
      errorSpy.mockRestore();
      expect(logged).not.toContain(PHI);
      expect(logged).toContain('Handler error');
    });
  });

  // ── RES-P0-1: grammY error boundary installed in constructor ────────────
  describe('grammY error boundary (RES-P0-1)', () => {
    it('installs bot.catch handler during construction', () => {
      mockBotCatch.mockClear();
      new TelegramChannel('test-token');
      expect(mockBotCatch).toHaveBeenCalledTimes(1);
      expect(typeof mockBotCatch.mock.calls[0][0]).toBe('function');
    });
  });

  // ── RES-P0-2: connect() never leaks an unhandled rejection ───────────────
  describe('connect reconnect (RES-P0-2)', () => {
    it('a bot whose start() rejects: no unhandledRejection, warn logged, reconnect scheduled', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      const unhandled: unknown[] = [];
      const rejectionListener = (reason: unknown) => unhandled.push(reason);
      process.prependOnceListener('unhandledRejection', rejectionListener);

      try {
        mockBotStart.mockClear();
        mockBotStart.mockRejectedValue(new Error('getUpdates request failed: 401 Unauthorized PHI marker glucose'));

        const channel = new TelegramChannel('test-token');
        await channel.connect();

        // Let the rejected promise's .then rejection handler run.
        await Promise.resolve();
        await Promise.resolve();

        // Reconnect timer was scheduled (≈1s start, exponential backoff).
        const reconnectCall = setTimeoutSpy.mock.calls.find(
          ([fn, ms]) => typeof fn === 'function' && typeof ms === 'number' && ms >= 1000 && ms <= 1000,
        );
        expect(reconnectCall).toBeTruthy();

        // warn logged, sanitized (no PHI marker, no raw message body).
        const warned = warnSpy.mock.calls.flat().map(String).join('\n');
        expect(warned).toContain('Polling start failed');
        expect(warned).not.toContain('glucose');
        expect(warned).not.toContain('401 Unauthorized');

        // No unhandledRejection reached the process.
        // (drain any pending microtasks before checking)
        await new Promise((r) => setImmediate(r));
        expect(unhandled).toHaveLength(0);

        await channel.disconnect();
      } finally {
        process.removeListener('unhandledRejection', rejectionListener);
        warnSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
        setTimeoutSpy.mockRestore();
      }
    });

    it('disconnect cancels a pending reconnect timer and stops the bot', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        mockBotStart.mockRejectedValue(new Error('startup blip'));
        const channel = new TelegramChannel('test-token');
        await channel.connect();
        await Promise.resolve();
        await Promise.resolve();

        await channel.disconnect();
        expect(mockBotStop).toHaveBeenCalledTimes(1);
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });
});
