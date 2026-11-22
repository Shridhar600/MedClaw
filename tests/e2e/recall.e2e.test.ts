import * as fs from 'fs';
import { Gateway } from '../../src/gateway/gateway';
import type { EffectiveConfig } from '../../src/config/types';
import type { LLMProvider, LLMResponse, Message } from '../../src/providers/types';
import { fixtureOwner, ownerSelection } from '../helpers/test-config';
import { bindGatewayOwner } from '../helpers/gateway-owner-deps';
import { makeTestTemp } from '../helpers/test-temp';
import { ownerTools } from '../helpers/owner-tools';

const CHAT_BINDING = 'chat-1';

function makeConfig(tmpDir: string): EffectiveConfig {
const owner = fixtureOwner(tmpDir);
  return {
  schemaVersion: 2,
  ...ownerSelection(owner),
    providers: {
      main: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
      medical: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
      embeddings: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace: owner.workspace,
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20000,
    },
    sessions: {
      compaction: { enabled: true, memoryFlush: true, keepRecentTurns: 10 },
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
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 15 },
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
  const gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await gateway.start();
  warn.mockRestore();
  log.mockRestore();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway.runtimeInstance!.turnCoordinator as any).handleOnboarding = async (): Promise<null> => null;
  return gateway;
}

describe('E2E — recall/context gate via handleTestMessage', () => {
  let tmpDir: string;
  let gateway: Gateway;

  beforeEach(() => { tmpDir = makeTestTemp('redacted-recall-e2e-'); });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registryOf = (): any => ownerTools((gateway as any).agentLoop.registry);
  const lastSystem = (seen: Message[][]): string => String(seen[seen.length - 1][0].content);

  it('a safety-relevant knee injury is guaranteed on "plan me a workout" via SAFETY.md', async () => {
    gateway = await startGateway(tmpDir);
    await registryOf().execute('ledger_record', {
      entity: 'knee-injury', type: 'condition', safety_relevant: true,
      fields: { diagnosis: 'MCL sprain', precautions: 'avoid heavy leg loading' },
      note: 'knee MCL sprain, avoid heavy leg loading',
    });
    const seen = captureProvider(gateway);

    await gateway.handleTestMessage('chat-1', 'Plan me a workout routine to get back in shape');

    expect(lastSystem(seen)).toContain('knee-injury');
  });

  it('a retracted medication is gone from the next turn (fail-closed)', async () => {
    gateway = await startGateway(tmpDir);
    await registryOf().execute('ledger_record', {
      entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, note: 'metformin 500mg',
    });
    const seen = captureProvider(gateway);

    await gateway.handleTestMessage('chat-1', 'what is in my current health record');
    expect(lastSystem(seen)).toContain('metformin (medication) active');

    const rm = await registryOf().execute('ledger_remove', { entity: 'metformin', type: 'medication', reason: 'never took it' });
    const tokenMatch = String(rm.content[0].text).match(/tokenId="([0-9a-f-]+)"/i);
    expect(tokenMatch).not.toBeNull();
    await registryOf().execute('ledger_update', { tokenId: tokenMatch![1], confirm: true });

    await gateway.handleTestMessage('chat-1', 'give me a quick overview again');
    expect(lastSystem(seen)).not.toContain('metformin (medication) active');
  });
});
