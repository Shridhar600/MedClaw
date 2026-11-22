import type { EffectiveConfig } from '../../src/config/types';
import { checkSystemReadiness } from '../../src/providers/healthcheck';
import {} from '../helpers/test-config';
import { ownerSelection, fixtureOwner } from '../helpers/test-config';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

const moduleRoot = makeTestTemp('readiness-healthcheck');
const moduleOwner = (): ReturnType<typeof fixtureOwner> => fixtureOwner(moduleRoot);
afterAll(() => removeTestTemp(moduleRoot));

function config(): EffectiveConfig {
  return {
  schemaVersion: 2,
  ...ownerSelection(moduleOwner()),
    providers: {
      main: { type: 'ollama', model: 'main-model', baseUrl: 'http://127.0.0.1:11434/v1' },
      medical: { type: 'ollama', model: 'medical-model', baseUrl: 'http://127.0.0.1:11434/v1' },
      embeddings: { type: 'ollama', model: 'embedding-model', baseUrl: 'http://127.0.0.1:11434/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    memory: {
      workspace: '/unused',
      search: { hybridWeights: { vector: 0.7, keyword: 0.3 } },
      bootstrapMaxChars: 20000,
    },
    sessions: {
      compaction: { enabled: true, memoryFlush: true, keepRecentTurns: 10 },
    },
    heartbeat: { enabled: false, timezone: 'Asia/Kolkata' },
    agent: { maxIterations: 5 },
  } as unknown as EffectiveConfig;
}

describe('bounded readiness probes', () => {
  it('runs independent provider probes concurrently', async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchImpl = jest.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: '0.1.0', models: [
          { name: 'main-model' },
          { name: 'medical-model' },
          { name: 'embedding-model' },
        ] }),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await checkSystemReadiness(config(), {
      allowNetworkChecks: true,
      fetchImpl,
      timeoutMs: 100,
    });

    expect(result.providers.every((provider) => provider.ready)).toBe(true);
    expect(maximumActive).toBeGreaterThan(1);
  });

  it('propagates a shared abort signal to in-flight network probes', async () => {
    const controller = new AbortController();
    let aborted = 0;
    const fetchImpl = jest.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        aborted += 1;
        reject(new Error('probe aborted'));
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener('abort', onAbort, { once: true });
      }
    })) as unknown as typeof fetch;

    const pending = checkSystemReadiness(config(), {
      allowNetworkChecks: true,
      fetchImpl,
      timeoutMs: 1000,
      overallTimeoutMs: 1000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;

    expect(aborted).toBeGreaterThan(0);
    expect(result.providers.some((provider) => !provider.ready)).toBe(true);
  });
});
