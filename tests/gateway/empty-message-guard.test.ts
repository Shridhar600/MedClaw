// tests/gateway/empty-message-guard.test.ts
//
// PROD-P1-6: an empty or whitespace-only text message (with no media) must
// produce a short canned reply, never run the agent, and never write a session
// turn. Both gateway entry paths are covered: handleMessage (channel path) and
// handleTestMessage (test/CLI path).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Gateway } from '../../src/gateway/gateway';
import type { EffectiveConfig } from '../../src/config/types';
import { attachGatewayTestRuntime } from '../helpers/gateway-test-runtime';
import { ownerSelection, fixtureOwner } from '../helpers/test-config';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { bindGatewayOwner } from '../helpers/gateway-owner-deps';

/**
 * Per-suite owner root, INSIDE the workspace (`gitignored .test-tmp/`).
 *
 * OLD -> NEW: this used `sharedFixtureOwner()`, one hard-coded `/tmp` directory shared by every suite.
 * That was outside the workspace, and once S1 made admission bind exactly one chat per owner record, the
 * first suite to bind there owned it for all later callers — so this suite's chats were silently refused.
 * Each suite now derives and removes its own owner workspace.
 */
let suiteRoot = '';
const suiteOwner = (): ReturnType<typeof fixtureOwner> => fixtureOwner(suiteRoot);

function makeConfig(): EffectiveConfig {
  return {
  schemaVersion: 2,
  ...ownerSelection(suiteOwner()),
    providers: {
      main: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
      medical: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
      embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace: suiteOwner().workspace,
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
      storePath: suiteOwner().storePath,
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: suiteOwner().auditLogPath },
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
  beforeEach(() => {
    suiteRoot = makeTestTemp('empty-message-guard');
  });

  afterEach(() => {
    removeTestTemp(suiteRoot);
    suiteRoot = '';
  });

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
      attachGatewayTestRuntime(gateway, makeConfig(), {
        agentLoop: { run },
        sessions: { prepareHistory, recordTurn, recordPromptUsage: jest.fn().mockResolvedValue(undefined), resetSession: jest.fn() },
      });
      (gateway as any).runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);
      (gateway as any).channel = { send };
      return { run, send, prepareHistory, recordTurn };
    }

    it('an empty-text message (no media) returns a canned reply, never runs the agent, never writes a session', async () => {
      const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'test-chat', { channel: 'local', userId: 'u' }));
      const { run, send, prepareHistory, recordTurn } = wire(gateway);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:c1:1', chatId: 'c1', userId: 'u', text: '' });

      expect(run).not.toHaveBeenCalled();
      expect(prepareHistory).not.toHaveBeenCalled();
      expect(recordTurn).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
      const sent = send.mock.calls[0][1] as { text: string };
      expect(sent.text.length).toBeGreaterThan(0);
    });

    it('a whitespace-only-text message (no media) returns a canned reply and runs nothing', async () => {
      const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'c1', { channel: 'local', userId: 'u' }));
      const { run, send, prepareHistory, recordTurn } = wire(gateway);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:c1:2', chatId: 'c1', userId: 'u', text: '   \n\t  ' });

      expect(run).not.toHaveBeenCalled();
      expect(prepareHistory).not.toHaveBeenCalled();
      expect(recordTurn).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('still processes a media upload when text is empty (canned reply NOT fired)', async () => {
      const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'c1', { channel: 'local', userId: 'u' }));
      const { run, send, recordTurn } = wire(gateway);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:c1:3',
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
      attachGatewayTestRuntime(gateway, makeConfig(), {
        agentLoop: { run },
        sessions: { prepareHistory, recordTurn, recordPromptUsage: jest.fn().mockResolvedValue(undefined), resetSession: jest.fn() },
      });
      (gateway as any).runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);
      return { run, prepareHistory, recordTurn };
    }

    it('an empty-text message returns a canned reply, never runs the agent, never writes a session', async () => {
      const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'test-chat'));
      const { run, prepareHistory, recordTurn } = wire(gateway);

      const reply = await gateway.handleTestMessage('test-chat', '');

      expect(reply.length).toBeGreaterThan(0);
      expect(run).not.toHaveBeenCalled();
      expect(prepareHistory).not.toHaveBeenCalled();
      expect(recordTurn).not.toHaveBeenCalled();
    });

    it('a whitespace-only-text message returns a canned reply and runs nothing', async () => {
      const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'test-chat'));
      const { run, prepareHistory, recordTurn } = wire(gateway);

      const reply = await gateway.handleTestMessage('test-chat', '   \n  ');

      expect(reply.length).toBeGreaterThan(0);
      expect(run).not.toHaveBeenCalled();
      expect(prepareHistory).not.toHaveBeenCalled();
      expect(recordTurn).not.toHaveBeenCalled();
    });

    it('still runs the agent for a non-empty message', async () => {
      const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'test-chat'));
      const { run } = wire(gateway);

      const reply = await gateway.handleTestMessage('test-chat', 'How are my labs?');

      expect(run).toHaveBeenCalledTimes(1);
      expect(reply).toBe('ok');
    });
  });
});
