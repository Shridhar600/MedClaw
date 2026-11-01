// A real Gateway (real runtime, stores, recall, safety) for flow tests. Only the chat model is scripted.
import { Gateway } from '../../src/gateway/gateway';
import type { EffectiveConfig } from '../../src/config/types';
import type { LLMProvider, LLMResponse, Message, ToolSchema } from '../../src/providers/types';
import { fixtureOwner, ownerSelection } from './test-config';
import { bindGatewayOwner } from './gateway-owner-deps';

export const LIVE_CHAT = 'chat-1';

export function liveGatewayConfig(rootDir: string): EffectiveConfig {
  const owner = fixtureOwner(rootDir);
  return {
    schemaVersion: 2,
    ...ownerSelection(owner),
    providers: {
      main: { type: 'ollama', model: 'test-main', baseUrl: 'http://127.0.0.1:9/v1' },
      medical: { type: 'ollama', model: 'test-medical', baseUrl: 'http://127.0.0.1:9/v1' },
      embeddings: { type: 'ollama', model: 'test-embed', baseUrl: 'http://127.0.0.1:9/v1' },
    },
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
      timezone: 'UTC',
      storePath: owner.storePath,
      recovery: { enabled: false, windowMinutes: 60 },
      retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 },
      audit: { path: owner.auditLogPath },
      policy: {
        quietHours: { enabled: false, start: '22:00', end: '07:00' },
        skipIfChatActiveWithinMinutes: 0,
        defaults: {
          morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'Morning' },
          eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'Evening' },
        },
      },
    },
    agent: { maxIterations: 6, disclaimerEnabled: true },
  };
}

/** One model call as the scripted model sees it. */
export interface ModelCall {
  messages: Message[];
  tools: string[];
  system: string;
}

/** A scripted chat model: `reply` decides each response; every call is recorded. */
export class ScriptedModel implements LLMProvider {
  readonly calls: ModelCall[] = [];
  constructor(private readonly reply: (call: ModelCall) => LLMResponse) {}

  async chat(messages: Message[], tools?: ToolSchema[]): Promise<LLMResponse> {
    const call = { messages, tools: (tools ?? []).map((t) => t.function.name), system: String(messages[0]?.content ?? '') };
    this.calls.push(call);
    return this.reply(call);
  }

  async embed(): Promise<number[]> {
    return [];
  }
}

/** Boot a real Gateway for the fixture owner, bound to `LIVE_CHAT`, with `model` as the chat model. */
export async function startLiveGateway(rootDir: string, model: LLMProvider): Promise<Gateway> {
  const config = liveGatewayConfig(rootDir);
  const gateway = new Gateway(config, await bindGatewayOwner(config, LIVE_CHAT));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await gateway.start();
  } finally {
    warn.mockRestore();
    log.mockRestore();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (gateway as any).agentLoop.provider = model;
  return gateway;
}
