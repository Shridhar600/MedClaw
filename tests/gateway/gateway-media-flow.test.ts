/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import type { EffectiveConfig } from '../../src/config/types';
import { attachGatewayTestRuntime } from '../helpers/gateway-test-runtime';
import { ownerSelection, fixtureOwner } from '../helpers/test-config';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { bindGatewayOwner } from '../helpers/gateway-owner-deps';

// Owner turns through a real Gateway with the agent loop and session store stubbed:
// upload hand-off, upload failure, persist-before-send, and PHI-free logs on failure paths.

const UPLOAD_FAILED = 'Failed to download uploaded file report.pdf';
const AGENT_OK = { text: 'processed', trace: [{ role: 'assistant', content: 'processed' }], usedTools: [], healthResponse: false };

let suiteRoot = '';

function makeConfig(): EffectiveConfig {
  const owner = fixtureOwner(suiteRoot);
  const local = { type: 'ollama' as const, model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' };
  return {
    schemaVersion: 2,
    ...ownerSelection(owner),
    providers: { main: local, medical: local, embeddings: { ...local, model: 'embeddinggemma:latest' } },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: { workspace: owner.workspace, search: { hybridWeights: { vector: 0.7, keyword: 0.3 } }, bootstrapMaxChars: 20000 },
    sessions: {
      softResetAfterMinutes: 240,
      hardResetAfterMinutes: 1440,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
    },
    heartbeat: {
      enabled: false,
      timezone: 'Asia/Kolkata',
      storePath: owner.storePath,
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: owner.auditLogPath },
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

async function bootGateway(chatId: string, stubs: {
  run?: jest.Mock;
  prepareHistory?: jest.Mock;
  recordTurn?: jest.Mock;
  send?: jest.Mock;
} = {}) {
  const config = makeConfig();
  const gateway = new Gateway(config, await bindGatewayOwner(config, chatId, { channel: 'local', userId: 'user-1' }));
  const run = stubs.run ?? jest.fn().mockResolvedValue(AGENT_OK);
  const prepareHistory = stubs.prepareHistory ?? jest.fn().mockResolvedValue([]);
  const recordTurn = stubs.recordTurn ?? jest.fn().mockResolvedValue(undefined);
  const send = stubs.send ?? jest.fn().mockResolvedValue(undefined);
  attachGatewayTestRuntime(gateway, config, {
    agentLoop: { run },
    sessions: { prepareHistory, recordTurn, resetSession: jest.fn() },
  });
  (gateway as any).runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);
  (gateway as any).reconcileHeartbeatPolicies = jest.fn().mockResolvedValue(undefined);
  (gateway as any).channel = { send };
  let counter = 0;
  const deliver = (extra: Record<string, unknown>): Promise<void> => (gateway as any).handleMessage({
    channel: 'local',
    chatType: 'private',
    eventId: `local:${chatId}:${++counter}`,
    chatId,
    userId: 'user-1',
    ...extra,
  });
  return { gateway, run, prepareHistory, recordTurn, send, deliver };
}

const logged = (...spies: jest.SpyInstance[]): string => spies.flatMap((spy) => spy.mock.calls.flat()).map(String).join('\n');

describe('Gateway upload and failure handling', () => {
  beforeEach(() => {
    suiteRoot = makeTestTemp('gateway-media-flow');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    removeTestTemp(suiteRoot);
    suiteRoot = '';
  });

  it('forwards the staged path and reply target to the agent without logging the message text', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { run, send, deliver } = await bootGateway('chat-1');

    await deliver({ text: 'My glucose is 240, please analyze this report', mediaPath: 'reports/report.txt', replyToMessageId: '42' });

    expect(run).toHaveBeenCalledTimes(1);
    const prompt = run.mock.calls[0][0] as string;
    expect(prompt).toContain('please analyze this report');
    expect(prompt).toContain('reports/report.txt');
    expect(prompt).toContain('42');
    expect(send).toHaveBeenCalledWith('chat-1', { text: 'processed' });
    expect(logged(logSpy)).not.toContain('glucose');
  });

  it('logs an agent error by name and location, never its sensitive message', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deliver } = await bootGateway('chat-1', { run: jest.fn().mockRejectedValue(new Error('private report sodium value 130')) });

    await deliver({ text: 'Please analyze my report' });

    expect(logged(errorSpy)).not.toContain('sodium');
    expect(logged(errorSpy)).toContain('Error (at ');
  });

  it('closes the search store on stop even when the channel disconnect fails', async () => {
    const config = makeConfig();
    const gateway = new Gateway(config, await bindGatewayOwner(config, 'chat-1', { channel: 'local', userId: 'user-1' }));
    const close = jest.fn();
    attachGatewayTestRuntime(gateway, config, { store: { close } });
    (gateway as any).channel = { disconnect: jest.fn().mockRejectedValue(new Error('disconnect failed')) };

    await expect(gateway.stop()).rejects.toThrow('disconnect failed');

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails startup bootstrap instead of continuing with an unusable workspace path', async () => {
    const tmpRoot = makeTestTemp('bootstrap-file');
    const notADirectory = path.join(tmpRoot, 'not-a-directory');
    fs.writeFileSync(notADirectory, 'not a directory', { encoding: 'utf8', mode: 0o600 });
    const { gateway } = await bootGateway('chat-1');

    try {
      expect(() => (gateway as any).bootstrapWorkspace(notADirectory)).toThrow('Workspace bootstrap failed');
    } finally {
      removeTestTemp(tmpRoot);
    }
  });

  it('tells the owner an upload failed and records both sides of the exchange', async () => {
    const { run, send, recordTurn, deliver } = await bootGateway('chat-media');

    await deliver({ text: 'What do you think of this report?', mediaError: UPLOAD_FAILED, replyToMessageId: '42' });

    expect(run).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('chat-media', { text: UPLOAD_FAILED });
    expect(recordTurn).toHaveBeenCalledWith('chat-media', expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('What do you think of this report?') }),
      expect.objectContaining({ role: 'assistant', content: expect.stringContaining(UPLOAD_FAILED) }),
    ]));
  });

  it.each([
    ['recordTurn', { recordTurn: jest.fn().mockRejectedValue(new Error('disk write failed')) }],
    ['prepareHistory', { prepareHistory: jest.fn().mockRejectedValue(new Error('session unavailable')) }],
  ])('still tells the owner an upload failed when %s fails', async (_name, stubs) => {
    const { run, send, deliver } = await bootGateway('chat-error', stubs);

    await expect(deliver({ text: 'Uploaded report', mediaError: UPLOAD_FAILED })).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('chat-error', { text: UPLOAD_FAILED });
  });

  it('keeps a failed upload reply private when the channel send itself fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { run, recordTurn, deliver } = await bootGateway('chat-send-fail', {
      send: jest.fn().mockRejectedValue(new Error('telegram response included private glucose context')),
    });

    await expect(deliver({ text: 'Uploaded report', mediaError: UPLOAD_FAILED })).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(logged(errorSpy)).not.toContain('glucose');
  });
});

