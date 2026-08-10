// tests/gateway/empty-message-guard.test.ts
//
// PROD-P1-6: an empty or whitespace-only text message (with no media) must
// produce a short canned reply, never run the agent, and never write a session
// turn. Both gateway entry paths are covered: handleMessage (channel path) and
// handleTestMessage (test/CLI path).

import { Gateway } from '../../src/gateway/gateway';
import type { AppConfig } from '../../src/config/types';

function makeConfig(): AppConfig {
  return {
    providers: {
      main: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
      medical: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
      embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace: '/tmp/redacted-test',
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20000,
    },
    sessions: {
      softResetAfterMinutes: 240,
      hardResetAfterMinutes: 1440,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
    },
    heartbeat: {
      enabled: false,
      timezone: 'Asia/Kolkata',
      storePath: '/tmp/redacted-test/heartbeats/jobs.json',
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: '/tmp/redacted-test/heartbeats/audit.jsonl' },
      policy: {
        quietHours: { enabled: true, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 60,
        defaults: {
          morningCheckIn: { enabled: true, cron: '0 8 * * *', prompt: 'Morning check-in prompt.' },
          eveningSummary: { enabled: true, cron: '0 21 * * *', prompt: 'Evening summary prompt.' },
        },
      },
    },
    agent: { maxIterations: 15, disclaimerEnabled: true },
  };
}

describe('PROD-P1-6 empty/whitespace message guard', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('handleMessage (channel path)', () => {
    function wire(gateway: Gateway) {
      const run = jest.fn().mockResolvedValue({
        text: 'processed',
        trace: [{ role: 'assistant', content: 'processed' }],
        usedTools: [],
        healthResponse: false,
      });
      const send = jest.fn().mockResolvedValue(undefined);
      const prepareHistory = jest.fn().mockResolvedValue([]);
      const recordTurn = jest.fn().mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).channel = { send };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).agentLoop = { run };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).sessions = { prepareHistory, recordTurn, resetSession: jest.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).handleOnboarding = jest.fn().mockResolvedValue(undefined);
      return { run, send, prepareHistory, recordTurn };
    }

    it('an empty-text message (no media) returns a canned reply, never runs the agent, never writes a session', async () => {
      const gateway = new Gateway(makeConfig());
      const { run, send, prepareHistory, recordTurn } = wire(gateway);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (gateway as any).handleMessage({ chatId: 'c1', userId: 'u', text: '' });

      expect(run).not.toHaveBeenCalled();
      expect(prepareHistory).not.toHaveBeenCalled();
      expect(recordTurn).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
      const sent = send.mock.calls[0][1] as { text: string };
      expect(sent.text.length).toBeGreaterThan(0);
    });

    it('a whitespace-only-text message (no media) returns a canned reply and runs nothing', async () => {
      const gateway = new Gateway(makeConfig());
      const { run, send, prepareHistory, recordTurn } = wire(gateway);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (gateway as any).handleMessage({ chatId: 'c1', userId: 'u', text: '   \n\t  ' });

      expect(run).not.toHaveBeenCalled();
      expect(prepareHistory).not.toHaveBeenCalled();
      expect(recordTurn).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('still processes a media upload when text is empty (canned reply NOT fired)', async () => {
      const gateway = new Gateway(makeConfig());
      const { run, send, recordTurn } = wire(gateway);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (gateway as any).handleMessage({
        chatId: 'c1',
        userId: 'u',
        text: '',
        mediaPath: 'reports/lab.txt',
      });

      // A media-bearing empty-text message goes through the normal agent path,
      // not the empty guard.
      expect(run).toHaveBeenCalledTimes(1);
      expect(recordTurn).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleTestMessage (test/CLI path)', () => {
    function wire(gateway: Gateway) {
      const run = jest.fn().mockResolvedValue({
        text: 'ok',
        trace: [{ role: 'assistant', content: 'ok' }],
        usedTools: [],
        healthResponse: false,
      });
      const prepareHistory = jest.fn().mockResolvedValue([]);
      const recordTurn = jest.fn().mockResolvedValue(undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).agentLoop = { run };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).sessions = { prepareHistory, recordTurn, resetSession: jest.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (gateway as any).handleOnboarding = jest.fn().mockResolvedValue(undefined);
      return { run, prepareHistory, recordTurn };
    }

    it('an empty-text message returns a canned reply, never runs the agent, never writes a session', async () => {
      const gateway = new Gateway(makeConfig());
      const { run, prepareHistory, recordTurn } = wire(gateway);

      const reply = await gateway.handleTestMessage('test-chat', '');

      expect(reply.length).toBeGreaterThan(0);
      expect(run).not.toHaveBeenCalled();
      expect(prepareHistory).not.toHaveBeenCalled();
      expect(recordTurn).not.toHaveBeenCalled();
    });

    it('a whitespace-only-text message returns a canned reply and runs nothing', async () => {
      const gateway = new Gateway(makeConfig());
      const { run, prepareHistory, recordTurn } = wire(gateway);

      const reply = await gateway.handleTestMessage('test-chat', '   \n  ');

      expect(reply.length).toBeGreaterThan(0);
      expect(run).not.toHaveBeenCalled();
      expect(prepareHistory).not.toHaveBeenCalled();
      expect(recordTurn).not.toHaveBeenCalled();
    });

    it('still runs the agent for a non-empty message', async () => {
      const gateway = new Gateway(makeConfig());
      const { run } = wire(gateway);

      const reply = await gateway.handleTestMessage('test-chat', 'How are my labs?');

      expect(run).toHaveBeenCalledTimes(1);
      expect(reply).toBe('ok');
    });
  });
});