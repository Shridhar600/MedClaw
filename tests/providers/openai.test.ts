import { OpenAIProvider } from '../../src/providers/openai';
import type { ProviderConfig } from '../../src/config/types';

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

describe('OpenAIProvider robustness', () => {
  beforeEach(() => createMock.mockReset());

  it('fails a request that never answers instead of hanging the turn', async () => {
    createMock.mockImplementationOnce((_params: unknown, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))));
    const slow = new OpenAIProvider({ type: 'openai', model: 'gpt-4o', apiKey: 'sk-test' }, 50);
    await expect(slow.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow();
  });

  it('reports an empty reply as a provider error', async () => {
    createMock.mockResolvedValueOnce({ choices: [] });
    await expect(makeProvider('gpt-4o').chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('no choices');
  });

  it('turns malformed tool arguments into an empty call the tool layer can refuse', async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'memory_get', arguments: 'not json' } }] } }],
    });
    const result = await makeProvider('gpt-4o').chat([{ role: 'user', content: 'hi' }], tools);
    expect(result).toMatchObject({ type: 'tool_call', toolCalls: [{ id: 'c1', name: 'memory_get', arguments: {} }] });
  });
});