describe('Gateway persist-before-send', () => {
  beforeEach(() => {
    suiteRoot = makeTestTemp('gateway-persist-order');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    removeTestTemp(suiteRoot);
    suiteRoot = '';
  });

  it('records the turn before sending the agent response', async () => {
    const { send, recordTurn, deliver } = await bootGateway('chat-order');

    await deliver({ text: 'Please analyze my report' });

    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(recordTurn.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(send).toHaveBeenCalledWith('chat-order', { text: 'processed' });
  });

  it('still sends the real response when recording fails, and logs no health detail', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { send, deliver } = await bootGateway('chat-persist-fail', {
      recordTurn: jest.fn().mockRejectedValue(new Error('private persistence sodium context PHI')),
    });

    await deliver({ text: 'Please analyze my report' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('chat-persist-fail', { text: 'processed' });
    expect(logged(errorSpy)).toContain('Pre-send persistence error');
    expect(logged(errorSpy)).not.toContain('sodium');
    expect(logged(errorSpy)).not.toContain('PHI');
  });

  it('records the emergency turn before sending emergency guidance, with no model call', async () => {
    const { run, send, recordTurn, deliver } = await bootGateway('chat-emerg');

    await deliver({ text: 'I have severe chest pain and cannot breathe' });

    expect(run).not.toHaveBeenCalled();
    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(recordTurn.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect((send.mock.calls[0][1] as { text: string }).text.toLowerCase()).toContain('emergency');
  });
});
