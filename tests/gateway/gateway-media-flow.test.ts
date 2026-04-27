import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import type { AppConfig } from '../../src/config/types';

describe('Gateway media flow', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function makeConfig(): AppConfig {
    return {
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
      agent: {
        maxIterations: 15,
        disclaimerEnabled: true,
      },
    };
  }

  it('forwards mediaPath and reply metadata into agent execution input', async () => {
    const gateway = new Gateway(makeConfig());
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'processed',
      trace: [{ role: 'assistant', content: 'processed' }],
      usedTools: [],
      healthResponse: false,
    });
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
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
    const gateway = new Gateway(makeConfig());
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'processed',
      trace: [{ role: 'assistant', content: 'processed' }],
      usedTools: [],
      healthResponse: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = {
      prepareHistory: jest.fn().mockResolvedValue([]),
      recordTurn: jest.fn().mockResolvedValue(undefined),
      resetSession: jest.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).handleOnboarding = jest.fn().mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'My private glucose reading is 240 after lunch',
    });

    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('glucose');
  });

  it('does not log raw agent errors that may contain sensitive context', async () => {
    const gateway = new Gateway(makeConfig());
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = jest.fn().mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = {
      run: jest.fn().mockRejectedValue(new Error('private report sodium value 130')),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = {
      prepareHistory: jest.fn().mockResolvedValue([]),
      recordTurn: jest.fn().mockResolvedValue(undefined),
      resetSession: jest.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).handleOnboarding = jest.fn().mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Please analyze my report',
    });

    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('sodium');
  });

  it('sends generic fallback when prepareHistory fails before agent execution', async () => {
    const gateway = new Gateway(makeConfig());
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = {
      prepareHistory: jest.fn().mockRejectedValue(new Error('private session glucose context')),
      recordTurn: jest.fn(),
      resetSession: jest.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).handleOnboarding = jest.fn().mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleMessage({
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

  it('does not send fallback when recordTurn fails after successful response send', async () => {
    const gateway = new Gateway(makeConfig());
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue({
      text: 'processed',
      trace: [{ role: 'assistant', content: 'processed' }],
      usedTools: [],
      healthResponse: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = {
      prepareHistory: jest.fn().mockResolvedValue([]),
      recordTurn: jest.fn().mockRejectedValue(new Error('private persistence sodium context')),
      resetSession: jest.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).handleOnboarding = jest.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).reconcileHeartbeatPolicies = jest.fn().mockResolvedValue(undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleMessage({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'Please analyze my report',
    })).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('chat-1', { text: 'processed' });
    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('sodium');
  });

  it('fails startup bootstrap instead of silently continuing with an unusable workspace path', () => {
    const tmpFile = path.join(os.tmpdir(), `redacted-bootstrap-file-${Date.now()}`);
    fs.writeFileSync(tmpFile, 'not a directory', 'utf8');
    const gateway = new Gateway(makeConfig());

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => (gateway as any).bootstrapWorkspace(tmpFile)).toThrow('Workspace bootstrap failed');
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it('surfaces explicit error to user when media download fails', async () => {
    const gateway = new Gateway(makeConfig());
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = { prepareHistory: jest.fn(), recordTurn: jest.fn(), resetSession: jest.fn() };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
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
    const gateway = new Gateway(makeConfig());
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();
    const recordTurn = jest.fn().mockResolvedValue(undefined);
    const prepareHistory = jest.fn().mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = { prepareHistory, recordTurn, resetSession: jest.fn() };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
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
    const gateway = new Gateway(makeConfig());
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();
    const recordTurn = jest.fn().mockResolvedValue(undefined);
    const prepareHistory = jest.fn().mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = { prepareHistory, recordTurn, resetSession: jest.fn() };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (gateway as any).handleMessage({
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
    const gateway = new Gateway(makeConfig());
    const send = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const run = jest.fn();
    const recordTurn = jest.fn().mockRejectedValue(new Error('disk write failed'));
    const prepareHistory = jest.fn().mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = { prepareHistory, recordTurn, resetSession: jest.fn() };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleMessage({
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
    const gateway = new Gateway(makeConfig());
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = jest.fn().mockRejectedValue(new Error('telegram response included private glucose context'));
    const run = jest.fn();
    const recordTurn = jest.fn();
    const prepareHistory = jest.fn().mockResolvedValue([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = { prepareHistory, recordTurn, resetSession: jest.fn() };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleMessage({
      chatId: 'chat-send-fail',
      userId: 'user-1',
      text: 'Uploaded report',
      mediaError: 'Failed to download uploaded file report.pdf',
    })).resolves.toBeUndefined();

    expect(run).not.toHaveBeenCalled();
    expect(recordTurn).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('glucose');
  });

  it('still surfaces upload failure when prepareHistory fails', async () => {
    const gateway = new Gateway(makeConfig());
    const send = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn();
    const recordTurn = jest.fn().mockResolvedValue(undefined);
    const prepareHistory = jest.fn().mockRejectedValue(new Error('session unavailable'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = { run };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = { prepareHistory, recordTurn, resetSession: jest.fn() };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((gateway as any).handleMessage({
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
