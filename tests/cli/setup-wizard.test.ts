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

  // ── R05 through the INTERACTIVE path (brief §8B) ───────────────────────────────────────────
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
