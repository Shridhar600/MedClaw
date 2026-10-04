/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';
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

const CHAT_BINDING = 'chat-1';

describe('Gateway media flow', () => {
  beforeEach(() => {
    suiteRoot = makeTestTemp('gateway-media-flow');
  });

  afterEach(() => {
    removeTestTemp(suiteRoot);
    suiteRoot = '';
  });

  afterEach(() => {
    removeTestTemp(suiteRoot);
    suiteRoot = '';
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeConfig(): EffectiveConfig {
    return {
    schemaVersion: 2,
    ...ownerSelection(suiteOwner()),
      providers: {
        main: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
        medical: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
        embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
      },
      channels: {
        telegram: { enabled: false, botToken: '' },
      },
      tools: {
        allow: ['*'],
        deny: [],
      },
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
      agent: {
        maxIterations: 15,
        disclaimerEnabled: true,
      },
    };
  }

  it('forwards mediaPath and reply metadata into agent execution input', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-1', { channel: 'local', userId: 'user-1' }));
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'processed',
      trace: [{ role: 'assistant', content: 'processed' }],
      usedTools: [],
      healthResponse: false,
    });
    const prepareHistory = jest.fn().mockResolvedValue([]);
    const recordTurn = jest.fn().mockResolvedValue(undefined);

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: { prepareHistory, recordTurn, resetSession: jest.fn() },
    });
    const runtime = (gateway as any).runtime;
    runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);
    (gateway as any).channel = { send };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-1:1',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Please analyze this uploaded report',
      mediaPath: 'reports/report.txt',
      replyToMessageId: '42',
    });

    expect(run).toHaveBeenCalledTimes(1);
    const forwardedPrompt = run.mock.calls[0][0] as string;
    expect(forwardedPrompt).toContain('Please analyze this uploaded report');
    expect(forwardedPrompt).toContain('reports/report.txt');
    expect(forwardedPrompt).toContain('42');
    expect(send).toHaveBeenCalledWith('chat-1', { text: 'processed' });
  });

  it('does not log user message text when handling incoming messages', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-1', { channel: 'local', userId: 'user-1' }));
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'processed',
      trace: [{ role: 'assistant', content: 'processed' }],
      usedTools: [],
      healthResponse: false,
    });

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: {
        prepareHistory: jest.fn().mockResolvedValue([]),
        recordTurn: jest.fn().mockResolvedValue(undefined),
        resetSession: jest.fn(),
      },
    });
    (gateway as any).runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);
    (gateway as any).channel = { send };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-1:2',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'My private glucose reading is 240 after lunch',
    });

    // console.log only logs character count, not message text
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('glucose');
  });

  it('logs agent error name+location but never the sensitive message body', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-1', { channel: 'local', userId: 'user-1' }));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = jest.fn().mockResolvedValue(undefined);

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run: jest.fn().mockRejectedValue(new Error('private report sodium value 130')) },
      sessions: {
        prepareHistory: jest.fn().mockResolvedValue([]),
        recordTurn: jest.fn().mockResolvedValue(undefined),
        resetSession: jest.fn(),
      },
    });
    (gateway as any).runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);
    (gateway as any).channel = { send };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-1:3',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Please analyze my report',
    });

    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('sodium');
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Error (at ');
  });

  it('sends generic fallback and never logs sensitive session context when prepareHistory fails', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-1', { channel: 'local', userId: 'user-1' }));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: {
        prepareHistory: jest.fn().mockRejectedValue(new Error('private session glucose context')),
        recordTurn: jest.fn(),
        resetSession: jest.fn(),
      },
    });
    (gateway as any).runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);
    (gateway as any).channel = { send };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-1:4',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Can I eat rice?',
    })).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('chat-1', {
      text: "I'm having trouble right now. Please try again in a moment.",
    });
    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('glucose');
  });

  it('does not send fallback nor log sensitive context when recordTurn fails after successful send', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-1', { channel: 'local', userId: 'user-1' }));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'processed',
      trace: [{ role: 'assistant', content: 'processed' }],
      usedTools: [],
      healthResponse: false,
    });

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: {
        prepareHistory: jest.fn().mockResolvedValue([]),
        recordTurn: jest.fn().mockRejectedValue(new Error('private persistence sodium context')),
        resetSession: jest.fn(),
      },
    });
    (gateway as any).runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).reconcileHeartbeatPolicies = jest.fn().mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-1:5',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Please analyze my report',
    })).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('chat-1', { text: 'processed' });
    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('sodium');
  });

  it('closes the search store on stop', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), CHAT_BINDING, { channel: 'local', userId: 'user-1' }));
    const close = jest.fn();
    attachGatewayTestRuntime(gateway, makeConfig(), { store: { close } });

    await gateway.stop();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('still closes the search store when channel disconnect fails during stop', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), CHAT_BINDING, { channel: 'local', userId: 'user-1' }));
    const close = jest.fn();
    attachGatewayTestRuntime(gateway, makeConfig(), { store: { close } });
    (gateway as any).channel = { disconnect: jest.fn().mockRejectedValue(new Error('disconnect failed')) };

    await expect(gateway.stop()).rejects.toThrow('disconnect failed');

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails startup bootstrap instead of silently continuing with an unusable workspace path', async () => {
    // The failure under test needs a path that EXISTS AS A FILE where a workspace directory is
    // expected. So this takes a unique NAME inside a workspace-local root — it must not be
    // `makeTestTemp`, which creates the directory and would make `writeFileSync` fail with EISDIR
    // before the code under test ever ran.
    const tmpRoot = makeTestTemp('r14-bootstrap-file');
    const tmpFile = path.join(tmpRoot, `not-a-directory-${Date.now()}`);
    fs.writeFileSync(tmpFile, 'not a directory', { encoding: 'utf8', mode: 0o600 });
    const config = makeConfig();
    const gateway = new Gateway(config, await bindGatewayOwner(config, CHAT_BINDING, { channel: 'local', userId: 'user-1' }));

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (gateway as any).bootstrapWorkspace(tmpFile)).toThrow('Workspace bootstrap failed');
    } finally {
      removeTestTemp(tmpRoot);
    }
  });

  it('surfaces explicit error to user when media download fails', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-1', { channel: 'local', userId: 'user-1' }));
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: { prepareHistory: jest.fn(), recordTurn: jest.fn(), resetSession: jest.fn() },
    });
    (gateway as any).channel = { send };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-1:6',
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Uploaded report',
      mediaError: 'Failed to download uploaded file report.pdf',
    });

    expect(run).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('chat-1', {
      text: 'Failed to download uploaded file report.pdf',
    });
  });

  it('preserves failed-upload message text in session history', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-media', { channel: 'local', userId: 'user-1' }));
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();
    const recordTurn = jest.fn().mockResolvedValue(undefined);
    const prepareHistory = jest.fn().mockResolvedValue([]);

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: { prepareHistory, recordTurn, resetSession: jest.fn() },
    });
    (gateway as any).channel = { send };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-media:7',
      chatId: 'chat-media',
      userId: 'user-1',
      text: 'Here is my blood test report',
      mediaError: 'Failed to download uploaded file bloodtest.pdf',
    });

    expect(recordTurn).toHaveBeenCalledWith(
      'chat-media',
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.stringContaining('Here is my blood test report') }),
        expect.objectContaining({ role: 'assistant', content: expect.stringContaining('Failed to download uploaded file bloodtest.pdf') }),
      ]),
    );
    expect(send).toHaveBeenCalledWith('chat-media', expect.objectContaining({
      text: expect.stringContaining('Failed to download'),
    }));
  });

  it('preserves reply metadata when media download fails', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-reply', { channel: 'local', userId: 'user-1' }));
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();
    const recordTurn = jest.fn().mockResolvedValue(undefined);
    const prepareHistory = jest.fn().mockResolvedValue([]);

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: { prepareHistory, recordTurn, resetSession: jest.fn() },
    });
    (gateway as any).channel = { send };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-reply:8',
      chatId: 'chat-reply',
      userId: 'user-1',
      text: 'What do you think of this report?',
      mediaError: 'Failed to download uploaded file report.pdf',
      replyToMessageId: '42',
    });

    expect(recordTurn).toHaveBeenCalledWith(
      'chat-reply',
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: expect.stringContaining('What do you think of this report?') }),
        expect.objectContaining({ role: 'assistant', content: expect.stringContaining('Failed to download uploaded file report.pdf') }),
      ]),
    );
    const passedContent = recordTurn.mock.calls[0][1][0].content as string;
    expect(passedContent).toContain('What do you think of this report?');
    const assistantFailure = recordTurn.mock.calls[0][1][1].content as string;
    expect(assistantFailure).toContain('Failed to download uploaded file report.pdf');
  });

  it('handles recordTurn failure in mediaError path without throwing out of the gateway handler', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-error', { channel: 'local', userId: 'user-1' }));
    const send = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const run = jest.fn();
    const recordTurn = jest.fn().mockRejectedValue(new Error('disk write failed'));
    const prepareHistory = jest.fn().mockResolvedValue([]);

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: { prepareHistory, recordTurn, resetSession: jest.fn() },
    });
    (gateway as any).channel = { send };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-error:9',
      chatId: 'chat-error',
      userId: 'user-1',
      text: 'Uploaded report',
      mediaError: 'Failed to download uploaded file report.pdf',
    })).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('chat-error', {
      text: 'Failed to download uploaded file report.pdf',
    });
  });

  it('does not log raw send errors when mediaError response delivery fails', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-send-fail', { channel: 'local', userId: 'user-1' }));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = jest.fn().mockRejectedValue(new Error('telegram response included private glucose context'));
    const run = jest.fn();
    const recordTurn = jest.fn();
    const prepareHistory = jest.fn().mockResolvedValue([]);

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: { prepareHistory, recordTurn, resetSession: jest.fn() },
    });
    (gateway as any).channel = { send };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-send-fail:10',
      chatId: 'chat-send-fail',
      userId: 'user-1',
      text: 'Uploaded report',
      mediaError: 'Failed to download uploaded file report.pdf',
    })).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    // Persist-before-send records the failure trace even when the channel rejects, so the
    // failed interaction remains durable and searchable.
    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('glucose');
  });

  it('still surfaces upload failure when prepareHistory fails', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-session-fail', { channel: 'local', userId: 'user-1' }));
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();
    const recordTurn = jest.fn().mockResolvedValue(undefined);
    const prepareHistory = jest.fn().mockRejectedValue(new Error('session unavailable'));

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: { prepareHistory, recordTurn, resetSession: jest.fn() },
    });
    (gateway as any).channel = { send };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-session-fail:11',
      chatId: 'chat-session-fail',
      userId: 'user-1',
      text: 'Uploaded report',
      mediaError: 'Failed to download uploaded file report.pdf',
    })).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('chat-session-fail', {
      text: 'Failed to download uploaded file report.pdf',
    });
  });
});

