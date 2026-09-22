// tests/providers/openrouter.test.ts
// OpenRouter = OpenAI-compatible router added as a first-class provider type.
// Research: 505/research/13-openrouter-integration.md. Live-probed 2026-08-24:
// tools work with mandatory reasoning; reasoning_effort:'none' is REJECTED;
// reasoning_effort:'low' is valid; usage object comes back on every response.
import { createProvider } from '../../src/providers/factory';
import { OpenAIProvider } from '../../src/providers/openai';
import { providerEnvVar } from '../../src/config/provider-env';
import type { ProviderConfig } from '../../src/config/types';

const createMock = jest.fn();
const clientConstructorArgs: Array<Record<string, unknown>> = [];
jest.mock('openai', () => ({
  __esModule: true,
  default: class {
    constructor(args: Record<string, unknown>) {
      clientConstructorArgs.push(args);
    }
    chat = { completions: { create: (...a: unknown[]): Promise<unknown> => createMock(...a) } };
  },
}));

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { type: 'openrouter', model: 'stealth/ox-alpha', apiKey: 'or-test', ...overrides };
}

const textReply = {
  choices: [{ message: { content: 'ok' } }],
  usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
};
const toolReply = {
  choices: [{
    message: {
      content: null,
      tool_calls: [{
        id: 'call_x1',
        type: 'function',
        function: { name: 'probe_ack', arguments: '{}' },
      }],
    },
  }],
  usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 },
};

describe('OpenRouter provider integration', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue(textReply);
    clientConstructorArgs.length = 0;
    delete process.env.OPENROUTER_API_KEY;
  });

  it("providerEnvVar('openrouter') resolves OPENROUTER_API_KEY", () => {
    expect(providerEnvVar('openrouter')).toBe('OPENROUTER_API_KEY');
  });

  it('factory routes the openrouter type to the OpenAI-compatible provider', () => {
    const provider = createProvider(makeConfig());
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.modelName).toBe('stealth/ox-alpha');
  });

  it('defaults the base URL to the OpenRouter endpoint when config omits it', () => {
    const config = makeConfig();
    delete (config as Partial<ProviderConfig>).baseUrl;
    const provider = createProvider(config) as OpenAIProvider;
    expect(provider.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('honors an explicit baseUrl override', () => {
    const provider = createProvider(makeConfig({ baseUrl: 'https://proxy.example.com/v1' })) as OpenAIProvider;
    expect(provider.baseUrl).toBe('https://proxy.example.com/v1');
  });

  it('falls back to OPENROUTER_API_KEY from the environment when apiKey is absent', async () => {
    process.env.OPENROUTER_API_KEY = 'or-env-key';
    const config = makeConfig();
    delete config.apiKey;
    await (createProvider(config) as OpenAIProvider).chat([{ role: 'user', content: 'hi' }]);
    expect(clientConstructorArgs[0]?.apiKey).toBe('or-env-key');
  });

  it('prefers config.apiKey over the environment variable', async () => {
    process.env.OPENROUTER_API_KEY = 'or-env-key';
    await (createProvider(makeConfig({ apiKey: 'or-config-key' })) as OpenAIProvider).chat([
      { role: 'user', content: 'hi' },
    ]);
    expect(clientConstructorArgs[0]?.apiKey).toBe('or-config-key');
  });

  it("sends an explicit reasoningEffort:'low' even for a name-matched reasoning model", async () => {
    // Explicit config must beat the gpt-5/o-series name heuristic (#13 workaround
    // must stay overridable — stealth/ox-alpha REJECTS 'none').
    const provider = createProvider(makeConfig({ model: 'gpt-5.6-luna', reasoningEffort: 'low' }));
    await (provider as OpenAIProvider).chat([{ role: 'user', content: 'hi' }], [
      { type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: {}, required: [] } } },
    ]);
    expect(createMock.mock.calls[0][0].reasoning_effort).toBe('low');
  });

  it('name-heuristic fallback still applies when reasoningEffort is unset', async () => {
    const provider = createProvider(makeConfig({ model: 'gpt-5.6-luna', reasoningEffort: undefined }));
    await (provider as OpenAIProvider).chat([{ role: 'user', content: 'hi' }], [
      { type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: {}, required: [] } } },
    ]);
    expect(createMock.mock.calls[0][0].reasoning_effort).toBe('none');
  });

  it('sends no reasoning_effort for a slug-style model without explicit config', async () => {
    const provider = createProvider(makeConfig());
    await (provider as OpenAIProvider).chat([{ role: 'user', content: 'hi' }], [
      { type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: {}, required: [] } } },
    ]);
    expect(createMock.mock.calls[0][0].reasoning_effort).toBeUndefined();
  });

  it('captures token usage on text responses', async () => {
    const result = await (createProvider(makeConfig()) as OpenAIProvider).chat([
      { role: 'user', content: 'hi' },
    ]);
    expect(result.type).toBe('text');
    expect(result.usage).toEqual({
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
      reasoningTokens: undefined,
    });
  });

  it('captures token usage (incl. reasoning tokens) on tool_call responses', async () => {
    createMock.mockResolvedValue({
      ...toolReply,
      usage: {
        prompt_tokens: 20,
        completion_tokens: 9,
        total_tokens: 29,
        completion_tokens_details: { reasoning_tokens: 4 },
      },
    });
    const result = await (createProvider(makeConfig()) as OpenAIProvider).chat(
      [{ role: 'user', content: 'hi' }],
      [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object', properties: {}, required: [] } } }],
    );
    expect(result.type).toBe('tool_call');
    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 9,
      totalTokens: 29,
      reasoningTokens: 4,
    });
  });
});
