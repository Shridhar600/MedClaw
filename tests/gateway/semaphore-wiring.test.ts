import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentLoop } from '../../src/agent/agent-loop';
import { LLMSemaphore } from '../../src/tools/semaphore';
import { SessionManager } from '../../src/gateway/session';
import { Gateway } from '../../src/gateway/gateway';
import { ToolRegistry } from '../../src/tools/registry';
import type { LLMProvider, LLMResponse } from '../../src/providers/types';
import type { AppConfig } from '../../src/config/types';
import { HeartbeatStore } from '../../src/scheduler/store';
import { HeartbeatScheduler } from '../../src/scheduler/runtime';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeProvider(responses: LLMResponse[]): LLMProvider {
  let idx = 0;
  return {
    async chat(): Promise<LLMResponse> {
      return responses[idx++] ?? { type: 'text', text: 'done' };
    },
    async embed(): Promise<number[]> { return []; },
  };
}

describe('LLM semaphore wiring', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-sem-wiring-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
    return {
      providers: {
        main: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
        medical: { type: 'ollama', model: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1' },
        embeddings: { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' },
      },
      channels: { telegram: { enabled: false, botToken: '' } },
      tools: { allow: ['*'], deny: [] },
      memory: {
        workspace: path.join(tmpDir, 'workspace'),
        search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
        bootstrapMaxChars: 20000,
      },
      sessions: {
        softResetAfterMinutes: 240,
        hardResetAfterMinutes: 1440,
        compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 10 },
      },
      heartbeat: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
        recovery: { enabled: false, windowMinutes: 60 },
        retry: { maxRetries: 3, backoffMinutes: 5 },
        rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
        audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
        policy: {
          quietHours: { enabled: false, start: '22:00', end: '07:00' },
          skipIfChatActiveWithinMinutes: 60,
          defaults: {
            morningCheckIn: { enabled: true, cron: '0 8 * * *', prompt: 'Morning check-in prompt.' },
            eveningSummary: { enabled: true, cron: '0 21 * * *', prompt: 'Evening summary prompt.' },
          },
        },
      },
      agent: { maxIterations: 15, disclaimerEnabled: true },
      ...overrides,
    };
  }

  it('concurrent user + heartbeat turns: user provider call happens first even when heartbeat is queued first', async () => {
    const firstChatStarted = deferred();
    const firstChatDone = deferred();
    const chatOrder: string[] = [];

    const recordingProvider: LLMProvider = {
      async chat(messages): Promise<LLMResponse> {
        const last = messages[messages.length - 1];
        chatOrder.push(last?.content ?? 'unknown');
        if (chatOrder.length === 1) {
          firstChatStarted.resolve();
          await firstChatDone.promise;
        }
        return { type: 'text', text: 'ok' };
      },
      async embed() { return []; },
    };

    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    const semaphore = new LLMSemaphore();
    const loop = new AgentLoop(recordingProvider, registry, [], { maxIterations: 15, disclaimerEnabled: false }, semaphore);

    // Start a heartbeat blocker to occupy the running slot so subsequent
    // calls must queue.
    const hbBlocker = loop.run('hb1-blocker', [], { chatId: 'c1', origin: 'heartbeat' });
    await firstChatStarted.promise;

    // Queue a second heartbeat while drain is paused.
    const hb2 = loop.run('hb2', [], { chatId: 'c1', origin: 'heartbeat' });
    await Promise.resolve();

    // Then queue a user job — should win by priority.
    const user = loop.run('user-input', [], { chatId: 'c1', origin: 'user' });

    firstChatDone.resolve();
    await hbBlocker;
    await user;
    await hb2;

    // 3 chats called: hb1-blocker, then user-input (priority), then hb2
    expect(chatOrder).toEqual(['hb1-blocker', 'user-input', 'hb2']);
  });

  it('heartbeat queue overflow: handleScheduledJob logs a warn and does not throw', async () => {
    const firstChatEntered = deferred();
    const firstChatDone = deferred();
    let chatCallCount = 0;

    const blockingProvider: LLMProvider = {
      async chat(): Promise<LLMResponse> {
        chatCallCount++;
        if (chatCallCount === 1) {
          firstChatEntered.resolve();
          await firstChatDone.promise;
        }
        return { type: 'text', text: 'done' };
      },
      async embed() { return []; },
    };

    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    const semaphore = new LLMSemaphore();
    const loop = new AgentLoop(blockingProvider, registry, [], { maxIterations: 15, disclaimerEnabled: false }, semaphore);

    const blocker = loop.run('blocker', [], { chatId: 'c1', origin: 'heartbeat' });
    await firstChatEntered.promise;

    const queued: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i++) {
      queued.push(loop.run(`hb-${i}`, [], { chatId: 'c1', origin: 'heartbeat' }));
    }
    await Promise.resolve();

    const config = makeConfig();
    const gateway = new Gateway(config);
    const send = jest.fn().mockResolvedValue(undefined);
    const sessions = new SessionManager(240, 1440, path.join(tmpDir, 'sessions'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).channel = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).agentLoop = loop;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).sessions = sessions;

    const scheduler = new HeartbeatScheduler(
      new HeartbeatStore(path.join(tmpDir, 'heartbeats', 'jobs.json')),
      async () => undefined,
      'Asia/Kolkata',
      {
        auditLogPath: config.heartbeat.audit.path,
        defaultMaxRetries: config.heartbeat.retry.maxRetries,
        retryBackoffMinutes: config.heartbeat.retry.backoffMinutes,
      },
    );
    await scheduler.start();
    const job = await scheduler.createJob({
      title: 'Queue-overflow check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      prompt: 'This should be rejected by the semaphore.',
      source: 'system',
      kind: 'routine',
      policyKey: 'defaults:morning-check-in',
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gateway as any).scheduler = scheduler;

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let assertionError: unknown;
    try {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (gateway as any).handleScheduledJob(job, true),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Heartbeat queue full'),
      );

      const refreshed = await scheduler.getStore().get(job.id);
      expect(refreshed?.deliveryState).toBe('retry-wait');
    } catch (e) {
      assertionError = e;
    } finally {
      warnSpy.mockRestore();
      firstChatDone.resolve();
      // eslint-disable-next-line no-empty
      try { await blocker; } catch {}
      // eslint-disable-next-line no-empty
      try { await Promise.all(queued); } catch {}
      // eslint-disable-next-line no-empty
      try { await scheduler.stop(); } catch {}
    }

    if (assertionError) {
      throw assertionError;
    }
  });

  it('no semaphore passed: behavior unchanged (AgentLoop without 5th arg still works)', async () => {
    const provider = makeProvider([{ type: 'text', text: 'no-sem-ok' }]);
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    const loop = new AgentLoop(provider, registry, [], { maxIterations: 15, disclaimerEnabled: false });

    const result = await loop.run('hello', [], { chatId: 'c1', origin: 'user' });
    expect(result.text).toBe('no-sem-ok');
    expect(result.trace.length).toBe(1);
  });
});