// ── RES-P0-4: persist-before-send ordering (main agent path) ───────────────
describe('Gateway persist-before-send (RES-P0-4)', () => {
  beforeEach(() => {
    suiteRoot = makeTestTemp('gateway-media-flow');
  });

  afterEach(() => {
    removeTestTemp(suiteRoot);
    suiteRoot = '';
  });

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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records the turn BEFORE sending the agent response (happy path)', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-order', { channel: 'local', userId: 'user-1' }));
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'processed',
      trace: [{ role: 'assistant', content: 'processed' }],
      usedTools: [],
      healthResponse: false,
    });
    const prepareHistory = jest.fn().mockResolvedValue([]);
    const recordTurn = jest.fn().mockResolvedValue(undefined);

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: { prepareHistory, recordTurn, resetSession: jest.fn() },
    });
    (gateway as any).channel = { send };
    (gateway as any).runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-order:12',
      chatId: 'chat-order',
      userId: 'user-1',
      text: 'Please analyze my report',
    });

    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    // The persist call occurred strictly before the send call.
    expect(recordTurn.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(send).toHaveBeenCalledWith('chat-order', { text: 'processed' });
  });

  it('still sends the real response when recordTurn fails pre-send, logs divergence sanitized (no fallback)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-persist-fail', { channel: 'local', userId: 'user-1' }));
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'processed',
      trace: [{ role: 'assistant', content: 'processed' }],
      usedTools: [],
      healthResponse: false,
    });
    const recordTurn = jest.fn().mockRejectedValue(new Error('private persistence sodium context PHI'));
    const prepareHistory = jest.fn().mockResolvedValue([]);

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: { prepareHistory, recordTurn, resetSession: jest.fn() },
    });
    (gateway as any).channel = { send };
    (gateway as any).runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).reconcileHeartbeatPolicies = jest.fn().mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-persist-fail:13',
      chatId: 'chat-persist-fail',
      userId: 'user-1',
      text: 'Please analyze my report',
    });

    // The real response was still sent exactly once — no fallback.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('chat-persist-fail', { text: 'processed' });

    // Persist-failure was logged sanitized; the PHI marker never leaked.
    const logged = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('Pre-send persistence error');
    expect(logged).not.toContain('sodium');
    expect(logged).not.toContain('PHI');
  });

  it('persists the emergency turn BEFORE sending emergency guidance', async () => {
    const gateway = new Gateway(makeConfig(), await bindGatewayOwner(makeConfig(), 'chat-emerg', { channel: 'local', userId: 'user-1' }));
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();
    const recordTurn = jest.fn().mockResolvedValue(undefined);
    const prepareHistory = jest.fn().mockResolvedValue([]);

    attachGatewayTestRuntime(gateway, makeConfig(), {
      agentLoop: { run },
      sessions: { prepareHistory, recordTurn, resetSession: jest.fn() },
    });
    (gateway as any).channel = { send };
    (gateway as any).runtime.turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-emerg:14',
      chatId: 'chat-emerg',
      userId: 'user-1',
      text: 'I have severe chest pain and cannot breathe',
    });

    expect(run).not.toHaveBeenCalled();
    expect(recordTurn).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(recordTurn.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    const sentText = (send.mock.calls[0][1] as { text: string }).text;
    expect(sentText.toLowerCase()).toContain('emergency');
  });
});
