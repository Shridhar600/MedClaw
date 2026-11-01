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

    it('document handler emits an opaque media reference and performs no retrieval or write', async () => {
      let handler: ((ctx: MockCtx) => Promise<void>) | undefined;

      mockBotOn.mockImplementation((event: string, cb: (ctx: MockCtx) => Promise<void>) => {
        if (event === 'message:document') handler = cb;
      });

      const mockFetch = jest.fn();
      global.fetch = mockFetch;

      const stagingDir = makeTestTemp('tg-nothing-written');
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
      expect(message.text).toBe('My report');
      expect(message.media).toEqual({
        channel: 'telegram',
        fileId: 'doc123',
        kind: 'document',
        displayName: 'report.pdf',
        mime: 'application/pdf',
        advertisedBytes: 4096,
      });

      expect(mockGetFile).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(fs.readdirSync(stagingDir)).toEqual([]);
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

      const stagingDir = makeTestTemp('tg-photo-nothing-written');
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

  describe('grammY error boundary', () => {
    it('installs bot.catch handler during construction', () => {
      mockBotCatch.mockClear();
      new TelegramChannel('test-token');
      expect(mockBotCatch).toHaveBeenCalledTimes(1);
      expect(typeof mockBotCatch.mock.calls[0][0]).toBe('function');
    });
  });

  describe('connect reconnect', () => {
    it('a bot whose start rejects: no unhandledRejection, warn logged, reconnect scheduled', async () => {
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

        await Promise.resolve();
        await Promise.resolve();

        const reconnectCall = setTimeoutSpy.mock.calls.find(
          ([fn, ms]) => typeof fn === 'function' && typeof ms === 'number' && ms >= 1000 && ms <= 1000,
        );
        expect(reconnectCall).toBeTruthy();

        // warn logged, sanitized (no PHI marker, no raw message body).
        const warned = warnSpy.mock.calls.flat().map(String).join('\n');
        expect(warned).toContain('Polling start failed');
        expect(warned).not.toContain('glucose');
        expect(warned).not.toContain('401 Unauthorized');

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

  describe('send', () => {
    it('delivers the same text as plain text when Telegram cannot parse the Markdown', async () => {
      mockSendMessage
        .mockRejectedValueOnce(Object.assign(new Error("Bad Request: can't parse entities: Can't find end of the entity"), { error_code: 400 }))
        .mockResolvedValueOnce({});
      const channel = new TelegramChannel('test-token');
      await channel.send('42', { text: 'Your blood_pressure looks *fine' });
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage.mock.calls[1][1]).toBe('Your blood_pressure looks *fine');
      expect(mockSendMessage.mock.calls[1][2].parse_mode).toBeUndefined();
    });

    it('still fails when Telegram rejects the message for another reason', async () => {
      mockSendMessage.mockRejectedValue(Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 }));
      const channel = new TelegramChannel('test-token');
      await expect(channel.send('42', { text: 'hello' })).rejects.toThrow('Forbidden');
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
  });
});
