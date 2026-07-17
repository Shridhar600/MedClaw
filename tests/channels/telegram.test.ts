import { TelegramChannel } from '../../src/channels/telegram';

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
    it('accepts workspacePath as second parameter', () => {
      const channel = new TelegramChannel('test-token', '/workspace/path');
      expect(channel).toBeInstanceOf(TelegramChannel);
    });
  });

  type MockCtx = { message: { document?: { file_id: string; file_name?: string }; photo?: Array<{ file_id: string; width: number; height: number }>; caption?: string; reply_to_message?: { message_id: number } }; chat: { id: number }; from?: { id: number } };

  describe('message handlers', () => {
    it('document handler sets mediaPath on incoming message', async () => {
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

      const channel = new TelegramChannel('test-token', '/tmp/test-workspace');
      const receivedMessages: { mediaPath?: string; text?: string }[] = [];
      await channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      const mockCtx: MockCtx = {
        message: {
          document: { file_id: 'doc123', file_name: 'report.pdf' },
          caption: 'My report',
          reply_to_message: { message_id: 42 },
        },
        chat: { id: 123 },
        from: { id: 456 },
      };

      if (handler) {
        await handler(mockCtx);
      }

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].mediaPath).toBeDefined();
      expect(receivedMessages[0].mediaPath).toMatch(/^reports\//);
      expect(receivedMessages[0].mediaPath).not.toMatch(/^\//);
      expect(receivedMessages[0].text).toBe('My report');
    });

    it('document handler surfaces explicit mediaError on download failure', async () => {
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;

      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:document') {
          handler = cb;
        }
      });

      mockGetFile.mockRejectedValue(new Error('File not found'));

      const channel = new TelegramChannel('test-token', '/tmp/test-workspace');
      const receivedMessages: { mediaPath?: string; mediaError?: string }[] = [];
      await channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      const mockCtx: MockCtx = {
        message: {
          document: { file_id: 'doc123', file_name: 'report.pdf' },
          caption: 'My report',
        },
        chat: { id: 123 },
        from: { id: 456 },
      };

      if (handler) {
        await handler(mockCtx);
      }

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].mediaPath).toBeUndefined();
      expect(receivedMessages[0].mediaError).toContain('Failed to download');
    });

    it('document download failure logs redact Telegram bot token from error URL', async () => {
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:document') {
          handler = cb;
        }
      });

      mockGetFile.mockRejectedValue(
        new Error('failed https://api.telegram.org/file/bottest-token/documents/report.pdf')
      );

      const channel = new TelegramChannel('test-token', '/tmp/test-workspace');
      const receivedMessages: { mediaPath?: string; mediaError?: string }[] = [];
      await channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      const mockCtx: MockCtx = {
        message: {
          document: { file_id: 'doc123', file_name: 'report.pdf' },
          caption: 'My report',
        },
        chat: { id: 123 },
        from: { id: 456 },
      };

      if (handler) {
        await handler(mockCtx);
      }

      const logged = consoleError.mock.calls.flat().map(String).join('\n');
      consoleError.mockRestore();
      expect(logged).not.toContain('test-token');
      expect(logged).toContain('https://api.telegram.org/file/bot<redacted>/documents/report.pdf');
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].mediaPath).toBeUndefined();
      expect(receivedMessages[0].mediaError).toContain('Failed to download');
    });

    it('document download failure logs redact Telegram bot token from Bot API URL', async () => {
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:document') {
          handler = cb;
        }
      });

      mockGetFile.mockRejectedValue(
        new Error('failed https://api.telegram.org/bottest-token/getFile')
      );

      const channel = new TelegramChannel('test-token', '/tmp/test-workspace');
      await channel.onMessage(async () => undefined);

      const mockCtx: MockCtx = {
        message: {
          document: { file_id: 'doc123', file_name: 'report.pdf' },
          caption: 'My report',
        },
        chat: { id: 123 },
        from: { id: 456 },
      };

      if (handler) {
        await handler(mockCtx);
      }

      const logged = consoleError.mock.calls.flat().map(String).join('\n');
      consoleError.mockRestore();
      expect(logged).not.toContain('test-token');
      expect(logged).toContain('https://api.telegram.org/bot<redacted>/getFile');
    });

    it('photo handler sets mediaPath for highest resolution photo', async () => {
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

      const channel = new TelegramChannel('test-token', '/tmp/test-workspace');
      const receivedMessages: { mediaPath?: string }[] = [];
      await channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      const mockCtx: MockCtx = {
        message: {
          photo: [
            { file_id: 'small', width: 100, height: 100 },
            { file_id: 'medium', width: 400, height: 400 },
            { file_id: 'large', width: 800, height: 800 },
          ],
          caption: 'Check this out',
        },
        chat: { id: 123 },
        from: { id: 456 },
      };

      if (handler) {
        await handler(mockCtx);
      }

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].mediaPath).toBeDefined();
      expect(receivedMessages[0].mediaPath).toMatch(/^reports\//);
      expect(receivedMessages[0].mediaPath).not.toMatch(/^\//);
      expect(mockGetFile).toHaveBeenCalledWith('large');
    });

    it('does not save file when HTTP fetch returns non-OK status', async () => {
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;

      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:document') {
          handler = cb;
        }
      });

      mockGetFile.mockResolvedValue({ file_path: 'documents/test.pdf' });
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });
      global.fetch = mockFetch;

      const channel = new TelegramChannel('test-token', '/tmp/test-workspace2');
      const receivedMessages: { mediaPath?: string; mediaError?: string }[] = [];
      await channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      const mockCtx: MockCtx = {
        message: {
          document: { file_id: 'doc123', file_name: 'report.pdf' },
          caption: 'My report',
        },
        chat: { id: 123 },
        from: { id: 456 },
      };

      if (handler) {
        await handler(mockCtx);
      }

      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].mediaPath).toBeUndefined();
      expect(receivedMessages[0].mediaError).toContain('Failed to download');
    });

    it('photo download failure logs redact Telegram bot token from error URL', async () => {
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:photo') {
          handler = cb;
        }
      });

      mockGetFile.mockRejectedValue(
        new Error('failed https://api.telegram.org/file/bottest-token/photos/photo.jpg')
      );

      const channel = new TelegramChannel('test-token', '/tmp/test-workspace');
      const receivedMessages: { mediaPath?: string; mediaError?: string }[] = [];
      await channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      const mockCtx: MockCtx = {
        message: {
          photo: [{ file_id: 'large', width: 800, height: 800 }],
          caption: 'Check this out',
        },
        chat: { id: 123 },
        from: { id: 456 },
      };

      if (handler) {
        await handler(mockCtx);
      }

      const logged = consoleError.mock.calls.flat().map(String).join('\n');
      consoleError.mockRestore();
      expect(logged).not.toContain('test-token');
      expect(logged).toContain('https://api.telegram.org/file/bot<redacted>/photos/photo.jpg');
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0].mediaPath).toBeUndefined();
      expect(receivedMessages[0].mediaError).toContain('Failed to download');
    });
  });

  // ── RES-P0-1: grammY error boundary installed in constructor ────────────
  describe('grammY error boundary (RES-P0-1)', () => {
    it('installs bot.catch handler during construction', () => {
      mockBotCatch.mockClear();
      new TelegramChannel('test-token', '/tmp/test-workspace');
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

        const channel = new TelegramChannel('test-token', '/tmp/test-workspace');
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
        const channel = new TelegramChannel('test-token', '/tmp/test-workspace');
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
