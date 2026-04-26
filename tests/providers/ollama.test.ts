// tests/providers/ollama.test.ts
import { OllamaProvider } from '../../src/providers/ollama';

// Mock the HTTP call so tests don't need Ollama running
global.fetch = jest.fn() as typeof fetch;

describe('OllamaProvider', () => {
  const provider = new OllamaProvider({
    type: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'kimi-k2.5:cloud',
  });

  afterEach(() => jest.clearAllMocks());

  it('sends a chat request and returns text response', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: 'Hello!', tool_calls: undefined } }],
      }),
    });

    const result = await provider.chat([{ role: 'user', content: 'Hi' }]);
    expect(result.type).toBe('text');
    if (result.type === 'text') {
      expect(result.text).toBe('Hello!');
    }
  });

  it('returns tool_call response when LLM requests a tool', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'memory_get', arguments: '{"path":"SOUL.md"}' },
            }],
          },
        }],
      }),
    });

    const result = await provider.chat([{ role: 'user', content: 'What is my soul?' }]);
    expect(result.type).toBe('tool_call');
    if (result.type === 'tool_call') {
      expect(result.toolCall.name).toBe('memory_get');
      expect(result.toolCall.arguments).toEqual({ path: 'SOUL.md' });
    }
  });

  it('generates embeddings', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }),
    });

    const embedding = await provider.embed('test text');
    expect(embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('sends image attachments through the native Ollama vision API', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { role: 'assistant', content: 'Image analysis complete.' },
      }),
    });

    const result = await provider.chatWithImages!(
      [
        { role: 'system', content: 'Analyze medical reports safely.' },
        { role: 'user', content: 'Analyze this image.' },
      ],
      [{ mimeType: 'image/jpeg', data: 'abc123', filename: 'report.jpg' }]
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      })
    );
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.messages[1].images).toEqual(['abc123']);
    expect(result).toEqual({ type: 'text', text: 'Image analysis complete.' });
  });

  it('throws on non-ok HTTP response', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal server error',
    });

    await expect(provider.chat([{ role: 'user', content: 'Hi' }])).rejects.toThrow('Ollama API error: 500');
  });
});
