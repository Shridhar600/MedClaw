/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import { SessionManager } from '../../src/gateway/session';
import { SqliteSessionIndex } from '../../src/indexstore/session-index';
import type { EffectiveConfig } from '../../src/config/types';
import type { HeartbeatJob } from '../../src/scheduler/types';
import { attachGatewayTestRuntime } from '../helpers/gateway-test-runtime';
import { bindOwnerFixture } from '../helpers/owner-authority-fixture';
import { makeTestTemp } from '../helpers/test-temp';

const FALLBACK = "I'm having trouble right now. Please try again in a moment.";

describe('RR-6b gateway delivery durability', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-rr6b-gateway-');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * OLD -> NEW: built `new Gateway({} as EffectiveConfig, await bindGatewayOwner({} as EffectiveConfig, CHAT_BINDING))` with no admission. Under S1 the destination
   * guard fails closed, so a heartbeat that must NOT be delivered before a failed persistence would look
   * delivered for the wrong reason. A real bound owner keeps the assertion about persistence, not about a
   * dead default.
   */
  async function makeGateway(): Promise<Gateway> {
    const bound = await bindOwnerFixture(
      path.join(tmpDir, 'owner-workspace', '.state', 'owner-access.json'),
      'default',
      'chat-1',
      { channel: 'local', userId: 'local' },
    );
    return new Gateway({} as EffectiveConfig, bound.gatewayDeps);
  }

  async function prepareFailureGateway(sessions: SessionManager): Promise<Gateway> {
    const gateway = await makeGateway();
    attachGatewayTestRuntime(gateway, {} as EffectiveConfig, {
      capturePipeline: { ingest: jest.fn().mockResolvedValue(undefined) },
      agentLoop: { run: jest.fn().mockRejectedValue(new Error('provider failed')) },
      sessions,
    });
    const state = gateway as unknown as Record<string, unknown>;
    (state.runtime as any).turnCoordinator.handleOnboarding = jest.fn().mockResolvedValue(undefined);
    return gateway;
  }

  it('archives and indexes an inbound user turn when the agent run fails', async () => {
    const sessions = new SessionManager({ sessionsPath: path.join(tmpDir, 'sessions') });
    const index = new SqliteSessionIndex({
      dbPath: path.join(tmpDir, 'search.db'),
      sessionsDir: sessions.sessionsDir,
    });
    sessions.setTurnIndex(index);
    const gateway = await prepareFailureGateway(sessions);

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
    const gateway = await prepareFailureGateway(sessions);
    const state = gateway as unknown as Record<string, unknown>;
    const send = jest.fn().mockResolvedValue(undefined);
    state.channel = { send };

    // OLD -> NEW: this drove the transport callback with NO channel/chatType/eventId, which S1 admission
    // refuses as `missing-transport-identity` — correctly, since a real inbound message always carries them.
    // The test is about handler/session sync, so it now sends a genuine bound-owner identity.
    await (gateway as unknown as { handleMessage(message: unknown): Promise<void> }).handleMessage({
      chatId: 'chat-1',
      userId: 'local',
      text: 'private blood pressure 180',
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-1:bp',
    });

    expect(send).toHaveBeenCalledWith('chat-1', { text: FALLBACK });
    const search = index.search('private blood pressure', { chatId: 'chat-1' });
    expect(search.hits.some((hit) => hit.snippet.includes('private blood pressure 180'))).toBe(true);
    index.close();
  });

  it('does not deliver a heartbeat before a failed persistence attempt, so retry sends once', async () => {
    const gateway = await makeGateway();
    const runtime = attachGatewayTestRuntime(gateway, {} as EffectiveConfig);
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

    // RR2-B1 setup migration: dispatch requires an explicit owner runtime; pair the job's
    // chat to the attached runtime's profile so the delivery assertions keep their meaning.
    // S1: this used to build a `ProfileRegistry`, pair 'chat-1' to the default profile and assign it to
    // `gateway.profileRegistry`. That field no longer exists — admission replaced it — so the block was
    // write-only scaffolding that granted nothing. The real authority is the bound owner record supplied
    // through `bindGatewayOwner` at construction.

    await expect((gateway as unknown as { handleScheduledJob(job: HeartbeatJob, owner: unknown, schedulerOwned: boolean): Promise<void> })
      .handleScheduledJob(job, runtime, true)).rejects.toThrow('session persistence unavailable');
    expect(send).not.toHaveBeenCalled();

    await (gateway as unknown as { handleScheduledJob(job: HeartbeatJob, owner: unknown, schedulerOwned: boolean): Promise<void> })
      .handleScheduledJob(job, runtime, true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not report /new success or reject the test handler when the replacement window write fails', async () => {
    const gateway = await makeGateway();
    attachGatewayTestRuntime(gateway, {} as EffectiveConfig);
    const state = gateway as unknown as Record<string, unknown>;
    state.sessions = {
      resetSession: jest.fn().mockRejectedValue(new Error('window write failed')),
    };

    await expect(gateway.handleTestMessage('chat-1', '/new')).resolves.toMatch(/unable|try again/i);
  });

  it('does not reject the channel handler when the replacement window write fails', async () => {
    const gateway = await makeGateway();
    attachGatewayTestRuntime(gateway, {} as EffectiveConfig);
    const state = gateway as unknown as Record<string, unknown>;
    const send = jest.fn().mockResolvedValue(undefined);
    state.channel = { send };
    state.sessions = {
      resetSession: jest.fn().mockRejectedValue(new Error('window write failed')),
    };

    // OLD -> NEW: as above — a real inbound message carries a transport identity, and admission refuses
    // one that does not.
    await (gateway as unknown as { handleMessage(message: unknown): Promise<void> }).handleMessage({
      chatId: 'chat-1',
      userId: 'local',
      text: '/new',
      channel: 'local',
      chatType: 'private',
      eventId: 'local:chat-1:new',
    });

    expect(send).toHaveBeenCalledWith('chat-1', expect.objectContaining({ text: expect.stringMatching(/unable|try again/i) }));
  });
});
