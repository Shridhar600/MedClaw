import * as fs from 'fs';
import * as path from 'path';
import type { SpawnOptions } from 'child_process';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { writeConfigFixture } from '../helpers/config-fixture';
import { handleCompletionAction, runServiceOnboarding, startDaemon } from '../../src/cli/service-onboarding';
import { makeTestTemp } from '../helpers/test-temp';
import { observeProviderWire } from '../helpers/provider-wire';
import { runCli } from '../../src/cli';

jest.mock('openai', () => jest.requireActual('../helpers/provider-wire').offlineOpenAIFactory());

const KEY_VARS = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;
const LOCAL_EMBEDDINGS = { type: 'ollama', model: 'embeddinggemma:latest', baseUrl: 'http://localhost:11434/v1' };

describe('setup wizard', () => {
  let tmpDir: string;
  let stateRoot: string;
  let configPath: string;
  const savedKeys: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-setup-wizard-');
    stateRoot = path.join(tmpDir, 'state');
    configPath = path.join(tmpDir, 'config.json');
    for (const name of KEY_VARS) { savedKeys[name] = process.env[name]; delete process.env[name]; }
  });

  afterEach(() => {
    for (const name of KEY_VARS) {
      if (savedKeys[name] === undefined) delete process.env[name]; else process.env[name] = savedKeys[name];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Drives the wizard from a scripted answer list; later prompts get an empty answer (the default). */
  async function runWizard(args: string[], answers: string[], target = configPath) {
    const output: string[] = [];
    const prompts: string[] = [];
    const queue = [...answers];
    const code = await runServiceOnboarding(['--config', target, ...args], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async (prompt: string) => { prompts.push(prompt); return queue.shift() ?? ''; },
    });
    return { code, text: output.join(''), prompts: prompts.join('\n') };
  }

  const ollamaStart = (root = stateRoot): string[] => [root, 'default', 'ollama', '', '', ''];
  const cloudStart = (key: string): string[] => [stateRoot, 'default', 'openai', key, '', ''];
  const freshState = (name: string): string => path.join(tmpDir, `${name}-state`);

  it('runs the staged wizard, shows readiness at completion, saves the config and never echoes the token', async () => {
    const { code, text } = await runWizard([], [...ollamaStart(), 'ollama', '', '', 'y', '123456:test-token', 'Asia/Kolkata', 'y', '1', '3']);

    expect(code).toBe(0);
    expect(text).toContain('[1/5]');
    expect(text).toContain('Setup complete');
    expect(text).toContain(`Config written to ${configPath}`);
    expect(text).toContain('main provider:');
    expect(text).not.toContain('123456:test-token');
    expect((await loadRuntimeConfig({ configPath })).channels.telegram.botToken).toBe('123456:test-token');
  });

  it('keeps a prefilled telegram token on Enter, re-prompts when it is missing, and edits from review', async () => {
    const kept = await runWizard(['--telegram-enabled', 'true', '--telegram-token', '123456:prefilled-token'], [
      stateRoot, '', '', '', '', '', 'ollama', '', '', '', '', '', '', '1', '3',
    ]);
    expect(kept.code).toBe(0);
    expect(kept.text).not.toContain('123456:prefilled-token');
    expect((await loadRuntimeConfig({ configPath })).channels.telegram.botToken).toBe('123456:prefilled-token');

    const retryTarget = path.join(tmpDir, 'retry', 'config.json');
    const retried = await runWizard([], [...ollamaStart(freshState('retry')), 'ollama', '', '', 'y', '', '123456:retried-token', 'Asia/Kolkata', 'y', '1', '3'], retryTarget);
    expect(retried.text).toContain('Telegram bot token is required when Telegram is enabled.');
    expect((await loadRuntimeConfig({ configPath: retryTarget })).channels.telegram.botToken).toBe('123456:retried-token');

    const editTarget = path.join(tmpDir, 'edit', 'config.json');
    const edited = await runWizard([], [...ollamaStart(freshState('edit')), 'ollama', '', '', 'n', 'Asia/Kolkata', 'y', 'telegram', 'y', '123456:updated-token', '1', '3'], editTarget);
    expect(edited.text).toContain('[REDACTED]');
    const reloaded = await loadRuntimeConfig({ configPath: editTarget });
    expect(reloaded.channels.telegram).toMatchObject({ enabled: true, botToken: '123456:updated-token' });
  });

  it('writes nothing, not even directories, when cancelled from review', async () => {
    const nestedState = path.join(tmpDir, 'cancelled', 'state');
    const nestedConfig = path.join(tmpDir, 'cancelled-config', 'config.json');

    const { code, text } = await runWizard([], [nestedState, 'default', 'ollama', '', '', '', 'ollama', '', '', 'n', 'Asia/Kolkata', 'y', 'cancel'], nestedConfig);

    expect(code).toBe(0);
    expect(text).toContain('Setup cancelled. No files were written.');
    expect(fs.existsSync(nestedState)).toBe(false);
    expect(fs.existsSync(path.dirname(nestedConfig))).toBe(false);
  });

  it('uses only the newly selected main-provider credential after review edits, and keeps an unchanged one', async () => {
    for (const [from, to, source] of [
      ['openai', 'openrouter', 'environment'],
      ['openrouter', 'openai', 'hidden'],
      ['openai', 'openai', 'unchanged'],
    ]) {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      const ownKey = source === 'environment' ? 'synthetic-new-env' : 'synthetic-new-hidden';
      if (source === 'environment') process.env[to === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'] = ownKey;
      const target = path.join(tmpDir, `${from}-${to}-${source}`, 'config.json');
      const output: string[] = [], prompts: string[] = [], secrets: string[] = [];
      let selections = 0, reviews = 0;
      expect(await runServiceOnboarding(['--config', target, '--provider', from, '--api-key', 'synthetic-old-main'], {
        stdout: (text: string): void => { output.push(text); }, stderr: (text: string): void => { output.push(text); },
        input: async (prompt: string): Promise<string> => {
          prompts.push(prompt);
          if (prompts.length > 80) throw Error('answer bound exceeded');
          if (prompt.includes('Provider type\n')) return ++selections === 1 ? from : to;
          if (prompt.includes('Review action\n')) return ++reviews === 1 ? 'provider' : 'apply';
          return prompt.includes('Next action\n') ? 'exit' : '';
        },
        secretInput: async (prompt: string): Promise<string> => {
          secrets.push(prompt);
          return selections === 1 || source === 'unchanged' ? '' : ownKey;
        },
      })).toBe(0);
      const loaded = await loadRuntimeConfig({ configPath: target });
      const expectedKey = source === 'unchanged' ? 'synthetic-old-main' : ownKey;
      expect(loaded.providers.main.type).toBe(to);
      expect(loaded.providers.main.apiKey).toBe(source === 'environment' ? undefined : expectedKey);
      const wire = await observeProviderWire(loaded.providers.main);
      expect(wire.requests).toEqual([{
        url: to === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions',
        authorization: `Bearer ${expectedKey}`, model: loaded.providers.main.model,
      }]);
      expect(loaded.providers.medical.type).toBe('ollama');
      expect(loaded.providers.embeddings.type).toBe('ollama');
      for (const key of ['synthetic-old-main', ownKey]) expect(output.join('') + prompts.join('') + secrets.join('')).not.toContain(key);
    }
  });

  it('keeps the custom local medical and embedding endpoints when the main provider is switched to the cloud', async () => {
    const target = path.join(tmpDir, 'local-to-cloud', 'config.json');
    const output: string[] = [];
    let selections = 0, reviews = 0;
    expect(await runCli([
      '--config', target, 'onboard', '--provider', 'ollama',
      '--ollama-url', 'http://127.0.0.1:11435/v1', '--medical-model', 'synthetic-local-medical',
      '--embedding-url', 'http://127.0.0.1:11436/v1', '--embedding-model', 'synthetic-embedding',
    ], {
      stdout: (text: string): void => { output.push(text); },
      stderr: (text: string): void => { output.push(text); },
      input: async (prompt: string): Promise<string> => {
        if (prompt.includes('Provider type\n')) return ++selections === 1 ? 'ollama' : 'openrouter';
        if (prompt.includes('Main model\n')) return 'synthetic-main';
        if (prompt.includes('Review action\n')) return ++reviews === 1 ? 'provider' : 'apply';
        return prompt.includes('Next action\n') ? 'exit' : '';
      },
      secretInput: async (): Promise<string> => 'synthetic-cloud-key',
    })).toBe(0);

    const loaded = await loadRuntimeConfig({ configPath: target });
    expect(loaded.providers.medical).toMatchObject({ type: 'ollama', model: 'synthetic-local-medical', baseUrl: 'http://127.0.0.1:11435/v1' });
    expect(loaded.providers.embeddings).toMatchObject({ type: 'ollama', model: 'synthetic-embedding', baseUrl: 'http://127.0.0.1:11436/v1' });
    const wire = await observeProviderWire(loaded.providers.main);
    expect(wire.requests).toEqual([{ url: 'https://openrouter.ai/api/v1/chat/completions', authorization: 'Bearer synthetic-cloud-key', model: 'synthetic-main' }]);
    expect(output.join('')).not.toContain('synthetic-cloud-key');
  });

  it('refuses a blank cloud medical model in review, then applies the explicitly selected model', async () => {
    const target = path.join(tmpDir, 'medical-model-wizard', 'config.json');
    const output: string[] = [], modelPrompts: string[] = [];
    let reviews = 0;
    expect(await runServiceOnboarding([
      '--config', target, '--provider', 'openai', '--api-key', 'synthetic-main',
      '--medical-provider', 'openrouter', '--medical-api-key', 'synthetic-medical',
    ], {
      stdout: (text: string): void => { output.push(text); }, stderr: (text: string): void => { output.push(text); },
      input: async (prompt: string): Promise<string> => {
        if (prompt.includes('Medical model\n')) {
          modelPrompts.push(prompt);
          return modelPrompts.length === 1 ? '' : 'synthetic/chosen-medical';
        }
        if (prompt.includes('Review action\n')) {
          if (++reviews === 2) {
            expect(fs.existsSync(path.dirname(target))).toBe(false);
            return 'provider';
          }
          return 'apply';
        }
        return prompt.includes('Next action\n') ? 'exit' : '';
      },
      secretInput: async (): Promise<string> => '',
    })).toBe(0);

    expect(modelPrompts[0]).not.toContain('medgemma');
    const loaded = await loadRuntimeConfig({ configPath: target });
    expect(loaded.providers.medical).toMatchObject({ type: 'openrouter', model: 'synthetic/chosen-medical', apiKey: 'synthetic-medical' });
    expect(output.join('')).toContain('--medical-model');
    expect(output.join('')).not.toContain('synthetic-medical');
  });

  it.each(['environment', 'explicit', 'hidden-input'] as const)(
    'keeps a cloud medical role and its own credential (%s) through main-provider review edits',
    async (source) => {
      if (source === 'environment') process.env.OPENROUTER_API_KEY = 'synthetic-medical-environment';
      const target = path.join(tmpDir, source, 'config.json');
      const output: string[] = [], prompts: string[] = [], secrets: string[] = [];
      let providerSteps = 0, reviews = 0;
      const args = ['--config', target, '--state-root', path.join(tmpDir, source, 'state'), '--provider', 'openai', '--api-key', 'synthetic-main-only', '--medical-provider', 'openrouter', '--medical-model', 'synthetic/medical', ...(source === 'explicit' ? ['--medical-api-key', 'synthetic-medical-explicit'] : [])];

      const code = await runServiceOnboarding(args, {
        stdout: (text: string): void => { output.push(text); }, stderr: (text: string): void => { output.push(text); },
        input: async (prompt: string): Promise<string> => {
          prompts.push(prompt);
          if (prompts.length > 80) throw Error('Wizard exceeded bounded answer script');
          if (prompt.includes('Provider type\n')) return ++providerSteps === 1 ? 'openai' : 'ollama';
          if (prompt.includes('Review action\n')) return ++reviews === 1 ? 'provider' : 'apply';
          return prompt.includes('Next action\n') ? 'exit' : '';
        },
        secretInput: async (prompt: string): Promise<string> => {
          secrets.push(prompt);
          return source === 'hidden-input' && prompt.includes('medical') ? 'synthetic-medical-hidden' : '';
        },
      });

      expect(code).toBe(0);
      const loaded = await loadRuntimeConfig({ configPath: target });
      const ownKey = { environment: 'synthetic-medical-environment', explicit: 'synthetic-medical-explicit', 'hidden-input': 'synthetic-medical-hidden' }[source];
      expect(loaded.providers.main).toMatchObject({ type: 'ollama' });
      expect(loaded.providers.main.apiKey).toBeUndefined();
      expect(loaded.providers.medical).toMatchObject({ type: 'openrouter', model: 'synthetic/medical' });
      expect(loaded.providers.medical.apiKey).toBe(source === 'environment' ? undefined : ownKey);
      const wire = await observeProviderWire(loaded.providers.medical);
      expect(wire.requests).toEqual([{ url: 'https://openrouter.ai/api/v1/chat/completions', authorization: `Bearer ${ownKey}`, model: 'synthetic/medical' }]);
      const shown = output.join('') + prompts.join('') + secrets.join('');
      expect(shown).not.toContain('synthetic-main-only');
      expect(shown).not.toContain(ownKey);
    },
  );

  it('checks only local medical models in the Ollama catalog and cancels without publication', async () => {
    const output: string[] = [];
    const target = path.join(tmpDir, 'catalog', 'config.json');
    const model = 'synthetic-local-medical-missing';
    const code = await runServiceOnboarding([
      '--config', target, '--provider', 'ollama', '--main-model', 'synthetic-local-main',
      '--medical-provider', 'ollama', '--medical-model', model,
    ], {
      stdout: (text: string): void => { output.push(text); }, stderr: (text: string): void => { output.push(text); },
      input: async (prompt: string): Promise<string> => (prompt.includes('Review action\n') ? 'cancel' : ''),
      secretInput: async (): Promise<string> => '',
    }, {
      fetchImpl: async (url): Promise<Response> => {
        if (!['http://localhost:11434/api/tags', 'http://localhost:11434/api/version'].includes(String(url))) throw Error('Unscripted catalog URL refused');
        const body = String(url).endsWith('/api/version') ? { version: 'synthetic' } : { models: [{ name: 'synthetic-local-main' }, { name: 'embeddinggemma:latest' }] };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    expect(code).toBe(0);
    expect(output.join('')).toContain('Ollama reachable.');
    expect(output.join('')).toContain(`Missing Ollama model: ${model}. Run \`ollama pull ${model}\`.`);
    expect(output.join('')).toContain('Setup cancelled. No files were written.');
    expect(fs.existsSync(path.dirname(target))).toBe(false);
  });

  it('keeps embeddings and medical local when a cloud chat provider is chosen, without copying the chat key', async () => {
    const { code, text, prompts } = await runWizard(['--embedding-api-key', 'sk-seeded-embedding-key'], [
      ...cloudStart('sk-wizard-main-secret'), 'ollama', '', '', 'n', 'Asia/Kolkata', 'n', '1', '3',
    ]);

    expect(code).toBe(0);
    expect(prompts).toContain('Embedding provider');
    expect(text).toContain('Embedding provider');
    expect(text).not.toContain('sk-wizard-main-secret');
    const config = await loadRuntimeConfig({ configPath });
    expect(config.providers.main).toMatchObject({ type: 'openai', apiKey: 'sk-wizard-main-secret' });
    expect(config.providers.embeddings).toEqual(LOCAL_EMBEDDINGS);
    expect(config.providers.medical).toEqual({
      type: 'ollama',
      model: 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(config.providers.medical.allowRawMedicalMedia ?? false).toBe(false);
  });

  it('carries an explicit remote embedding role through review, apply and reload without echoing keys', async () => {
    const { code, text } = await runWizard([], [
      ...cloudStart('sk-wizard-main-secret'), 'openai', 'https://embeddings.internal.example/v1', 'sk-wizard-embedding-secret', '',
      'n', 'Asia/Kolkata', 'n', '1', '3',
    ]);

    expect(code).toBe(0);
    const config = await loadRuntimeConfig({ configPath });
    expect(config.providers.embeddings).toEqual({
      type: 'openai',
      model: 'text-embedding-3-small',
      baseUrl: 'https://embeddings.internal.example/v1',
      apiKey: 'sk-wizard-embedding-secret',
    });
    expect(config.providers.main.apiKey).toBe('sk-wizard-main-secret');
    expect(text).not.toContain('sk-wizard-main-secret');
    expect(text).not.toContain('sk-wizard-embedding-secret');
    expect(text).toContain('Remote embeddings');
  });

  it.each([
    {
      name: 'the review summary of a credentialed embedding endpoint',
      args: [] as string[],
      embedding: ['openai', 'https://url-user:url-password@embeddings.internal.example/v1', 'sk-review-embedding-secret', ''],
      secrets: ['url-user', 'url-password', 'sk-review-embedding-secret'],
      expectBaseUrl: 'https://url-user:url-password@embeddings.internal.example/v1',
    },
    {
      name: 'the prompt default of a credentialed embedding endpoint',
      args: ['--embedding-url', 'https://url-user:url-password@proxy.example/v1'],
      embedding: ['ollama', '', ''],
      secrets: ['url-user', 'url-password'],
      expectBaseUrl: 'https://url-user:url-password@proxy.example/v1',
    },
    {
      name: 'the prompt default of an inherited credentialed Ollama endpoint',
      args: ['--ollama-url', 'https://url-user:url-password@127.0.0.1:11434/v1'],
      embedding: ['ollama', '', ''],
      secrets: ['url-user', 'url-password'],
      expectBaseUrl: 'https://url-user:url-password@127.0.0.1:11434/v1',
    },
  ])('never prints credentials in $name, yet keeps the configured value on Enter', async ({ args, embedding, secrets, expectBaseUrl }) => {
    const { code, text, prompts } = await runWizard(args, [...ollamaStart(), ...embedding, 'n', 'Asia/Kolkata', 'n', '1', '3']);

    expect(code).toBe(0);
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
      expect(prompts).not.toContain(secret);
    }
    const config = await loadRuntimeConfig({ configPath });
    expect(config.providers.embeddings.baseUrl).toBe(expectBaseUrl);
  });

  it('keeps an explicit embedding role when the main provider is edited, and replaces a stale one when the embedding provider changes', async () => {
    const afterMainEdit = await runWizard([], [
      ...cloudStart('sk-wizard-main-secret'), 'openai', 'https://embeddings.internal.example/v1', 'sk-wizard-embedding-secret', '',
      'n', 'Asia/Kolkata', 'n', 'provider', 'ollama', '', '', '', '1', '3',
    ]);
    expect(afterMainEdit.code).toBe(0);
    const edited = await loadRuntimeConfig({ configPath });
    expect(edited.providers.main).toMatchObject({ type: 'ollama', baseUrl: 'http://localhost:11434/v1' });
    expect(edited.providers.embeddings).toEqual({
      type: 'openai',
      model: 'text-embedding-3-small',
      baseUrl: 'https://embeddings.internal.example/v1',
      apiKey: 'sk-wizard-embedding-secret',
    });

    const switchTarget = path.join(tmpDir, 'switch', 'config.json');
    const switched = await runWizard([], [
      ...ollamaStart(freshState('switch')), 'ollama', '', '', 'n', 'Asia/Kolkata', 'n',
      'embeddings', 'openai', 'https://embeddings.internal.example/v1', 'sk-fresh-embedding-secret', '', '1', '3',
    ], switchTarget);
    const cloud = (await loadRuntimeConfig({ configPath: switchTarget })).providers.embeddings;
    expect(cloud).toMatchObject({
      type: 'openai',
      model: 'text-embedding-3-small',
      baseUrl: 'https://embeddings.internal.example/v1',
      apiKey: 'sk-fresh-embedding-secret',
    });
    expect(switched.text).not.toContain('sk-fresh-embedding-secret');
  });

  it('prints the redacted config when review-config is selected from completion', async () => {
    const fixture = writeConfigFixture(path.dirname(configPath), {
      telegramEnabled: true,
      telegramToken: '123456:test-token',
      providerType: 'openai',
      apply: (stored) => { stored.providers.main.apiKey = 'sk-secret'; },
    });
    const output: string[] = [];

    const code = await handleCompletionAction('review-config', fixture.configPath, {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    });

    expect(code).toBe(0);
    expect(output.join('')).toContain('[REDACTED]');
    expect(output.join('')).not.toContain('sk-secret');
    expect(output.join('')).not.toContain('123456:test-token');
  });

  it('starts the daemon with REDACTED_CONFIG_PATH when start is selected', async () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: { cwd?: string | URL; env?: NodeJS.ProcessEnv; stdio?: string; detached?: boolean } }> = [];
    const fixture = writeConfigFixture(path.dirname(configPath), {
      providerType: 'openai',
      apply: (stored) => {
        stored.providers.main.model = 'gpt-4o-mini';
        stored.providers.main.apiKey = 'sk-test';
        stored.providers.medical = { type: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test' };
        stored.providers.embeddings = { type: 'openai', model: 'text-embedding-3-small', apiKey: 'sk-test' };
        stored.heartbeat.enabled = true;
      },
    });
    fs.mkdirSync(fixture.workspace, { recursive: true });

    const code = await handleCompletionAction(
      'start',
      fixture.configPath,
      { stdout: () => undefined, stderr: () => undefined },
      {
        projectRoot: '/repo',
        existsSync: () => false,
        spawnProcess: (command: string, args: string[], options: SpawnOptions) => {
          spawnCalls.push({ command, args, options: { cwd: options.cwd, env: options.env, stdio: options.stdio as string, detached: options.detached as boolean } });
          return { on: () => undefined, unref: () => undefined, pid: 42 };
        },
        startupWindowMs: 1,
      },
    );

    expect(code).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]).toMatchObject({
      command: process.execPath,
      args: ['--import', 'tsx', path.join('/repo', 'src', 'index.ts')],
      options: { cwd: '/repo', stdio: 'ignore', detached: true },
    });
    expect(spawnCalls[0].options.env?.REDACTED_CONFIG_PATH).toBe(fixture.configPath);
  });

  it.each([
    { event: 'error', args: [new Error('spawn failed')], message: 'Failed to start MedClaw: spawn failed' },
    { event: 'exit', args: [1, null], message: 'MedClaw exited during startup (1)' },
  ])('reports a daemon $event during startup instead of claiming success', async ({ event, args, message }) => {
    const errors: string[] = [];

    const result = await startDaemon(
      configPath,
      { stderr: (text: string) => errors.push(text) },
      {
        projectRoot: '/repo',
        existsSync: () => false,
        spawnProcess: () => ({
          on: (name: 'error' | 'exit', listener: (...values: unknown[]) => void) => {
            if (name === event) setTimeout(() => listener(...args), 0);
            return undefined;
          },
          unref: () => undefined,
        }),
        startupWindowMs: 50,
      },
    );

    expect(result.started).toBe(false);
    expect(result.message).toContain(message);
    expect(errors.join('')).not.toContain('spawn failed');
  });
});
