import * as fs from 'fs';
import * as path from 'path';
import { validateConfig } from '../../src/config/validation';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { runServiceOnboarding, startDaemon } from '../../src/cli/service-onboarding';
import type { EffectiveConfig } from '../../src/config';
import { fixtureOwner } from '../helpers/test-config';
import { makeTestTemp } from '../helpers/test-temp';
import { observeProviderWire } from '../helpers/provider-wire';

jest.mock('openai', () => jest.requireActual('../helpers/provider-wire').offlineOpenAIFactory());

const ENV_VARS = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN'] as const;
const MEDGEMMA = 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest';
const LOCAL = 'http://localhost:11434/v1';
const QUIET = ['--telegram-enabled', 'false', '--timezone', 'Asia/Kolkata', '--heartbeats-enabled', 'false'];
const CHAT_URL = {
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
} as const;

describe('service onboarding', () => {
  let tmpDir: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-cli-init-');
    configPath = path.join(tmpDir, 'config.json');
    for (const name of ENV_VARS) { savedEnv[name] = process.env[name]; delete process.env[name]; }
  });

  afterEach(() => {
    for (const name of ENV_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Non-interactive run: any prompt fails the test. */
  async function onboard(args: string[], target = configPath) {
    const output: string[] = [];
    const code = await runServiceOnboarding(['--yes', '--config', target, ...args], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => { throw new Error('prompt should not be called'); },
    });
    return { code, text: output.join('') };
  }

  it('writes a valid installation: derived owner workspace, templates, 0600 unpaired owner record, reloadable config', async () => {
    const { code } = await onboard([
      '--owner-id', 'kiran', '--provider', 'ollama', '--main-model', 'kimi-k2.5:cloud',
      '--medical-model', MEDGEMMA, '--embedding-model', 'embeddinggemma:latest', '--ollama-url', LOCAL,
      '--telegram-enabled', 'false', '--timezone', 'Asia/Kolkata', '--heartbeats-enabled', 'true',
    ]);

    expect(code).toBe(0);
    const owner = fixtureOwner(path.dirname(configPath), 'kiran');
    for (const entry of ['HEALTH_PROFILE.md', 'conditions', 'medications', 'reports', 'goals']) {
      expect(fs.existsSync(path.join(owner.workspace, entry))).toBe(true);
    }
    expect(fs.existsSync(path.dirname(owner.storePath))).toBe(true);
    expect(JSON.parse(fs.readFileSync(owner.ownerRecord, 'utf8'))).toMatchObject({ version: 1, ownerId: 'kiran', phase: 'unpaired' });
    expect(fs.statSync(owner.ownerRecord).mode & 0o777).toBe(0o600);

    const config = await loadRuntimeConfig({ configPath });
    expect(validateConfig(config).valid).toBe(true);
    expect(config.profiles).toMatchObject({ baseDir: path.dirname(configPath), defaultProfileId: 'kiran' });
    expect(config.memory.workspace).toBe(owner.workspace);
    expect(config.channels.telegram.enabled).toBe(false);
    expect(config.heartbeat).toMatchObject({ timezone: 'Asia/Kolkata', enabled: true });
  });

  it('takes the telegram token from the environment without printing it', async () => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:secret-token';

    const { code, text } = await onboard(['--provider', 'ollama', '--telegram-enabled', 'true', '--timezone', 'Asia/Kolkata']);

    expect(code).toBe(0);
    expect(text).not.toContain('secret-token');
    expect((await loadRuntimeConfig({ configPath })).channels.telegram.botToken).toBe('123456:secret-token');
  });

  it.each([
    {
      name: 'a non-empty owner workspace',
      args: ['--provider', 'ollama', '--telegram-enabled', 'false'],
      prepare: (): void => {
        const owner = fixtureOwner(path.dirname(configPath));
        fs.mkdirSync(owner.workspace, { recursive: true });
        fs.writeFileSync(path.join(owner.workspace, 'SOUL.md'), 'existing soul', 'utf8');
      },
      contains: ['not empty', 'never removed'],
      untouched: (): void => {
        const owner = fixtureOwner(path.dirname(configPath));
        expect(fs.readFileSync(path.join(owner.workspace, 'SOUL.md'), 'utf8')).toBe('existing soul');
        expect(fs.existsSync(path.join(owner.workspace, 'HEALTH_PROFILE.md'))).toBe(false);
      },
    },
    {
      name: 'an existing config',
      args: ['--provider', 'ollama', ...QUIET],
      prepare: (): void => { fs.writeFileSync(configPath, '{"existing":true}\n', 'utf8'); },
      contains: ['already exists', 'never overwrites', '--state-root'],
      untouched: (): void => { expect(fs.readFileSync(configPath, 'utf8')).toBe('{"existing":true}\n'); },
    },
    { name: 'an invalid owner id', args: ['--owner-id', 'Not A Valid Id', '--provider', 'ollama'], contains: ['Invalid --owner-id'] },
    { name: 'telegram enabled without a token', args: ['--provider', 'ollama', '--telegram-enabled', 'true'], contains: ['telegram', 'token'] },
    { name: 'OpenAI without an API key', args: ['--provider', 'openai', ...QUIET], contains: ['OPENAI_API_KEY'] },
    { name: 'an unsupported provider', args: ['--provider', 'anthropic'], contains: ['Unsupported onboard provider', 'ollama, openai'] },
    {
      name: 'an unsupported embedding provider',
      args: ['--provider', 'ollama', '--embedding-provider', 'anthropic', '--telegram-enabled', 'false'],
      contains: ['embedding', '--embedding-provider', 'ollama, openai, openrouter'],
      absent: ['anthropic'],
    },
    {
      name: 'a cloud embedding role without a key of its own',
      args: ['--provider', 'openai', '--api-key', 'sk-main-role-only', '--embedding-provider', 'openai', ...QUIET],
      contains: ['OPENAI_API_KEY', '--embedding-api-key'],
    },
  ] as Array<{ name: string; args: string[]; prepare?: () => void; contains: string[]; absent?: string[]; untouched?: () => void }>)(
    'refuses $name without writing',
    async ({ args, prepare, contains, absent = [], untouched }) => {
      prepare?.();
      const existedBefore = fs.existsSync(configPath);

      const { code, text } = await onboard(args);

      expect(code).toBe(1);
      for (const fragment of contains) expect(text).toContain(fragment);
      for (const fragment of absent) expect(text).not.toContain(fragment);
      if (!existedBefore) expect(fs.existsSync(configPath)).toBe(false);
      const owner = fixtureOwner(path.dirname(configPath));
      if (!prepare) {
        expect(fs.existsSync(owner.ownerRecord)).toBe(false);
        expect(fs.existsSync(owner.workspace)).toBe(false);
      }
      untouched?.();
    },
  );

  const OWN_EMBEDDINGS = { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: LOCAL };

  it.each([
    {
      name: 'a cloud main keeps local embeddings and on-device medical, and its key goes nowhere else',
      args: ['--provider', 'openai', '--api-key', 'sk-main-role-only'],
      check: (config: EffectiveConfig, text: string): void => {
        expect(config.providers.main).toEqual({ type: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-main-role-only' });
        expect(config.providers.medical).toEqual({ type: 'ollama', model: MEDGEMMA, baseUrl: LOCAL });
        expect(config.providers.embeddings).toEqual(OWN_EMBEDDINGS);
        expect(text).not.toContain('sk-main-role-only');
        expect(text).not.toContain('embeddings are remote');
      },
    },
    {
      name: 'an explicit local embedding model changes only the embedding model',
      args: ['--provider', 'openai', '--api-key', 'sk-main-role-only', '--embedding-provider', 'ollama', '--embedding-model', 'nomic-embed-text:latest'],
      check: (config: EffectiveConfig): void => {
        expect(config.providers.embeddings).toEqual({ ...OWN_EMBEDDINGS, model: 'nomic-embed-text:latest' });
        expect(config.providers.main.model).toBe('gpt-4o-mini');
      },
    },
    {
      name: 'each role keeps its own endpoint and key; --ollama-url never becomes a cloud endpoint',
      args: [
        '--provider', 'openai', '--api-key', 'sk-main-role-only', '--ollama-url', 'http://127.0.0.1:11434/v1',
        '--embedding-provider', 'openai', '--embedding-url', 'https://proxy.internal.example/v1', '--embedding-api-key', 'sk-embedding-role-only',
      ],
      check: (config: EffectiveConfig, text: string): void => {
        expect(config.providers.main).toMatchObject({ type: 'openai', apiKey: 'sk-main-role-only' });
        expect(config.providers.main.baseUrl).toBeUndefined();
        expect(config.providers.medical.baseUrl).toBe('http://127.0.0.1:11434/v1');
        expect(config.providers.embeddings).toEqual({
          type: 'openai', model: 'text-embedding-3-small', baseUrl: 'https://proxy.internal.example/v1', apiKey: 'sk-embedding-role-only',
        });
        expect(text).not.toContain('sk-main-role-only');
        expect(text).not.toContain('sk-embedding-role-only');
      },
    },
    {
      name: 'a remote embedding role takes its key from its own environment variable and warns honestly',
      args: ['--provider', 'openai', '--embedding-provider', 'openrouter', '--embedding-url', 'https://openrouter.ai/api/v1'],
      env: { OPENAI_API_KEY: 'sk-main-env', OPENROUTER_API_KEY: 'or-embedding-env' },
      check: (config: EffectiveConfig, text: string): void => {
        expect(config.providers.embeddings.type).toBe('openrouter');
        expect(config.providers.main.apiKey).toBeUndefined();
        expect(text).toContain('embeddings are remote');
        expect(text).toContain('p50<=300ms');
        expect(text).toContain('configured, not verified');
        expect(text).not.toContain('or-embedding-env');
        expect(text).not.toContain('sk-main-env');
      },
    },
    {
      name: 'credentials embedded in an endpoint URL are never printed',
      args: ['--provider', 'ollama', '--embedding-provider', 'openai', '--embedding-url', 'https://url-user:url-password@embeddings.internal.example/v1', '--embedding-api-key', 'sk-embedding-role-only'],
      check: (_config: EffectiveConfig, text: string): void => {
        expect(text).not.toContain('url-user');
        expect(text).not.toContain('url-password');
        expect(text).toContain('embeddings.internal.example');
      },
    },
    {
      name: 'OpenRouter main is saved with the adapter endpoint and reloads',
      args: ['--provider', 'openrouter', '--main-model', 'stealth/ox-alpha', '--embedding-provider', 'ollama'],
      env: { OPENROUTER_API_KEY: 'or-synthetic-environment-key' },
      check: (config: EffectiveConfig, text: string): void => {
        expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).schemaVersion).toBe(2);
        expect(config.providers.main).toMatchObject({ type: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'stealth/ox-alpha', reasoningEffort: 'low' });
        expect(config.providers.embeddings).toEqual(OWN_EMBEDDINGS);
        expect(config.providers.medical.type).toBe('ollama');
        expect(text).not.toContain('or-synthetic-environment-key');
      },
    },
    {
      name: 'an Ollama main keeps its local endpoint',
      args: ['--provider', 'ollama'],
      check: (config: EffectiveConfig): void => {
        expect(config.providers.main).toMatchObject({ type: 'ollama', baseUrl: LOCAL });
      },
    },
  ] as Array<{ name: string; args: string[]; env?: Record<string, string>; check: (config: EffectiveConfig, text: string) => void }>)(
    'provider roles: $name',
    async ({ args, env = {}, check }) => {
      Object.assign(process.env, env);

      const { code, text } = await onboard([...args, ...QUIET]);

      expect(code).toBe(0);
      expect(text).not.toContain('invalid-url');
      check(await loadRuntimeConfig({ configPath }), text);
    },
  );

  it.each(['openai', 'openrouter'] as const)('refuses an omitted %s medical model before publication, then accepts an explicit one', async (medical) => {
    const target = path.join(tmpDir, `model-retry-${medical}`, 'config.json');
    const args = ['--medical-provider', medical, '--medical-api-key', 'synthetic-own-key'];

    const refused = await onboard(args, target);
    expect(refused.code).toBe(1);
    expect(fs.existsSync(path.dirname(target))).toBe(false);
    expect(refused.text).toContain('--medical-model');
    expect(refused.text).not.toContain('synthetic-own-key');

    expect((await onboard([...args, '--medical-model', 'synthetic/chosen-model'], target)).code).toBe(0);
    const loaded = await loadRuntimeConfig({ configPath: target });
    expect(loaded.providers.medical).toMatchObject({ type: medical, model: 'synthetic/chosen-model' });
    expect(loaded.providers.main.type).toBe('ollama');
    const wire = await observeProviderWire(loaded.providers.medical);
    expect(wire.requests).toEqual([{ url: CHAT_URL[medical], authorization: 'Bearer synthetic-own-key', model: 'synthetic/chosen-model' }]);
  });

  it.each(['openrouter', 'openai'] as const)('refuses a missing %s medical credential with no writes, then uses only that provider environment variable', async (medical) => {
    const target = path.join(tmpDir, `medical-retry-${medical}`, 'config.json');
    const args = ['--provider', 'openai', '--api-key', 'synthetic-main-key', '--medical-provider', medical, '--medical-model', 'synthetic/medical', '--telegram-enabled', 'false'];
    const inventory = fs.readdirSync(tmpDir);

    const refused = await onboard(args, target);
    expect(refused.code).toBe(1);
    expect(fs.readdirSync(tmpDir)).toEqual(inventory);
    expect(refused.text).toContain('--medical-api-key');
    expect(refused.text).not.toContain('synthetic-main-key');

    process.env[medical === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'] = 'synthetic-medical-env';
    const accepted = await onboard(args, target);
    expect(accepted.code).toBe(0);
    const loaded = await loadRuntimeConfig({ configPath: target });
    expect(loaded.providers.main).toMatchObject({ type: 'openai', apiKey: 'synthetic-main-key' });
    expect(loaded.providers.medical).toMatchObject({ type: medical, model: 'synthetic/medical' });
    expect(loaded.providers.medical.apiKey).toBeUndefined();
    const wire = await observeProviderWire(loaded.providers.medical);
    expect(wire.requests).toEqual([{ url: CHAT_URL[medical], authorization: 'Bearer synthetic-medical-env', model: 'synthetic/medical' }]);
    expect(accepted.text).not.toContain('synthetic-medical-env');
  });

  it.each([['openai', 'openrouter'], ['openrouter', 'openai'], ['openai', 'openai']] as const)(
    'publishes an explicit medical key for %s main and %s medical without cross-role copying',
    async (main, medical) => {
      process.env.OPENAI_API_KEY = 'synthetic-openai-env';
      process.env.OPENROUTER_API_KEY = 'synthetic-router-env';
      const target = path.join(tmpDir, `${main}-${medical}`, 'config.json');

      const { code, text } = await onboard([
        '--provider', main, '--api-key', 'synthetic-main-explicit', '--medical-provider', medical,
        '--medical-model', 'synthetic-medical-model', '--medical-api-key', '  synthetic-medical-explicit  ', '--telegram-enabled', 'false',
      ], target);

      expect(code).toBe(0);
      const loaded = await loadRuntimeConfig({ configPath: target });
      expect(loaded.providers.main.apiKey).toBe('synthetic-main-explicit');
      expect(loaded.providers.medical).toMatchObject({ type: medical, model: 'synthetic-medical-model', apiKey: 'synthetic-medical-explicit' });
      expect(loaded.providers.embeddings).toEqual(OWN_EMBEDDINGS);
      const wire = await observeProviderWire(loaded.providers.medical);
      expect(wire.requests).toEqual([{ url: CHAT_URL[medical], authorization: 'Bearer synthetic-medical-explicit', model: 'synthetic-medical-model' }]);
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      for (const marker of ['synthetic-main-explicit', 'synthetic-medical-explicit', 'synthetic-openai-env', 'synthetic-router-env']) expect(text).not.toContain(marker);
    },
  );

  it.each([undefined, '', '   ', '--yes'])('refuses a malformed --medical-api-key value before any prompt or write', async (value) => {
    const target = path.join(tmpDir, 'refused-option', 'config.json');
    const output: string[] = [];
    const inventory = fs.readdirSync(tmpDir);

    const code = await runServiceOnboarding(['--config', target, '--medical-api-key', ...(value === undefined ? [] : [value])], {
      stdout: (text: string): void => { output.push(text); },
      stderr: (text: string): void => { output.push(text); },
      input: async (): Promise<string> => { throw Error('Parser refusal must not prompt'); },
    });

    expect(code).toBe(1);
    expect(output.join('')).toContain('--medical-api-key');
    expect(output.join('')).not.toContain('must not prompt');
    expect(fs.readdirSync(tmpDir)).toEqual(inventory);
  });

  it('keeps a prefilled API key when Enter is pressed during interactive cloud setup', async () => {
    const answers = [path.dirname(configPath), 'default', '', '', '', '', 'ollama', '', '', 'n', '', '', '1', '3'];
    const output: string[] = [];

    const code = await runServiceOnboarding(
      ['--config', configPath, '--provider', 'openai', '--api-key', 'sk-prefilled-secret', ...QUIET],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => answers.shift() ?? '',
      },
    );

    expect(code).toBe(0);
    expect(output.join('')).not.toContain('sk-prefilled-secret');
    const config = await loadRuntimeConfig({ configPath });
    expect(config.providers.main).toEqual({ type: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-prefilled-secret' });
    expect(config.providers.medical).toEqual({ type: 'ollama', model: MEDGEMMA, baseUrl: LOCAL });
    expect(config.providers.embeddings).toEqual(OWN_EMBEDDINGS);
  });

  it('returns a structured failure when daemon spawn throws synchronously', async () => {
    const result = await startDaemon(configPath, {}, {
      projectRoot: '/repo',
      existsSync: () => false,
      spawnProcess: () => { throw new Error('spawn sync failed'); },
      startupWindowMs: 1,
    });

    expect(result).toEqual({ started: false, message: 'Failed to start MedClaw: spawn sync failed' });
  });
});
