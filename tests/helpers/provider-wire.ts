import type { ProviderConfig } from '../../src/config';
import type OpenAI from 'openai';

let transport: typeof globalThis.fetch | undefined;

/** Inject only HTTP transport through the installed SDK's public constructor option. */
export function offlineOpenAIFactory(): { __esModule: true; default: typeof OpenAI } {
  const SDK = jest.requireActual<{ default: typeof OpenAI }>('openai').default;
  return {
    __esModule: true,
    default: class extends SDK {
      constructor(options: ConstructorParameters<typeof SDK>[0]) {
        super({ ...options, fetch: async (url, init) => {
          if (!transport) throw new Error('Unscripted provider transport refused');
          return transport(url, init);
        } });
      }
    },
  };
}

/** Real adapter + installed SDK; replace only the final HTTP transport, never key resolution. */
export async function observeProviderWire(config: ProviderConfig): Promise<{
  requests: Array<{ url: string; authorization: string | null; model: string }>;
  reply: unknown;
}> {
  const requests: Array<{ url: string; authorization: string | null; model: string }> = [];
  if (transport) throw new Error('Provider probes must run serially');
  transport = async (url, init): Promise<Response> => {
    requests.push({
      url: String(url),
      authorization: new Headers(init?.headers).get('authorization'),
      model: (JSON.parse(String(init?.body)) as { model: string }).model,
    });
    return new Response(JSON.stringify({
      id: 'synthetic-completion', object: 'chat.completion', created: 1, model: config.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic reply' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const { OpenAIProvider } = await import('../../src/providers/openai');
    const provider = new OpenAIProvider(config);
    return { requests, reply: await provider.chat([{ role: 'user', content: 'Synthetic transport probe' }]) };
  } finally {
    transport = undefined;
  }
}
