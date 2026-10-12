import * as fs from 'fs';
import * as path from 'path';
import type { SpawnOptions } from 'child_process';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { writeConfigFixture } from '../helpers/config-fixture';
import { maskSecret, renderStepHeader, renderStatus, renderWizardBanner } from '../../src/cli/wizard-render';
import { askChoice, askSecret, askValue } from '../../src/cli/wizard-prompts';
import {
  handleCompletionAction,
  resolveDaemonLaunchSpec,
  runServiceOnboarding,
  startDaemon,
} from '../../src/cli/service-onboarding';
import { makeTestTemp } from '../helpers/test-temp';
import { observeProviderWire } from '../helpers/provider-wire';
import { runCli } from '../../src/cli';

jest.mock('openai', () => jest.requireActual('../helpers/provider-wire').offlineOpenAIFactory());

describe('setup wizard', () => {
  let tmpDir: string;
  let workspacePath: string;
  let stateRoot: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-setup-wizard-');
    workspacePath = path.join(tmpDir, 'workspace');
    // S1 change (old -> new): the wizard now asks for the owner STATE ROOT and the OWNER ID
    // instead of a raw workspace path. Everything about the owner workspace is derived from that
    // pair, so an answer stream that used to start with a workspace path must now start with a
    // state root followed by an owner id.
    stateRoot = path.join(tmpDir, 'state');
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('masks secrets in wizard summaries', () => {
    expect(maskSecret('sk-secret')).toBe('[REDACTED]');
    expect(maskSecret('')).toBe('(not set)');
    expect(maskSecret(undefined)).toBe('(not set)');
  });

  it('renders installer-style step headers and status lines', () => {
    const output: string[] = [];
    const io = {
      stdout: (text: string) => output.push(text),
    };

    renderWizardBanner(io);
    renderStepHeader(io, 1, 5, 'Workspace');
    renderStatus(io, 'INFO', 'Collecting workspace settings');

    expect(output.join('')).toContain('MedClaw');
    expect(output.join('')).toContain('Personal AI Health Assistant');
    expect(output.join('')).toContain('[1/5] Workspace');
    expect(output.join('')).toContain('------------------------------------------------------------');
    expect(output.join('')).toContain('[INFO] Collecting workspace settings');
  });

  it('re-prompts invalid review actions instead of exiting the wizard', async () => {
    const errors: string[] = [];
    const answers = ['bogus', 'telegram'];

    const action = await askChoice(
      {
        input: async () => answers.shift() ?? '',
        stderr: (text: string) => errors.push(text),
      },
      'Review action',
      ['apply', 'telegram'],
      'apply',
    );

    expect(action).toBe('telegram');
    expect(errors.join('')).toContain('Invalid choice');
  });

  it('returns the canonical option when choice input differs only by case', async () => {
    const action = await askChoice(
      {
        input: async () => 'openai',
      },
      'Provider',
      ['Ollama', 'OpenAI'],
      'Ollama',
    );

    expect(action).toBe('OpenAI');
  });

  it('uses the hidden secret input path and preserves prefilled defaults without leaking them in the prompt', async () => {
    const plainInput = jest.fn(async () => 'plain-input-should-not-run');
    const secretPrompts: string[] = [];

    const secret = await askSecret(
      {
        input: plainInput,
        secretInput: async (prompt: string) => {
          secretPrompts.push(prompt);
          return '';
        },
      },
      'Telegram bot token',
      '123456:prefilled-token',
    );

    expect(secret).toBe('123456:prefilled-token');
    expect(plainInput).not.toHaveBeenCalled();
    expect(secretPrompts).toEqual(['Telegram bot token']);
    expect(secretPrompts.join('')).not.toContain('123456:prefilled-token');
  });

  it('shows visible defaults for ordinary setup values', async () => {
    const prompts: string[] = [];

    const value = await askValue(
      {
        input: async (prompt: string) => {
          prompts.push(prompt);
          return '';
        },
      },
      'Workspace path',
      '/tmp/redacted-workspace',
    );

    expect(value).toBe('/tmp/redacted-workspace');
    expect(prompts).toEqual(['• Workspace path\n  default: /tmp/redacted-workspace\n  › ']);
  });

  it('runs the staged interactive wizard, saves config, and exits cleanly', async () => {
    const output: string[] = [];
    // C04 (R05) answer-stream migration: the wizard gained a separate EMBEDDING step between
    // the provider step and Telegram. The old order was main model, medical model, embedding
    // model, Ollama URL; the new order is main model, medical model, Ollama URL (still the LOCAL
    // provider control), then embedding provider, embedding URL, embedding model. Every answer
    // below keeps its original meaning, so each pre-existing assertion in this case is unchanged.
    const answers = [
      stateRoot,
      'default',
      'ollama',
      '',
      '',
      '',
      'ollama',
      '',
      '',
      'y',
      '123456:test-token',
      'Asia/Kolkata',
      'y',
      '1',
      '3',
    ];

    const code = await runServiceOnboarding(['--config', configPath], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => answers.shift() ?? '',
    });

    expect(code).toBe(0);
    expect(output.join('')).toContain('[1/5]');
    expect(output.join('')).toContain('Review');
    expect(output.join('')).toContain('Setup complete');
    expect(output.join('')).not.toContain('123456:test-token');
    expect(fs.existsSync(configPath)).toBe(true);

    const config = await loadRuntimeConfig({ configPath });
    expect(config.channels.telegram.botToken).toBe('123456:test-token');
  });

  it('M02 uses only the newly selected main-provider credential after review edits, but preserves unchanged selection', async () => {
    const before = { openai: process.env.OPENAI_API_KEY, router: process.env.OPENROUTER_API_KEY };
    try {
      for (const [from, to, source] of [
        ['openai', 'openrouter', 'environment'], ['openrouter', 'openai', 'environment'],
        ['openai', 'openrouter', 'hidden'], ['openrouter', 'openai', 'hidden'],
        ['openai', 'openai', 'unchanged'],
      ]) {
        delete process.env.OPENAI_API_KEY;
        delete process.env.OPENROUTER_API_KEY;
        const ownKey = source === 'environment' ? 'synthetic-new-env' : 'synthetic-new-hidden';
        if (source === 'environment') process.env[to === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'] = ownKey;
        const target = path.join(tmpDir, `${from}-${to}-${source}`, 'config.json');
        const output: string[] = [], prompts: string[] = [], secrets: string[] = [];
        let selections = 0, reviews = 0;
        expect(await runServiceOnboarding([
          '--config', target, '--provider', from, '--api-key', 'synthetic-old-main',
        ], {
          stdout: (text: string): void => { output.push(text); }, stderr: (text: string): void => { output.push(text); },
          input: async (prompt: string): Promise<string> => {
            prompts.push(prompt);
            if (prompts.length > 80) throw Error('M02 answer bound exceeded');
            if (prompt.includes('Provider type\n')) return ++selections === 1 ? from : to;
            if (prompt.includes('Review action\n')) return ++reviews === 1 ? 'provider' : 'apply';
            return prompt.includes('Next action\n') ? 'exit' : '';
          },
          secretInput: async (prompt: string): Promise<string> => {
            secrets.push(prompt);
            if (secrets.length > 8) throw Error('M02 secret bound exceeded');
            return selections === 1 || source === 'unchanged' ? '' : ownKey;
          },
        })).toBe(0);
        expect(selections).toBe(2);
        const loaded = await loadRuntimeConfig({ configPath: target });
        const expectedKey = source === 'unchanged' ? 'synthetic-old-main' : ownKey;
        expect(loaded.providers.main.type).toBe(to);
        expect(loaded.providers.main.apiKey).toBe(source === 'environment' ? undefined : expectedKey);
        const wire = await observeProviderWire(loaded.providers.main);
        expect(wire.requests).toEqual([{
          url: to === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions',
          authorization: `Bearer ${expectedKey}`, model: loaded.providers.main.model,
        }]);
        expect(wire.reply).toMatchObject({ type: 'text', text: 'Synthetic reply' });
        expect(loaded.providers.medical.type).toBe('ollama');
        expect(loaded.providers.embeddings.type).toBe('ollama');
        for (const key of ['synthetic-old-main', ownKey]) expect(output.join('') + prompts.join('') + secrets.join('')).not.toContain(key);
      }
    } finally {
      if (before.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before.openai;
      if (before.router === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = before.router;
    }
  });

  it('M03 preserves the custom local medical endpoint through main-provider review edits, persisted reload and cloud adapter use', async () => {
    const before = { openai: process.env.OPENAI_API_KEY, router: process.env.OPENROUTER_API_KEY };
    try {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      for (const cloud of ['openai', 'openrouter']) {
        const target = path.join(tmpDir, `local-to-${cloud}`, 'config.json');
        const output: string[] = [];
        let selections = 0, reviews = 0, prompts = 0;
        expect(await runCli([
          '--config', target, 'onboard', '--provider', 'ollama',
          '--ollama-url', 'http://127.0.0.1:11435/v1', '--medical-model', 'synthetic-local-medical',
          '--embedding-url', 'http://127.0.0.1:11436/v1', '--embedding-model', 'synthetic-embedding',
        ], {
          stdout: (text: string): void => { output.push(text); },
          stderr: (text: string): void => { output.push(text); },
          input: async (prompt: string): Promise<string> => {
            if (++prompts > 80) throw Error('M03 answer bound exceeded');
            if (prompt.includes('Provider type\n')) return ++selections === 1 ? 'ollama' : cloud;
            if (prompt.includes('Main model\n')) return 'synthetic-main';
            if (prompt.includes('Review action\n')) return ++reviews === 1 ? 'provider' : 'apply';
            return prompt.includes('Next action\n') ? 'exit' : '';
          },
          secretInput: async (): Promise<string> => 'synthetic-cloud-key',
        })).toBe(0);
        expect({ selections, reviews }).toEqual({ selections: 2, reviews: 2 });
        const saved = JSON.parse(fs.readFileSync(target, 'utf8')) as {
          providers: { medical: unknown; embeddings: unknown };
        };
        const loaded = await loadRuntimeConfig({ configPath: target });
        const medical = { type: 'ollama', model: 'synthetic-local-medical', baseUrl: 'http://127.0.0.1:11435/v1' };
        const embeddings = { type: 'ollama', model: 'synthetic-embedding', baseUrl: 'http://127.0.0.1:11436/v1' };
        expect(saved.providers.medical).toMatchObject(medical);
        expect(saved.providers.embeddings).toMatchObject(embeddings);
        expect(loaded.providers.medical).toMatchObject(medical);
        expect(loaded.providers.embeddings).toMatchObject(embeddings);
        const wire = await observeProviderWire(loaded.providers.main);
        expect(wire.requests).toEqual([{
          url: cloud === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions',
          authorization: 'Bearer synthetic-cloud-key', model: 'synthetic-main',
        }]);
        expect(wire.reply).toMatchObject({ type: 'text', text: 'Synthetic reply' });
        expect(output.join('')).not.toContain('synthetic-cloud-key');
      }
    } finally {
      if (before.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before.openai;
      if (before.router === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = before.router;
    }
  });

  it('M02 refuses a blank cloud medical model in review, then applies the explicitly selected model without a local default', async () => {
    const target = path.join(tmpDir, 'medical-model-wizard', 'config.json');
    const output: string[] = [], modelPrompts: string[] = [];
    let reviews = 0, prompts = 0;
    expect(await runServiceOnboarding([
      '--config', target, '--provider', 'openai', '--api-key', 'synthetic-main',
      '--medical-provider', 'openrouter', '--medical-api-key', 'synthetic-medical',
    ], {
      stdout: (text: string): void => { output.push(text); }, stderr: (text: string): void => { output.push(text); },
      input: async (prompt: string): Promise<string> => {
        if (++prompts > 80) throw Error('M02 model answer bound exceeded');
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
    expect(reviews).toBe(3);
    expect(modelPrompts.length).toBe(2);
    expect(modelPrompts[0]).not.toContain('medgemma');
    const loaded = await loadRuntimeConfig({ configPath: target });
    expect(loaded.providers.medical).toMatchObject({ type: 'openrouter', model: 'synthetic/chosen-medical', apiKey: 'synthetic-medical' });
    expect((await observeProviderWire(loaded.providers.medical)).requests).toEqual([{
      url: 'https://openrouter.ai/api/v1/chat/completions', authorization: 'Bearer synthetic-medical', model: 'synthetic/chosen-medical',
    }]);
    expect(output.join('')).toContain('--medical-model');
    expect(output.join('')).not.toContain('synthetic-medical');
  });

  // ── R05 through the INTERACTIVE path (brief §8B) ───────────────────────────────────────────

  it('M01 preserves the medical role and its own credential through main-provider review edits and real apply/reload', async () => {
    const before = { openai: process.env.OPENAI_API_KEY, router: process.env.OPENROUTER_API_KEY };
    delete process.env.OPENAI_API_KEY;
    try {
      for (const source of ['environment', 'explicit', 'hidden-input']) {
        if (source === 'environment') process.env.OPENROUTER_API_KEY = 'synthetic-medical-environment';
        else delete process.env.OPENROUTER_API_KEY;
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
            if (prompt.includes('Next action\n')) return 'exit';
            return '';
          },
          secretInput: async (prompt: string): Promise<string> => {
            secrets.push(prompt);
            if (secrets.length > 8) throw Error('Wizard exceeded bounded secret script');
            return source === 'hidden-input' && prompt.includes('medical') ? 'synthetic-medical-hidden' : '';
          },
        });
        expect(code).toBe(0);
        expect(providerSteps).toBe(2);
        const loaded = await loadRuntimeConfig({ configPath: target });
        expect(loaded.providers.main.type).toBe('ollama');
        expect(loaded.providers.main.apiKey).toBeUndefined();
        expect(loaded.providers.medical).toMatchObject({ type: 'openrouter', model: 'synthetic/medical' });
        const ownKey = source === 'environment' ? 'synthetic-medical-environment' : source === 'explicit' ? 'synthetic-medical-explicit' : 'synthetic-medical-hidden';
        expect(loaded.providers.medical.apiKey).toBe(source === 'environment' ? undefined : ownKey);
        expect(loaded.providers.embeddings.type).toBe('ollama');
        const wire = await observeProviderWire(loaded.providers.medical);
        expect(wire.requests).toEqual([{ url: 'https://openrouter.ai/api/v1/chat/completions', authorization: `Bearer ${ownKey}`, model: 'synthetic/medical' }]);
        expect(wire.reply).toMatchObject({ type: 'text', text: 'Synthetic reply' });
        const shown = output.join('') + prompts.join('') + secrets.join('');
        expect(shown).not.toContain('synthetic-main-only');
        expect(shown).not.toContain(ownKey);
        expect(output.join('')).toContain('Medical provider');
        if (source === 'hidden-input') expect(secrets.some(prompt => prompt.includes('medical'))).toBe(true);
        if (source === 'environment') expect(secrets.some(prompt => prompt.includes('medical'))).toBe(false);
      }
    } finally {
      if (before.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = before.openai;
      if (before.router === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = before.router;
    }
  });
  it('M01 checks only local medical models in the real wizard catalog flow and cancels without publication', async () => {
    for (const medical of ['openrouter', 'ollama']) {
      const output: string[] = [], requests: string[] = [];
      const target = path.join(tmpDir, `catalog-${medical}`, 'config.json');
      const model = medical === 'ollama' ? 'synthetic-local-medical-missing' : 'synthetic/cloud-medical';
      let prompts = 0;
      const code = await runServiceOnboarding([
        '--config', target, '--provider', 'ollama', '--main-model', 'synthetic-local-main',
        '--medical-provider', medical, '--medical-model', model,
        ...(medical === 'openrouter' ? ['--medical-api-key', 'synthetic-medical-key'] : []),
      ], {
        stdout: (text: string): void => { output.push(text); }, stderr: (text: string): void => { output.push(text); },
        input: async (prompt: string): Promise<string> => {
          if (++prompts > 40) throw Error('Catalog flow exceeded bounded script');
          return prompt.includes('Review action\n') ? 'cancel' : '';
        },
        secretInput: async (): Promise<string> => '',
      }, {
        fetchImpl: async (url): Promise<Response> => {
          requests.push(String(url));
          if (!['http://localhost:11434/api/tags', 'http://localhost:11434/api/version'].includes(String(url))) throw Error('Unscripted catalog URL refused');
          const body = String(url).endsWith('/api/version') ? { version: 'synthetic' } : { models: [{ name: 'synthetic-local-main' }, { name: 'embeddinggemma:latest' }] };
          return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      });
      expect(code).toBe(0);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(url => ['http://localhost:11434/api/tags', 'http://localhost:11434/api/version'].includes(url))).toBe(true);
      expect(output.join('')).toContain('Ollama reachable.');
      if (medical === 'ollama') expect(output.join('')).toContain(`Missing Ollama model: ${model}. Run \`ollama pull ${model}\`.`);
      else expect(output.join('')).not.toContain(`ollama pull ${model}`);
      expect(output.join('')).not.toContain('synthetic-medical-key');
      expect(output.join('')).toContain('Setup cancelled. No files were written.');
      expect(fs.existsSync(path.dirname(target))).toBe(false);
    }
  });
  //
  // The noninteractive half is covered in tests/cli/service-onboarding.test.ts. These cases drive
  // the real wizard answer stream, through review, apply, the real writer and the real loader, so
  // the whole state→args→config→persist→reload round trip is exercised for the embedding role.
  it('keeps embeddings local when the operator picks a cloud chat provider in the wizard', async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const output: string[] = [];
      const prompts: string[] = [];
      const answers = [
        stateRoot,
        'default',
        'openai',                      // chat provider: cloud
        'sk-wizard-main-secret',       // chat role key
        '',                            // main model
        '',                            // medical model
        'ollama',                      // embeddings: local, chosen independently
        '',                            // local embedding URL
        '',                            // embedding model
        'n',                           // telegram
        'Asia/Kolkata',
        'n',                           // heartbeats
        '1',                           // apply
        '3',                           // exit
      ];

      const code = await runServiceOnboarding(['--config', configPath], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async (prompt: string) => {
          prompts.push(prompt);
          return answers.shift() ?? '';
        },
      });

      expect(code).toBe(0);
      // The wizard really asked for the embedding role separately.
      expect(prompts.some((prompt) => prompt.includes('Embedding provider'))).toBe(true);

      const config = await loadRuntimeConfig({ configPath });
      expect(config.providers.main.type).toBe('openai');
      expect(config.providers.main.apiKey).toBe('sk-wizard-main-secret');
      // The R05 assertion on the interactive path: local embeddings, main key not copied.
      expect(config.providers.embeddings).toEqual({
        type: 'ollama',
        model: 'embeddinggemma:latest',
        baseUrl: 'http://localhost:11434/v1',
      });
      // The review summary must SHOW the selected role, not just the model.
      expect(output.join('')).toContain('Embedding provider');
      expect(output.join('')).not.toContain('sk-wizard-main-secret');
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  it('keeps the default local embedding role even when only a cloud chat provider is selected', async () => {
    // Discriminating case for the DEFAULT (not an explicit choice). This is the assertion that
    // fails if embeddings are re-coupled to the chat provider: the operator answers NOTHING for
    // the embedding role and simply accepts each default.
    //
    // `--embedding-api-key` is supplied so the seeded key is available if the role ever resolves to
    // a cloud provider; on the correct path the role stays local and the flag is unused. Without it,
    // a re-coupled build would enter the wizard's "embedding key required" re-prompt loop and the
    // run would hang rather than fail an assertion.
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const output: string[] = [];
      const answers = [
        stateRoot,
        'default',
        'openai',                              // chat provider
        'sk-wizard-main-secret',
        '',                                    // main model
        '',                                    // medical model
        '',                                    // Embedding provider -> ACCEPT THE DEFAULT
        '',                                    // Local embedding URL -> default
        '',                                    // embedding model -> default
        'n',
        'Asia/Kolkata',
        'n',
        '1',
        '3',
      ];

      const code = await runServiceOnboarding(
        [
          '--config', configPath,
          '--embedding-api-key', 'sk-seeded-embedding-key',
        ],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => answers.shift() ?? '',
        },
      );

      expect(code).toBe(0);
      const config = await loadRuntimeConfig({ configPath });
      expect(config.providers.main.type).toBe('openai');
      expect(config.providers.embeddings).toEqual({
        type: 'ollama',
        model: 'embeddinggemma:latest',
        baseUrl: 'http://localhost:11434/v1',
      });
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  it('carries an explicit remote embedding role through wizard review, apply and reload', async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const output: string[] = [];
      const answers = [
        stateRoot,
        'default',
        'openai',                      // chat provider
        'sk-wizard-main-secret',       // chat role key
        '',                            // main model
        '',                            // medical model
        'openai',                      // embeddings: cloud, chosen independently
        'https://embeddings.internal.example/v1',  // embedding endpoint
        'sk-wizard-embedding-secret',  // embedding role key (secret input)
        '',                            // embedding model
        'n',                           // telegram
        'Asia/Kolkata',
        'n',
        '1',                           // apply
        '3',
      ];

      const code = await runServiceOnboarding(['--config', configPath], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => answers.shift() ?? '',
      });

      expect(code).toBe(0);
      const config = await loadRuntimeConfig({ configPath });
      // Provider, endpoint, model AND key survive the round trip as this role's own values.
      expect(config.providers.embeddings).toEqual({
        type: 'openai',
        model: 'text-embedding-3-small',
        baseUrl: 'https://embeddings.internal.example/v1',
        apiKey: 'sk-wizard-embedding-secret',
      });
      expect(config.providers.main.apiKey).toBe('sk-wizard-main-secret');
      // Neither secret may appear anywhere in the operator-visible output.
      const combined = output.join('');
      expect(combined).not.toContain('sk-wizard-main-secret');
      expect(combined).not.toContain('sk-wizard-embedding-secret');
      // The honest remote-embeddings warning must survive.
      expect(combined).toContain('Remote embeddings');
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  it('never prints embedding endpoint credentials in the review summary', async () => {
    // Cold re-review D2. The review row added for R05 printed the raw base URL, so a configured
    // `user:password@` endpoint reached the terminal even though the config summary sanitizes it.
    // The env key is deleted so the secret prompt is deterministic (one answer per prompt).
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
    const output: string[] = [];
    // Prompt order for main=ollama: state root, owner id, provider, main model, medical model,
    // Ollama URL, then the EMBEDDING step: provider, endpoint, key, model. Exactly one answer per
    // prompt; an extra blank would make this case assert a local role and pass vacuously.
    const answers = [
      stateRoot,
      'default',
      'ollama',
      '',                                          // main model
      '',                                          // medical model
      '',                                          // Ollama URL (default)
      'openai',                                    // embedding provider: cloud
      'https://url-user:url-password@embeddings.internal.example/v1',
      'sk-review-embedding-secret',
      '',                                          // embedding model (provider default)
      'n',
      'Asia/Kolkata',
      'n',
      '1',
      '3',
    ];

    const code = await runServiceOnboarding(['--config', configPath], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => answers.shift() ?? '',
    });

    expect(code).toBe(0);
    const printed = output.join('');
    expect(printed).not.toContain('url-user');
    expect(printed).not.toContain('url-password');
    expect(printed).not.toContain('sk-review-embedding-secret');
    // The review row and the summary still identify the endpoint.
    expect(printed).toContain('embeddings.internal.example');
    expect(printed).toContain('Embedding endpoint');
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  it('never shows endpoint credentials in a wizard prompt default', async () => {
    // Cold re-review: the endpoint prompts pass the current value to `askValue`, which prints it as
    // `default: <value>`. A credential-bearing endpoint must not reach that visible default, while
    // pressing Enter must still KEEP the raw configured value.
    //
    // The embedding role stays LOCAL: switching providers deliberately drops the previous role's
    // endpoint (R05), so a cloud switch would clear the value before any prompt could show it. The
    // local path is where a prefilled userinfo endpoint genuinely reaches the prompt.
    const output: string[] = [];
    const prompts: string[] = [];
    const answers = [
      stateRoot,
      'default',
      'ollama',                                    // chat provider
      '',                                          // main model
      '',                                          // medical model
      '',                                          // Ollama URL (default)
      'ollama',                                    // embedding provider: local
      '',                                          // Local embedding URL: accept the current value
      '',                                          // embedding model
      'n',
      'Asia/Kolkata',
      'n',
      '1',
      '3',
    ];

    const code = await runServiceOnboarding(
      [
        '--config', configPath,
        '--embedding-url', 'https://url-user:url-password@proxy.example/v1',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async (prompt: string) => {
          prompts.push(prompt);
          return answers.shift() ?? '';
        },
      },
    );

    expect(code).toBe(0);
    const shown = prompts.join('\n') + output.join('');
    expect(shown).not.toContain('url-user');
    expect(shown).not.toContain('url-password');
    // The configured endpoint was KEPT (Enter on the sanitized default), not silently stripped.
    const config = await loadRuntimeConfig({ configPath });
    expect(config.providers.embeddings.baseUrl).toBe('https://url-user:url-password@proxy.example/v1');
  });

  it('keeps the inherited raw endpoint when the operator accepts the sanitized embedding default', async () => {
    // Cold re-review F2. The first version of `askEndpointValue` returned the SANITIZED visible
    // default on Enter when `current` was undefined, so accepting the inherited endpoint silently
    // stripped credentials the main role kept. Enter must keep the source value (the inherited
    // fallback), while the prompt shows only its sanitized form.
    const output: string[] = [];
    const prompts: string[] = [];
    const credentialed = 'https://url-user:url-password@127.0.0.1:11434/v1';
    const answers = [
      stateRoot,
      'default',
      'ollama',                                    // chat provider
      '',                                          // main model
      '',                                          // medical model
      '',                                          // Ollama URL: accept the credentialed current
      'ollama',                                    // embedding provider: local
      '',                                          // Local embedding URL: accept inherited fallback
      '',                                          // embedding model
      'n',
      'Asia/Kolkata',
      'n',
      '1',
      '3',
    ];

    const code = await runServiceOnboarding(
      ['--config', configPath, '--ollama-url', credentialed],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async (prompt: string) => {
          prompts.push(prompt);
          return answers.shift() ?? '';
        },
      },
    );

    expect(code).toBe(0);
    const shown = prompts.join('\n') + output.join('');
    expect(shown).not.toContain('url-user');
    expect(shown).not.toContain('url-password');
    const config = await loadRuntimeConfig({ configPath });
    // The inherited raw endpoint is preserved, not the sanitized display form.
    expect(config.providers.main.baseUrl).toBe(credentialed);
    expect(config.providers.embeddings.baseUrl).toBe(credentialed);
  });

  it('preserves an explicit embedding selection when the main provider is edited afterwards', async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const output: string[] = [];
      // 1st pass: cloud chat + explicit cloud embeddings. Then Review > provider re-entry that
      // switches the CHAT provider to ollama. The embedding role must not be rewritten.
      const answers = [
        stateRoot,
        'default',
        'openai',                              // chat provider
        'sk-wizard-main-secret',               // chat role key
        '',                                    // main model
        '',                                    // medical model
        'openai',                              // embeddings provider
        'https://embeddings.internal.example/v1',
        'sk-wizard-embedding-secret',
        '',                                    // embedding model
        'n',
        'Asia/Kolkata',
        'n',
        'provider',                            // review action: EDIT the chat provider
        'ollama',                              // switch the chat provider to local
        '',                                    // main model
        '',                                    // medical model
        '',                                    // Ollama URL
        '1',                                   // review action: apply
        '3',
      ];

      const code = await runServiceOnboarding(['--config', configPath], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => answers.shift() ?? '',
      });

      expect(code).toBe(0);
      const config = await loadRuntimeConfig({ configPath });
      // The main role did change…
      expect(config.providers.main.type).toBe('ollama');
      expect(config.providers.main.baseUrl).toBe('http://localhost:11434/v1');
      // …and the explicitly selected embedding role was NOT reset by that edit. Before the repair
      // a main-provider change overwrote the embedding model with the main provider's defaults.
      expect(config.providers.embeddings).toEqual({
        type: 'openai',
        model: 'text-embedding-3-small',
        baseUrl: 'https://embeddings.internal.example/v1',
        apiKey: 'sk-wizard-embedding-secret',
      });
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  it('drops a stale role-incompatible credential when the embedding provider is changed', async () => {
    const output: string[] = [];
    // Start local, then Review > embeddings switches it to a cloud role. The remote role must ask
    // for its OWN endpoint and key rather than reusing anything local, and must land its own values.
    const answers = [
      stateRoot,
      'default',
      'ollama',                              // chat provider (local)
      '',                                    // main model
      '',                                    // medical model
      '',                                    // Ollama URL
      'ollama',                              // embeddings: local
      '',                                    // local embedding URL
      '',                                    // embedding model
      'n',
      'Asia/Kolkata',
      'n',
      'embeddings',                          // review action: EDIT the embedding role
      'openai',                              // switch embeddings to cloud
      'https://embeddings.internal.example/v1',  // endpoint for the NEW role
      'sk-fresh-embedding-secret',           // key for the NEW role
      '',                                    // embedding model for the new provider
      '1',                                   // apply
      '3',
    ];

    const code = await runServiceOnboarding(['--config', configPath], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => answers.shift() ?? '',
    });

    expect(code).toBe(0);
    const config = await loadRuntimeConfig({ configPath });
    expect(config.providers.embeddings.type).toBe('openai');
    // The new provider's own default model, not a stale local model and not a stray menu number.
    expect(config.providers.embeddings.model).toBe('text-embedding-3-small');
    expect(config.providers.embeddings.baseUrl).toBe('https://embeddings.internal.example/v1');
    expect(config.providers.embeddings.apiKey).toBe('sk-fresh-embedding-secret');
    // The local endpoint must NOT survive into the cloud embedding role.
    expect(config.providers.embeddings.baseUrl).not.toContain('11434');
    expect(output.join('')).not.toContain('sk-fresh-embedding-secret');
  });

  it('keeps the independent on-device medical role and raw-media privacy choice through the round trip', async () => {
    // R05 must not disturb the existing forka #11 medical independence or the raw-media privacy
    // guard (specs/13 amendment B). Cloud chat + local medical + local embeddings, all through the
    // wizard, must still reload with medical on-device and its privacy flag intact.
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const answers = [
        stateRoot,
        'default',
        'openai',
        'sk-wizard-main-secret',
        '',
        '',                          // medical model default = on-device medgemma
        'ollama',
        '',
        '',
        'n',
        'Asia/Kolkata',
        'n',
        '1',
        '3',
      ];

      const code = await runServiceOnboarding(['--config', configPath], {
        stdout: () => undefined,
        stderr: () => undefined,
        input: async () => answers.shift() ?? '',
      });

      expect(code).toBe(0);
      const config = await loadRuntimeConfig({ configPath });
      expect(config.providers.medical).toEqual({
        type: 'ollama',
        model: 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest',
        baseUrl: 'http://localhost:11434/v1',
      });
      // Raw-medical-media must stay refused (undefined/false), i.e. default-on privacy guard.
      expect(config.providers.medical.allowRawMedicalMedia ?? false).toBe(false);
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  it('shows readiness and validation summary during completion, not just review', async () => {
    const output: string[] = [];
    // C04 (R05) answer-stream migration: the wizard gained a separate EMBEDDING step between
    // the provider step and Telegram. The old order was main model, medical model, embedding
    // model, Ollama URL; the new order is main model, medical model, Ollama URL (still the LOCAL
    // provider control), then embedding provider, embedding URL, embedding model. Every answer
    // below keeps its original meaning, so each pre-existing assertion in this case is unchanged.
    const answers = [
      stateRoot,
      'default',
      'ollama',
      '',
      '',
      '',
      'ollama',
      '',
      '',
      'n',
      'Asia/Kolkata',
      'y',
      '1',
      '3',
    ];

    const code = await runServiceOnboarding(['--config', configPath], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => answers.shift() ?? '',
    });

    expect(code).toBe(0);
    const completionOutput = output.join('');
    expect(completionOutput).toContain(`Config written to ${configPath}`);
    expect(completionOutput).toContain('status:');
    expect(completionOutput).toContain('main provider:');
    expect(completionOutput).toContain('telegram:');
  });

  it('preserves a prefilled telegram token when Enter is pressed at the prompt', async () => {
    const output: string[] = [];
    // C04 (R05) answer-stream migration, same reordering as above. This case's answers are almost
    // all "accept the default"; the extra step only inserts two more accepted defaults.
    const answers = [
      workspacePath,   // 1  owner state root
      '',              // 2  owner id (default)
      '',              // 3  main provider type (default ollama)
      '',              // 4  main model
      '',              // 5  medical model
      '',              // 6  Ollama URL (the LOCAL provider control)
      'ollama',        // 7  embedding provider (independent role)
      '',              // 8  local embedding URL
      '',              // 9  embedding model
      '',              // 10 enable Telegram (prefilled true)
      '',              // 11 Telegram bot token (prefilled secret, kept on Enter)
      '',              // 12 timezone
      '',              // 13 enable heartbeats
      '1',             // 14 review action: apply
      '3',             // 15 completion action: exit
    ];

    const code = await runServiceOnboarding(
      [
        '--config', configPath,
        '--telegram-enabled', 'true',
        '--telegram-token', '123456:prefilled-token',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => answers.shift() ?? '',
      },
    );

    expect(code).toBe(0);
    expect(output.join('')).not.toContain('123456:prefilled-token');

    const config = await loadRuntimeConfig({ configPath });
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.telegram.botToken).toBe('123456:prefilled-token');
  });

  it('allows editing from review before persisting config', async () => {
    const output: string[] = [];
    // C04 (R05) answer-stream migration: the wizard gained a separate EMBEDDING step between
    // the provider step and Telegram. The old order was main model, medical model, embedding
    // model, Ollama URL; the new order is main model, medical model, Ollama URL (still the LOCAL
    // provider control), then embedding provider, embedding URL, embedding model. Every answer
    // below keeps its original meaning, so each pre-existing assertion in this case is unchanged.
    const answers = [
      stateRoot,
      'default',
      'ollama',
      '',
      '',
      '',
      'ollama',
      '',
      '',
      'n',
      'Asia/Kolkata',
      'y',
      'telegram',
      'y',
      '123456:updated-token',
      '1',
      '3',
    ];

    const code = await runServiceOnboarding(['--config', configPath], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => answers.shift() ?? '',
    });

    expect(code).toBe(0);
    expect(output.join('')).toContain('Telegram');
    expect(output.join('')).toContain('[REDACTED]');

    const config = await loadRuntimeConfig({ configPath });
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.telegram.botToken).toBe('123456:updated-token');
  });

  it('re-prompts immediately when telegram is enabled without a token', async () => {
    const output: string[] = [];
    // C04 (R05) answer-stream migration: the wizard gained a separate EMBEDDING step between
    // the provider step and Telegram. The old order was main model, medical model, embedding
    // model, Ollama URL; the new order is main model, medical model, Ollama URL (still the LOCAL
    // provider control), then embedding provider, embedding URL, embedding model. Every answer
    // below keeps its original meaning, so each pre-existing assertion in this case is unchanged.
    const answers = [
      stateRoot,
      'default',
      'ollama',
      '',
      '',
      '',
      'ollama',
      '',
      '',
      'y',
      '',
      '123456:retried-token',
      'Asia/Kolkata',
      'y',
      '1',
      '3',
    ];

    const code = await runServiceOnboarding(['--config', configPath], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => answers.shift() ?? '',
    });

    expect(code).toBe(0);
    expect(output.join('')).toContain('Telegram bot token is required when Telegram is enabled.');

    const config = await loadRuntimeConfig({ configPath });
    expect(config.channels.telegram.botToken).toBe('123456:retried-token');
  });

  it('can cancel from review without persisting config', async () => {
    const output: string[] = [];
    // C04 (R05) answer-stream migration: the wizard gained a separate EMBEDDING step between
    // the provider step and Telegram. The old order was main model, medical model, embedding
    // model, Ollama URL; the new order is main model, medical model, Ollama URL (still the LOCAL
    // provider control), then embedding provider, embedding URL, embedding model. Every answer
    // below keeps its original meaning, so each pre-existing assertion in this case is unchanged.
    const answers = [
      stateRoot,
      'default',
      'ollama',
      '',
      '',
      '',
      'ollama',
      '',
      '',
      'n',
      'Asia/Kolkata',
      'y',
      'cancel',
    ];

    const code = await runServiceOnboarding(['--config', configPath], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => answers.shift() ?? '',
    });

    expect(code).toBe(0);
    expect(output.join('')).toContain('Setup cancelled. No files were written.');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('does not create workspace or config directories when cancelled from review', async () => {
    const nestedWorkspacePath = path.join(tmpDir, 'cancelled', 'workspace');
    const nestedConfigPath = path.join(tmpDir, 'cancelled-config', 'config.json');
    const output: string[] = [];
    // C04 (R05) answer-stream migration, same reordering as above. This case asserts that NOTHING
    // is written on cancel, so no assertion about provider values changes.
    const answers = [
      nestedWorkspacePath,
      'default',
      'ollama',
      '',
      '',
      '',
      'ollama',
      '',
      '',
      'n',
      'Asia/Kolkata',
      'y',
      'cancel',
    ];

    const code = await runServiceOnboarding(['--config', nestedConfigPath], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => answers.shift() ?? '',
    });

    expect(code).toBe(0);
    expect(output.join('')).toContain('Setup cancelled. No files were written.');
    expect(fs.existsSync(nestedWorkspacePath)).toBe(false);
    expect(fs.existsSync(path.dirname(nestedConfigPath))).toBe(false);
    expect(fs.existsSync(nestedConfigPath)).toBe(false);
  });

  it('prints the redacted config when review-config is selected from completion', async () => {
    // RETIRED -> this hand-wrote a document with no `schemaVersion` and no owner identity,
    // which only loaded because decoding used to deep-merge onto defaults. Setup now selects
    // identity, so a servable document must carry it.
    const fixture = writeConfigFixture(path.dirname(configPath), {
      telegramEnabled: true,
      telegramToken: '123456:test-token',
      providerType: 'openai',
      apply: (stored) => {
        stored.providers.main.apiKey = 'sk-secret';
      },
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

  it('prefers dist/index.js when resolving the daemon start command and falls back to tsx source mode otherwise', () => {
    expect(
      resolveDaemonLaunchSpec('/repo', (target: string) => target === path.join('/repo', 'dist', 'index.js')),
    ).toEqual({
      entrypoint: path.join('/repo', 'dist', 'index.js'),
      args: [path.join('/repo', 'dist', 'index.js')],
    });

    expect(resolveDaemonLaunchSpec('/repo', () => false)).toEqual({
      entrypoint: path.join('/repo', 'src', 'index.ts'),
      args: ['--import', 'tsx', path.join('/repo', 'src', 'index.ts')],
    });
  });

  it('starts the daemon with REDACTED_CONFIG_PATH when start is selected', async () => {
    const spawnCalls: Array<{
      command: string;
      args: string[];
      options: { cwd?: string | URL; env?: NodeJS.ProcessEnv; stdio?: string; detached?: boolean };
    }> = [];
    // RETIRED -> the test persisted a hand-built effective config, including the derived
    // owner paths, and expected the preflight to read it. Setup now persists only the stored
    // document, and the preflight re-derives the owner paths from the selected identity.
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
    // The preflight checks the DERIVED owner workspace exists, not the old `--workspace` path.
    fs.mkdirSync(fixture.workspace, { recursive: true });
    fs.mkdirSync(workspacePath, { recursive: true });

    const code = await handleCompletionAction(
      'start',
      fixture.configPath,
      {
        stdout: () => undefined,
        stderr: () => undefined,
      },
      {
        projectRoot: '/repo',
        existsSync: () => false,
        spawnProcess: (command: string, args: string[], options: SpawnOptions) => {
          spawnCalls.push({
            command,
            args,
            options: {
              cwd: options.cwd,
              env: options.env,
              stdio: options.stdio as string,
              detached: options.detached as boolean,
            },
          });
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
      options: {
        cwd: '/repo',
        stdio: 'ignore',
        detached: true,
      },
    });
    expect(spawnCalls[0].options.env?.REDACTED_CONFIG_PATH).toBe(fixture.configPath);
  });

  it('reports daemon startup spawn errors', async () => {
    const errors: string[] = [];
    const result = await startDaemon(
      configPath,
      { stderr: (text: string) => errors.push(text) },
      {
        projectRoot: '/repo',
        existsSync: () => false,
        spawnProcess: () => ({
          on: (event: 'error' | 'exit', listener: (...args: unknown[]) => void) => {
            if (event === 'error') {
              setTimeout(() => listener(new Error('spawn failed')), 0);
            }
            return undefined;
          },
          unref: () => undefined,
        }),
        startupWindowMs: 50,
      },
    );

    expect(result.started).toBe(false);
    expect(result.message).toContain('Failed to start MedClaw: spawn failed');
    expect(errors.join('')).not.toContain('spawn failed');
  });

  it('reports daemon early exits before marking startup successful', async () => {
    const result = await startDaemon(
      configPath,
      {},
      {
        projectRoot: '/repo',
        existsSync: () => false,
        spawnProcess: () => ({
          on: (event: 'error' | 'exit', listener: (...args: unknown[]) => void) => {
            if (event === 'exit') {
              setTimeout(() => listener(1, null), 0);
            }
            return undefined;
          },
          unref: () => undefined,
        }),
        startupWindowMs: 50,
      },
    );

    expect(result.started).toBe(false);
    expect(result.message).toContain('MedClaw exited during startup (1)');
  });
});
