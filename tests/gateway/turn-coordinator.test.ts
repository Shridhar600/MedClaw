import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentLoop } from '../../src/agent/agent-loop';
import type { AppConfig } from '../../src/config/types';
import type { ProfileRuntime } from '../../src/gateway/runtime';
import type { IncomingMessage } from '../../src/channels/types';
import { OnboardingFlow } from '../../src/onboarding/flow';
import { ToolRegistry } from '../../src/tools/registry';
import { HeartbeatPreemptedError, LLMSemaphore } from '../../src/tools/semaphore';
import { TurnCoordinator, TurnQueueFullError } from '../../src/gateway/turn-coordinator';
import type { LLMProvider, LLMResponse, Message } from '../../src/providers/types';

function deferred<T = void>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value?: T | PromiseLike<T>) => res(value as T);
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeConfig(workspace: string): AppConfig {
  return {
    providers: {
      main: { type: 'ollama', model: 'test-main' },
      medical: { type: 'ollama', model: 'test-medical' },
      embeddings: { type: 'ollama', model: 'test-embeddings' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: { workspace, search: { hybridWeights: { vector: 0.7, keyword: 0.3 } }, bootstrapMaxChars: 20_000 },
    sessions: {
      softResetAfterMinutes: 240,
      hardResetAfterMinutes: 1440,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
    },
    heartbeat: {
      enabled: false,
      timezone: 'Asia/Kolkata',
      storePath: path.join(workspace, '.state', 'heartbeat-jobs.json'),
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: path.join(workspace, '.state', 'heartbeat-audit.jsonl') },
      policy: {
        quietHours: { enabled: false, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 60,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 5, disclaimerEnabled: false },
  };
}

type SessionDouble = {
  prepareHistory: jest.Mock<Promise<Message[]>, [string]>;
  recordTurn: jest.Mock<Promise<unknown>, [string, Message[], string?]>;
  recordPromptUsage: jest.Mock<Promise<void>, [string, number?]>;
  resetSession: jest.Mock<Promise<void>, [string]>;
  runCompaction: jest.Mock<Promise<void>, [string]>;
};

type RuntimeDouble = {
  profileId: 'default';
  workspace: string;
  config: AppConfig;
  agentLoop: { run: jest.Mock };
  sessions: SessionDouble;
  capturePipeline?: { ingest: jest.Mock<Promise<void>> };
  trackBackgroundOperation: jest.Mock;
};

function makeRuntime(): RuntimeDouble {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-turn-coordinator-'));
  fs.mkdirSync(path.join(workspace, '.redacted'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.redacted', 'onboarding.json'),
    JSON.stringify({ status: 'complete', answers: {}, updatedAt: new Date().toISOString() }),
    'utf8',
  );

  const sessions: SessionDouble = {
    prepareHistory: jest.fn().mockResolvedValue([]),
    recordTurn: jest.fn().mockResolvedValue([]),
    recordPromptUsage: jest.fn().mockResolvedValue(undefined),
    resetSession: jest.fn().mockResolvedValue(undefined),
    runCompaction: jest.fn().mockResolvedValue(undefined),
  };
  return {
    profileId: 'default',
    workspace,
    config: makeConfig(workspace),
    agentLoop: { run: jest.fn() },
    sessions,
    capturePipeline: { ingest: jest.fn().mockResolvedValue(undefined) },
    trackBackgroundOperation: jest.fn((_label: string, operation: () => Promise<void>) => { void operation(); }),
  };
}

function message(text: string, chatId = 'chat-1'): IncomingMessage {
  return { chatId, userId: 'user-1', text };
}

function response(text: string) {
  return {
    text,
    trace: [{ role: 'assistant' as const, content: text }],
    usedTools: [],
    healthResponse: false,
  };
}

const noEmergency = (): string | undefined => undefined;

describe('TurnCoordinator whole-turn serialization', () => {
  let runtime: RuntimeDouble;
  let coordinator: TurnCoordinator;
  let releaseFirst: ReturnType<typeof deferred>;
  let firstAgentStarted: ReturnType<typeof deferred>;

  beforeEach(() => {
    runtime = makeRuntime();
    releaseFirst = deferred();
    firstAgentStarted = deferred();
    const persistedUserText: string[] = [];
    runtime.sessions.prepareHistory.mockImplementation(async () =>
      persistedUserText.map((text) => ({ role: 'user' as const, content: text })));
    runtime.sessions.recordTurn.mockImplementation(async (_chatId, trace) => {
      const user = trace.find((entry) => entry.role === 'user');
      if (user?.content) persistedUserText.push(user.content);
      return [];
    });
    runtime.agentLoop.run
      .mockImplementationOnce(async (input: string) => {
        if (input.startsWith('first')) {
          firstAgentStarted.resolve();
          await releaseFirst.promise;
        }
        return response(`reply:${input}`);
      })
      .mockImplementation(async (input: string) => response(`reply:${input}`));
    coordinator = new TurnCoordinator(runtime as unknown as ProfileRuntime, new LLMSemaphore());
  });

  afterEach(() => {
    fs.rmSync(runtime.workspace, { recursive: true, force: true });
  });

  it('does not prepare a second same-chat turn until the first turn persists', async () => {
    const egress = jest.fn().mockResolvedValue(undefined);
    const first = coordinator.runUser(message('first'), egress, noEmergency);
    await firstAgentStarted.promise;

    const second = coordinator.runUser(message('second'), egress, noEmergency);
    await Promise.resolve();
    expect(runtime.sessions.prepareHistory).toHaveBeenCalledTimes(1);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(runtime.sessions.prepareHistory).toHaveBeenCalledTimes(2);
    expect(runtime.sessions.prepareHistory.mock.results[1].value).toBeDefined();
    expect(runtime.agentLoop.run.mock.calls[1][1]).toEqual([{ role: 'user', content: 'first\n\nUser id: user-1' }]);
  });

  it('allows independent chats to enter their agents concurrently', async () => {
    runtime.agentLoop.run.mockReset();
    const entered = new Set<string>();
    const bothEntered = deferred();
    const release = deferred();
    runtime.agentLoop.run.mockImplementation(async (input: string) => {
      entered.add(input);
      if (entered.size === 2) bothEntered.resolve();
      await release.promise;
      return response(`reply:${input}`);
    });

    const egress = jest.fn().mockResolvedValue(undefined);
    const chatA = coordinator.runUser(message('A', 'chat-a'), egress, noEmergency);
    const chatB = coordinator.runUser(message('B', 'chat-b'), egress, noEmergency);
    await bothEntered.promise;
    expect(entered).toEqual(new Set(['A\n\nUser id: user-1', 'B\n\nUser id: user-1']));

    release.resolve();
    await Promise.all([chatA, chatB]);
  });

  it('admits one active plus two waiting turns and rejects the fourth', async () => {
    runtime.agentLoop.run.mockReset();
    const firstStarted = deferred();
    const release = deferred();
    runtime.agentLoop.run.mockImplementation(async (input: string) => {
      if (input.startsWith('first')) firstStarted.resolve();
      await release.promise;
      return response(`reply:${input}`);
    });

    const egress = jest.fn().mockResolvedValue(undefined);
    const first = coordinator.runUser(message('first'), egress, noEmergency);
    await firstStarted.promise;
    const second = coordinator.runUser(message('second'), egress, noEmergency);
    const third = coordinator.runUser(message('third'), egress, noEmergency);
    const fourth = coordinator.runUser(message('fourth'), egress, noEmergency);

    await expect(fourth).rejects.toBeInstanceOf(TurnQueueFullError);
    release.resolve();
    await Promise.all([first, second, third]);
    expect(runtime.agentLoop.run).toHaveBeenCalledTimes(3);
  });
});

describe('TurnCoordinator heartbeat preemption', () => {
  let runtime: RuntimeDouble;
  let workspace: string;

  beforeEach(() => {
    runtime = makeRuntime();
    workspace = runtime.workspace;
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('evicts an active queued heartbeat and lets the user turn proceed without heartbeat persistence', async () => {
    const semaphore = new LLMSemaphore();
    const blockerStarted = deferred();
    const releaseBlocker = deferred();
    const blocker = semaphore.run('user', async () => {
      blockerStarted.resolve();
      await releaseBlocker.promise;
    });

    const provider: LLMProvider = {
      chat: jest.fn().mockResolvedValue({ type: 'text', text: 'agent reply' }),
      embed: jest.fn().mockResolvedValue([]),
    };
    runtime.agentLoop = {
      run: jest.fn(),
    };
    const loop = new AgentLoop(
      provider,
      new ToolRegistry({ allow: ['*'], deny: [] }),
      [],
      { maxIterations: 5, disclaimerEnabled: false },
      semaphore,
    );
    (runtime as unknown as { agentLoop: AgentLoop }).agentLoop = loop;
    const coordinator = new TurnCoordinator(runtime as unknown as ProfileRuntime, semaphore);

    await blockerStarted.promise;
    const heartbeat = coordinator.runHeartbeat({
      chatId: 'chat-preempt',
      input: '[Heartbeat Trigger]\nCheck in',
      egress: jest.fn().mockResolvedValue(undefined),
      afterDelivery: jest.fn().mockResolvedValue(undefined),
    });
    await Promise.resolve();

    const user = coordinator.runUser(message('urgent user message', 'chat-preempt'), jest.fn().mockResolvedValue(undefined), noEmergency);
    releaseBlocker.resolve();

    const heartbeatResult = await heartbeat;
    await user;
    await blocker;

    expect(heartbeatResult.status).toBe('preempted');
    if (heartbeatResult.status === 'preempted') {
      expect(heartbeatResult.error).toBeInstanceOf(HeartbeatPreemptedError);
    }
    expect(runtime.sessions.recordTurn).toHaveBeenCalledTimes(1);
    expect(runtime.sessions.recordTurn.mock.calls[0][0]).toBe('chat-preempt');
    expect(runtime.sessions.recordTurn.mock.calls[0][2]).not.toBe('heartbeat');
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it('does not abort a heartbeat after its provider call is already in flight', async () => {
    const semaphore = new LLMSemaphore();
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const provider: LLMProvider = {
      chat: jest.fn(async (): Promise<LLMResponse> => {
        providerStarted.resolve();
        await releaseProvider.promise;
        return { type: 'text', text: 'heartbeat reply' };
      }),
      embed: jest.fn().mockResolvedValue([]),
    };
    const loop = new AgentLoop(
      provider,
      new ToolRegistry({ allow: ['*'], deny: [] }),
      [],
      { maxIterations: 5, disclaimerEnabled: false },
      semaphore,
    );
    (runtime as unknown as { agentLoop: AgentLoop }).agentLoop = loop;
    const coordinator = new TurnCoordinator(runtime as unknown as ProfileRuntime, semaphore);
    const heartbeat = coordinator.runHeartbeat({
      chatId: 'chat-in-flight',
      input: '[Heartbeat Trigger]\nCheck in',
      egress: jest.fn().mockResolvedValue(undefined),
      afterDelivery: jest.fn().mockResolvedValue(undefined),
    });
    await providerStarted.promise;

    let userStarted = false;
    const user = coordinator.runUser(
      message('user waits', 'chat-in-flight'),
      jest.fn().mockResolvedValue(undefined),
      noEmergency,
    ).then((result: string) => {
      userStarted = true;
      return result;
    });
    await Promise.resolve();
    expect(userStarted).toBe(false);

    releaseProvider.resolve();
    await heartbeat;
    await user;
    expect(userStarted).toBe(true);
  });
});

describe('TurnCoordinator deterministic front-of-turn onboarding', () => {
  let runtime: RuntimeDouble;

  beforeEach(() => {
    runtime = makeRuntime();
    fs.writeFileSync(
      path.join(runtime.workspace, '.redacted', 'onboarding.json'),
      JSON.stringify({ status: 'in_progress', currentStep: 'name', answers: {}, updatedAt: new Date().toISOString() }),
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(runtime.workspace, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('serializes onboarding, skips history and agent execution, and does not interleave a second user turn', async () => {
    const entered = deferred();
    const release = deferred();
    const onboarding = jest.spyOn(OnboardingFlow.prototype, 'handle').mockImplementation(async (input) => {
      entered.resolve();
      await release.promise;
      return { response: `onboarding:${input}` };
    });
    const coordinator = new TurnCoordinator(runtime as unknown as ProfileRuntime, new LLMSemaphore());
    const egress = jest.fn().mockResolvedValue(undefined);
    const first = coordinator.runUser(message('first onboarding answer'), egress, noEmergency);
    await entered.promise;
    const second = coordinator.runUser(message('second onboarding answer'), egress, noEmergency);
    await Promise.resolve();
    expect(onboarding).toHaveBeenCalledTimes(1);
    expect(egress).not.toHaveBeenCalled();

    release.resolve();
    await Promise.all([first, second]);
    expect(onboarding).toHaveBeenCalledTimes(2);
    expect(runtime.sessions.prepareHistory).not.toHaveBeenCalled();
    expect(runtime.agentLoop.run).not.toHaveBeenCalled();
  });
});
