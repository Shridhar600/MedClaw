import { TelegramChannel } from '../../src/channels/telegram';

const mockGetFile = jest.fn();
const mockSendMessage = jest.fn();
const mockBotOn = jest.fn();
const mockBotStart = jest.fn();
const mockBotStop = jest.fn();

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
      token: 'test-token',
    })),
  };
});

describe('TelegramChannel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFile.mockReset();
    mockSendMessage.mockReset();
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
  });
});
