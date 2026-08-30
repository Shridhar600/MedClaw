import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import type { AppConfig } from '../../src/config/types';

// E1.5 (M-3) — handleTestMessage↔handleMessage reconcile (CLAUDE.md mirror-sync law).
// Two provable divergences on current code:
//   1. handleTestMessage runs the agent loop UNGUARDED → the test/e2e path throws where production
//      (handleMessage) degrades to the canned fallback. Fixed: same try/catch + fallback.
//   2. handleMessage's media-error branch was the ONLY branch that skipped the F4 lossless capture.
//      Fixed: captureUserTurn(text) first (no-ops on an empty caption).
// (The plan also listed a "post-onboarding emergency recheck" for handleTestMessage — verified
// REDUNDANT: the pre-onboarding emergency check fires first on the same immutable text, so behavioral
// parity already holds. Adding it would be untestable dead code, so it is intentionally omitted.)

const FALLBACK = "I'm having trouble right now. Please try again in a moment.";

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

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('handleTestMessage agent-run failure guard (M-3 parity)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('degrades to the canned fallback (does not throw) when the agent loop rejects', async () => {
    const gateway = new Gateway(makeConfig());
    (gateway as any).getProfileForChat = () => 'default';
    (gateway as any).handleOnboarding = jest.fn().mockResolvedValue(undefined);
    (gateway as any).agentLoop = { run: jest.fn().mockRejectedValue(new Error('boom')) };
    (gateway as any).sessions = {
      prepareHistory: jest.fn().mockResolvedValue([]),
      recordTurn: jest.fn().mockResolvedValue(undefined),
      resetSession: jest.fn(),
    };

    const res = await gateway.handleTestMessage('chat-1', 'Can I eat rice?');
    expect(res).toBe(FALLBACK);
  });

  it('degrades to the fallback and logs sanitized when prepareHistory rejects with PHI', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());
    (gateway as any).getProfileForChat = () => 'default';
    (gateway as any).handleOnboarding = jest.fn().mockResolvedValue(undefined);
    (gateway as any).agentLoop = { run: jest.fn() };
    (gateway as any).sessions = {
      prepareHistory: jest.fn().mockRejectedValue(new Error('private session glucose 240 context')),
      recordTurn: jest.fn().mockResolvedValue(undefined),
      resetSession: jest.fn(),
    };

    const res = await gateway.handleTestMessage('chat-1', 'Can I eat rice?');
    expect(res).toBe(FALLBACK);
    expect((gateway as any).agentLoop.run).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().map(String).join('\n')).not.toContain('glucose');
  });
});

describe('persistence-failure guards (C-2 / H9 — never-crash + mirror-sync)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('test path: an emergency recordTurn failure still returns the guidance (does not throw)', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());
    const emergencyText = 'I have severe chest pain and cannot breathe';
    const expected = (gateway as any).handleEmergencyInput(emergencyText);
    (gateway as any).getProfileForChat = () => 'default';
    (gateway as any).capturePipeline = { ingest: jest.fn().mockResolvedValue(undefined) };
    (gateway as any).sessions = {
      recordTurn: jest.fn().mockRejectedValue(new Error('disk full: glucose 240')),
      recordPromptUsage: jest.fn().mockResolvedValue(undefined),
      resetSession: jest.fn(),
    };

    const res = await gateway.handleTestMessage('chat-e', emergencyText);
    expect(res).toBe(expected);
    expect(errorSpy.mock.calls.flat().map(String).join('\n')).not.toContain('glucose');
  });

  it('test path: a post-agent recordTurn/recordPromptUsage failure still returns the answer', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const gateway = new Gateway(makeConfig());
    (gateway as any).getProfileForChat = () => 'default';
    (gateway as any).handleOnboarding = jest.fn().mockResolvedValue(undefined);
    (gateway as any).capturePipeline = { ingest: jest.fn().mockResolvedValue(undefined) };
    (gateway as any).debouncedReconcile = jest.fn().mockResolvedValue(undefined);
    (gateway as any).agentLoop = {
      run: jest.fn().mockResolvedValue({
        text: 'Eat rice in moderation.',
        trace: [{ role: 'assistant', content: 'Eat rice in moderation.' }],
        usedTools: [],
        healthResponse: false,
        lastPromptTokens: 10,
      }),
    };
    (gateway as any).sessions = {
      prepareHistory: jest.fn().mockResolvedValue([]),
      recordTurn: jest.fn().mockRejectedValue(new Error('disk full: glucose 240')),
      recordPromptUsage: jest.fn().mockResolvedValue(undefined),
      resetSession: jest.fn(),
    };

    const res = await gateway.handleTestMessage('chat-p', 'Can I eat rice?');
    expect(res).toBe('Eat rice in moderation.');
  });

  it('onboarding: a recordTurn failure still returns the onboarding response (does not throw)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-onb-'));
    const gateway = new Gateway(makeConfig());
    (gateway as any).getEffectiveWorkspace = () => ws;
    (gateway as any).sessions = {
      recordTurn: jest.fn().mockRejectedValue(new Error('disk full: glucose 240')),
      resetSession: jest.fn(),
    };

    const res = await (gateway as any).handleOnboarding('chat-o', '/onboarding restart');
    expect(typeof res).toBe('string');
    expect(res.length).toBeGreaterThan(0);
    fs.rmSync(ws, { recursive: true, force: true });
  });
});

describe('handleMessage media-error lossless capture (M-3 / F4 parity)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('captures the raw caption to the lossless lane on media-download failure', async () => {
    const gateway = new Gateway(makeConfig());
    const ingest = jest.fn().mockResolvedValue(undefined);
    (gateway as any).getProfileForChat = () => 'default';
    (gateway as any).capturePipeline = { ingest };
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    (gateway as any).agentLoop = { run: jest.fn() };
    (gateway as any).sessions = {
      prepareHistory: jest.fn(),
      recordTurn: jest.fn().mockResolvedValue(undefined),
      resetSession: jest.fn(),
    };
    (gateway as any).handleOnboarding = jest.fn().mockResolvedValue(undefined);

    await (gateway as any).handleMessage({
      chatId: 'chat-media',
      userId: 'user-1',
      text: 'Here is my blood test showing glucose 240',
      mediaError: 'Failed to download report.pdf',
    });

    expect((gateway as any).agentLoop.run).not.toHaveBeenCalled();
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { text: 'Here is my blood test showing glucose 240' } }),
    );
  });

  it('does not capture an empty caption on media-download failure (guard preserved)', async () => {
    const gateway = new Gateway(makeConfig());
    const ingest = jest.fn().mockResolvedValue(undefined);
    (gateway as any).getProfileForChat = () => 'default';
    (gateway as any).capturePipeline = { ingest };
    (gateway as any).channel = { send: jest.fn().mockResolvedValue(undefined) };
    (gateway as any).agentLoop = { run: jest.fn() };
    (gateway as any).sessions = {
      prepareHistory: jest.fn(),
      recordTurn: jest.fn().mockResolvedValue(undefined),
      resetSession: jest.fn(),
    };
    (gateway as any).handleOnboarding = jest.fn().mockResolvedValue(undefined);

    await (gateway as any).handleMessage({
      chatId: 'chat-media',
      userId: 'user-1',
      text: '   ',
      mediaError: 'Failed to download report.pdf',
    });

    expect(ingest).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
