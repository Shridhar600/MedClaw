import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDefaultConfig } from '../../src/config/config';
import { ensureOllamaRuntime, preflightStartCheck, verifyTelegramRuntime } from '../../src/cli/setup-readiness';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function useOpenAiProviders(config: ReturnType<typeof getDefaultConfig>): void {
  config.providers.main = { type: 'openai', model: 'gpt-4.1-mini', apiKey: 'main-key' };
  config.providers.medical = { type: 'openai', model: 'gpt-4.1-mini', apiKey: 'medical-key' };
  config.providers.embeddings = { type: 'openai', model: 'text-embedding-3-small', apiKey: 'embedding-key' };
}

describe('setup readiness', () => {
  let tmpDir: string;
  let configPath: string;
  let workspacePath: string;
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-setup-readiness-'));
    configPath = path.join(tmpDir, 'config.json');
    workspacePath = path.join(tmpDir, 'workspace');
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(configPath, '{}\n', 'utf8');
  });

  afterEach(() => {
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks startup when required Ollama models are missing', async () => {
    const config = getDefaultConfig();
    config.memory.workspace = workspacePath;
    config.channels.telegram.enabled = false;
    config.heartbeat.enabled = true;

    const report = await preflightStartCheck(config, configPath, {
      fetchImpl: jest.fn(async (url: string | URL) => {
        const target = String(url);
        if (target.endsWith('/api/version')) {
          return jsonResponse({ version: '0.6.0' });
        }
        if (target.endsWith('/api/tags')) {
          return jsonResponse({
            models: [{ name: config.providers.main.model }],
          });
        }
        throw new Error(`Unexpected URL: ${target}`);
      }) as typeof fetch,
      timeoutMs: 50,
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`Missing Ollama model for providers.medical at ${config.providers.medical.baseUrl}: ${config.providers.medical.model}`),
        expect.stringContaining(`Missing Ollama model for providers.embeddings at ${config.providers.embeddings.baseUrl}: ${config.providers.embeddings.model}`),
      ]),
    );
  });

  it('blocks startup when an OpenAI provider has no inline or environment api key', async () => {
    delete process.env.OPENAI_API_KEY;
    const config = getDefaultConfig();
    config.memory.workspace = workspacePath;
    config.channels.telegram.enabled = false;
    config.heartbeat.enabled = true;
    config.providers.main = { type: 'openai', model: 'gpt-4.1-mini' };
    config.providers.medical = { type: 'openai', model: 'gpt-4.1-mini', apiKey: 'medical-key' };
    config.providers.embeddings = { type: 'openai', model: 'text-embedding-3-small', apiKey: 'embedding-key' };

    const report = await preflightStartCheck(config, configPath);

    expect(report.ready).toBe(false);
    expect(report.blockers).toContain(
      'providers.main apiKey is required for OpenAI provider. Set apiKey or OPENAI_API_KEY.',
    );
  });

  it('allows OpenAI providers with inline or environment api keys', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    const config = getDefaultConfig();
    config.memory.workspace = workspacePath;
    config.channels.telegram.enabled = false;
    config.heartbeat.enabled = true;
    config.providers.main = { type: 'openai', model: 'gpt-4.1-mini' };
    config.providers.medical = { type: 'openai', model: 'gpt-4.1-mini', apiKey: 'medical-key' };
    config.providers.embeddings = { type: 'openai', model: 'text-embedding-3-small' };

    const report = await preflightStartCheck(config, configPath);

    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it('blocks Ollama models that exist only on a different configured endpoint', async () => {
    const config = getDefaultConfig();
    config.memory.workspace = workspacePath;
    config.channels.telegram.enabled = false;
    config.heartbeat.enabled = true;
    config.providers.main = {
      type: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'main-model',
    };
    config.providers.medical = {
      type: 'ollama',
      baseUrl: 'http://127.0.0.1:11435/v1',
      model: 'medical-model',
    };
    config.providers.embeddings = {
      type: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'embedding-model',
    };
    const fetchedUrls: string[] = [];

    const report = await preflightStartCheck(config, configPath, {
      fetchImpl: jest.fn(async (url: string | URL) => {
        const target = String(url);
        fetchedUrls.push(target);
        if (target.endsWith('/api/version')) {
          return jsonResponse({ version: '0.6.0' });
        }
        if (target === 'http://127.0.0.1:11434/api/tags') {
          return jsonResponse({
            models: [{ name: 'main-model' }, { name: 'medical-model' }, { name: 'embedding-model' }],
          });
        }
        if (target === 'http://127.0.0.1:11435/api/tags') {
          return jsonResponse({
            models: [],
          });
        }
        throw new Error(`Unexpected URL: ${target}`);
      }) as typeof fetch,
      timeoutMs: 50,
    });

    expect(report.ready).toBe(false);
    expect(report.blockers).toContain(
      'Missing Ollama model for providers.medical at http://127.0.0.1:11435/v1: medical-model. Run `ollama pull medical-model` against that endpoint.',
    );
    expect(fetchedUrls.filter((url) => url === 'http://127.0.0.1:11434/api/tags')).toHaveLength(1);
  });

  it('blocks startup when workspace path is a file', async () => {
    const workspaceFile = path.join(tmpDir, 'workspace-file');
    fs.writeFileSync(workspaceFile, 'not a directory\n', 'utf8');
    const config = getDefaultConfig();
    config.memory.workspace = workspaceFile;
    config.channels.telegram.enabled = false;
    config.heartbeat.enabled = true;
    useOpenAiProviders(config);

    const report = await preflightStartCheck(config, configPath);

    expect(report.ready).toBe(false);
    expect(report.blockers).toContain(`Workspace path is not a directory at ${workspaceFile}.`);
  });

  it('blocks startup when config path is a directory', async () => {
    const configDirectory = path.join(tmpDir, 'config-directory');
    fs.mkdirSync(configDirectory);
    const config = getDefaultConfig();
    config.memory.workspace = workspacePath;
    config.channels.telegram.enabled = false;
    config.heartbeat.enabled = true;
    useOpenAiProviders(config);

    const report = await preflightStartCheck(config, configDirectory);

    expect(report.ready).toBe(false);
    expect(report.blockers).toContain(`Config path is not a file at ${configDirectory}.`);
  });

  it('blocks invalid Telegram tokens during runtime verification', async () => {
    const config = getDefaultConfig();
    config.channels.telegram.enabled = true;
    config.channels.telegram.botToken = '123456:bad-token';

    const result = await verifyTelegramRuntime(config, {
      fetchImpl: jest.fn(async () =>
        jsonResponse({ ok: false, description: 'Unauthorized' }, 401),
      ) as typeof fetch,
      timeoutMs: 50,
    });

    expect(result.verified).toBe(false);
    expect(result.blockers).toEqual(['Unauthorized']);
  });

  it('blocks startup when no runtime channel or heartbeat is enabled', async () => {
    const config = getDefaultConfig();
    config.memory.workspace = workspacePath;
    config.channels.telegram.enabled = false;
    config.heartbeat.enabled = false;
    useOpenAiProviders(config);

    const report = await preflightStartCheck(config, configPath);

    expect(report.ready).toBe(false);
    expect(report.blockers).toContain(
      'Nothing is enabled to keep MedClaw running. Enable Telegram or heartbeats before starting.',
    );
  });

  it('reports synchronous Ollama auto-start failures', async () => {
    const result = await ensureOllamaRuntime('http://127.0.0.1:11434/v1', {
      fetchImpl: jest.fn(async () => {
        throw new Error('connection refused');
      }) as typeof fetch,
      spawnProcess: () => {
        throw new Error('spawn ollama ENOENT');
      },
      sleep: async () => undefined,
      timeoutMs: 50,
    });

    expect(result.reachable).toBe(false);
    expect(result.warnings).toEqual(['Failed to auto-start Ollama: spawn ollama ENOENT']);
  });

  it('reports asynchronous Ollama auto-start error events', async () => {
    const result = await ensureOllamaRuntime('http://127.0.0.1:11434/v1', {
      fetchImpl: jest.fn(async () => {
        throw new Error('connection refused');
      }) as typeof fetch,
      spawnProcess: () => ({
        on: (event: 'error' | 'exit', listener: (...args: unknown[]) => void) => {
          if (event === 'error') {
            setTimeout(() => listener(new Error('spawn event failed')), 0);
          }
          return undefined;
        },
        unref: () => undefined,
      }),
      sleep: async () => new Promise((resolve) => setTimeout(resolve, 0)),
      timeoutMs: 50,
    });

    expect(result.reachable).toBe(false);
    expect(result.warnings).toEqual(['Failed to auto-start Ollama: spawn event failed']);
  });

  it('does not expose Telegram tokens from fetch errors', async () => {
    const config = getDefaultConfig();
    config.channels.telegram.enabled = true;
    config.channels.telegram.botToken = '123456:secret-token';

    const result = await verifyTelegramRuntime(config, {
      fetchImpl: jest.fn(async () => {
        throw new Error('request failed for https://api.telegram.org/bot123456:secret-token/getMe');
      }) as typeof fetch,
      timeoutMs: 50,
    });

    expect(JSON.stringify(result)).not.toContain('123456:secret-token');
  });

  it('redacts Telegram tokens from rejected-token details', async () => {
    const config = getDefaultConfig();
    config.channels.telegram.enabled = true;
    config.channels.telegram.botToken = '123456:secret-token';

    const result = await verifyTelegramRuntime(config, {
      fetchImpl: jest.fn(async () =>
        jsonResponse(
          {
            ok: false,
            description: 'Unauthorized for https://api.telegram.org/bot123456:secret-token/getMe',
          },
          401,
        ),
      ) as typeof fetch,
      timeoutMs: 50,
    });

    expect(result.blockers.join('\n')).not.toContain('123456:secret-token');
    expect(result.blockers.join('\n')).toContain('bot[REDACTED]');
  });
});
