import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { SessionManager } from '../../src/gateway/session';
import { SqliteSessionIndex } from '../../src/indexstore/session-index';
import type { AppConfig } from '../../src/config/types';
import type { HeartbeatJob } from '../../src/scheduler/types';

const FALLBACK = "I'm having trouble right now. Please try again in a moment.";

describe('RR-6b gateway delivery durability', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr6b-gateway-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeGateway(): Gateway {
    return new Gateway({} as AppConfig);
  }

  function prepareFailureGateway(sessions: SessionManager): Gateway {
    const gateway = makeGateway();
    const state = gateway as unknown as Record<string, unknown>;
    state.handleOnboarding = jest.fn().mockResolvedValue(undefined);
    state.capturePipeline = { ingest: jest.fn().mockResolvedValue(undefined) };
    state.agentLoop = { run: jest.fn().mockRejectedValue(new Error('provider failed')) };
    state.sessions = sessions;
    return gateway;
  }

  it('archives and indexes an inbound user turn when the agent run fails', async () => {
    const sessions = new SessionManager({ sessionsPath: path.join(tmpDir, 'sessions') });
    const index = new SqliteSessionIndex({
      dbPath: path.join(tmpDir, 'search.db'),
      sessionsDir: sessions.sessionsDir,
    });
    sessions.setTurnIndex(index);
    const gateway = prepareFailureGateway(sessions);

    await expect(gateway.handleTestMessage('chat-1', 'private glucose 240')).resolves.toBe(FALLBACK);

    const search = index.search('private glucose', { chatId: 'chat-1' });
    expect(search.hits.some((hit) => hit.snippet.includes('private glucose 240'))).toBe(true);
    index.close();
  });

  it('keeps the channel handler in sync by archiving an inbound turn on agent failure', async () => {
    const sessions = new SessionManager({ sessionsPath: path.join(tmpDir, 'channel-sessions') });
    const index = new SqliteSessionIndex({
      dbPath: path.join(tmpDir, 'channel-search.db'),
      sessionsDir: sessions.sessionsDir,
    });
    sessions.setTurnIndex(index);
    const gateway = prepareFailureGateway(sessions);
    const state = gateway as unknown as Record<string, unknown>;
    const send = jest.fn().mockResolvedValue(undefined);
    state.channel = { send };

    await (gateway as unknown as { handleMessage(message: unknown): Promise<void> }).handleMessage({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'private blood pressure 180',
    });

    expect(send).toHaveBeenCalledWith('chat-1', { text: FALLBACK });
    const search = index.search('private blood pressure', { chatId: 'chat-1' });
    expect(search.hits.some((hit) => hit.snippet.includes('private blood pressure 180'))).toBe(true);
    index.close();
  });

  it('does not deliver a heartbeat before a failed persistence attempt, so retry sends once', async () => {
    const gateway = makeGateway();
    const state = gateway as unknown as Record<string, unknown>;
    const send = jest.fn().mockResolvedValue(undefined);
    let recordCalls = 0;
    state.channel = { send };
    state.agentLoop = {
      run: jest.fn().mockResolvedValue({
        text: 'Heartbeat nudge',
        trace: [{ role: 'assistant', content: 'Heartbeat nudge' }],
        usedTools: [],
        healthResponse: false,
      }),
    };
    state.sessions = {
      prepareHistory: jest.fn().mockResolvedValue([]),
      recordTurn: jest.fn().mockImplementation(async () => {
        recordCalls++;
        if (recordCalls === 1) throw new Error('session persistence unavailable');
      }),
      recordPromptUsage: jest.fn().mockResolvedValue(undefined),
      getLastActiveAt: jest.fn().mockReturnValue(undefined),
    };
    state.config = {
      heartbeat: {
        policy: {
          quietHours: { enabled: false, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 0,
        },
      },
    };
    state.getProfileForChat = jest.fn().mockReturnValue('default');

    const job: HeartbeatJob = {
      id: 'job-1',
      title: 'Morning check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'Asia/Kolkata',
      prompt: 'Ask how the user is feeling.',
      enabled: true,
      source: 'system',
      kind: 'routine',
      deliveryState: 'ready',
      retryCount: 0,
      maxRetries: 3,
      policyKey: 'defaults:morning-check-in',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await expect((gateway as unknown as { handleScheduledJob(job: HeartbeatJob, schedulerOwned: boolean): Promise<void> })
      .handleScheduledJob(job, true)).rejects.toThrow('session persistence unavailable');
    expect(send).not.toHaveBeenCalled();

    await (gateway as unknown as { handleScheduledJob(job: HeartbeatJob, schedulerOwned: boolean): Promise<void> })
      .handleScheduledJob(job, true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not report /new success or reject the test handler when the replacement window write fails', async () => {
    const gateway = makeGateway();
    const state = gateway as unknown as Record<string, unknown>;
    state.sessions = {
      resetSession: jest.fn().mockRejectedValue(new Error('window write failed')),
    };

    await expect(gateway.handleTestMessage('chat-1', '/new')).resolves.toMatch(/unable|try again/i);
  });

  it('does not reject the channel handler when the replacement window write fails', async () => {
    const gateway = makeGateway();
    const state = gateway as unknown as Record<string, unknown>;
    const send = jest.fn().mockResolvedValue(undefined);
    state.channel = { send };
    state.sessions = {
      resetSession: jest.fn().mockRejectedValue(new Error('window write failed')),
    };

    await (gateway as unknown as { handleMessage(message: unknown): Promise<void> }).handleMessage({
      chatId: 'chat-1',
      userId: 'user-1',
      text: '/new',
    });

    expect(send).toHaveBeenCalledWith('chat-1', expect.objectContaining({ text: expect.stringMatching(/unable|try again/i) }));
  });
});
