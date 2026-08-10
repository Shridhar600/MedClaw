import { OpenAIProvider } from '../../src/providers/openai';
import type { ProviderConfig } from '../../src/config/types';

// Capture the params the provider sends to the OpenAI SDK without a network call.
const createMock = jest.fn();
jest.mock('openai', () => {
  return {
    __esModule: true,
    default: class {
      chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
    },
  };
});

function makeProvider(model: string): OpenAIProvider {
  const config: ProviderConfig = { type: 'openai', model, apiKey: 'sk-test' };
  return new OpenAIProvider(config);
}

const textReply = { choices: [{ message: { content: 'ok' } }] };
const tools = [
  { type: 'function' as const, function: { name: 'memory_get', description: 'read', parameters: { type: 'object', properties: {}, required: [] } } },
];

describe('OpenAIProvider reasoning-model handling (forka #13)', () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue(textReply);
  });

  it("sends reasoning_effort:'none' for a gpt-5 model when tools are present", async () => {
    await makeProvider('gpt-5.6-luna').chat([{ role: 'user', content: 'hi' }], tools);
    const params = createMock.mock.calls[0][0];
    expect(params.reasoning_effort).toBe('none');
    expect(params.tools).toHaveLength(1);
  });

  it("sends reasoning_effort:'none' for an o-series model", async () => {
    await makeProvider('o3-mini').chat([{ role: 'user', content: 'hi' }], tools);
    expect(createMock.mock.calls[0][0].reasoning_effort).toBe('none');
  });

  it('does NOT send reasoning_effort for a non-reasoning model (gpt-4o)', async () => {
    await makeProvider('gpt-4o').chat([{ role: 'user', content: 'hi' }], tools);
    expect(createMock.mock.calls[0][0].reasoning_effort).toBeUndefined();
  });

  it("applies reasoning_effort:'none' on the image path too", async () => {
    await makeProvider('gpt-5.6-luna').chatWithImages(
      [{ role: 'user', content: 'look' }],
      [{ mimeType: 'image/png', data: 'AAAA' }],
    );
    expect(createMock.mock.calls[0][0].reasoning_effort).toBe('none');
  });
});
