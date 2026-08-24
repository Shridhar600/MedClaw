// P2 E2E — the recall/context gate scenarios through the REAL composition root
// (Gateway.handleTestMessage → prepareSystem → per-turn recall + v2 assembler). Hermetic: telegram
// off; providers point at unreachable endpoints so embeddings are unavailable → recall runs the
// keyword-only/degrade path. The chat provider is swapped for a capturing stub so we can read back
// the assembled system prompt each turn.
//
// NOTE (KNEE-06): the SEMANTIC "workout"→"knee" retrieval needs real embeddings, so it stays the live
// human-testable milestone (the engine goldens + tests/acceptance/recall.test.ts cover it
// deterministically). Here we prove the SAFETY.md strong path (KNEE-07 guaranteed retrieval) and the
// stale-fail-closed next-turn behavior (CONTRA-09 / KNEE-10), neither of which needs embeddings.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Gateway } from '../../src/gateway/gateway';
import type { AppConfig } from '../../src/config/types';
import type { LLMProvider, LLMResponse, Message } from '../../src/providers/types';

function makeConfig(tmpDir: string): AppConfig {
  return {
    providers: {
      main: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
      medical: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
      embeddings: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
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
      enabled: false,
      timezone: 'Asia/Kolkata',
      storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
      policy: {
        quietHours: { enabled: true, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 60,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 15, disclaimerEnabled: true },
  };
}

function captureProvider(gateway: Gateway): Message[][] {
  const seen: Message[][] = [];
  const scripted: LLMProvider = {
    async chat(msgs: Message[]): Promise<LLMResponse> { seen.push(msgs); return { type: 'text', text: 'ok' }; },
    async embed(): Promise<number[]> { return []; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).agentLoop.provider = scripted;
  return seen;
}

async function startGateway(tmpDir: string): Promise<Gateway> {
  const gateway = new Gateway(makeConfig(tmpDir));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await gateway.start();
  warn.mockRestore();
  log.mockRestore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).handleOnboarding = async (): Promise<null> => null;
  return gateway;
}

describe('P2 E2E — recall/context gate via handleTestMessage', () => {
  let tmpDir: string;
  let gateway: Gateway;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-p2-e2e-')); });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryOf = (): any => (gateway as any).agentLoop.registry;
  const lastSystem = (seen: Message[][]): string => String(seen[seen.length - 1][0].content);

  it('KNEE-07 — a safety-relevant knee injury is guaranteed on "plan me a workout" via SAFETY.md', async () => {
    gateway = await startGateway(tmpDir);
    await registryOf().execute('ledger_record', {
      entity: 'knee-injury', type: 'condition', safety_relevant: true,
      fields: { diagnosis: 'MCL sprain', precautions: 'avoid heavy leg loading' },
      note: 'knee MCL sprain, avoid heavy leg loading',
    });
    const seen = captureProvider(gateway);

    await gateway.handleTestMessage('chat-1', 'Plan me a workout routine to get back in shape');

    // SAFETY.md is injected fresh every turn, so the knee precaution reaches the prompt even though
    // semantic embedding recall is unavailable in the hermetic env (the strong path).
    expect(lastSystem(seen)).toContain('knee-injury');
  });

  it('CONTRA-09 / KNEE-10 — a retracted medication is gone from the next turn (fail-closed)', async () => {
    gateway = await startGateway(tmpDir);
    await registryOf().execute('ledger_record', {
      entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, note: 'metformin 500mg',
    });
    const seen = captureProvider(gateway);

    await gateway.handleTestMessage('chat-1', 'what is in my current health record');
    expect(lastSystem(seen)).toContain('metformin (medication) active');

    // Retract metformin (med → confirm round-trip).
    const rm = await registryOf().execute('ledger_remove', { entity: 'metformin', type: 'medication', reason: 'never took it' });
    const tokenMatch = String(rm.content[0].text).match(/tokenId="([0-9a-f-]+)"/i);
    expect(tokenMatch).not.toBeNull();
    await registryOf().execute('ledger_update', { tokenId: tokenMatch![1], confirm: true });

    await gateway.handleTestMessage('chat-1', 'give me a quick overview again');
    // The very next turn's ACTIVE HEALTH FACTS no longer lists metformin (status filtered to active).
    expect(lastSystem(seen)).not.toContain('metformin (medication) active');
  });
});
