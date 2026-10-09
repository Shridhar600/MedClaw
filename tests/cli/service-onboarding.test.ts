import * as fs from 'fs';
import * as path from 'path';
import { validateConfig } from '../../src/config/validation';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { buildConfigFromArgs, modelDefaultsForProvider, SUPPORTED_ONBOARDING_PROVIDERS } from '../../src/cli/setup-config';
import { runServiceOnboarding, startDaemon } from '../../src/cli/service-onboarding';
import { fixtureOwner } from '../helpers/test-config';
import { makeTestTemp } from '../helpers/test-temp';

describe('service onboarding init', () => {
  let tmpDir: string;
  let workspacePath: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-cli-init-');
    workspacePath = path.join(tmpDir, 'workspace');
    configPath = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('bootstraps workspace templates without overwriting existing files', async () => {
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'SOUL.md'), 'existing soul', 'utf8');

    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
                '--provider', 'ollama',
        '--main-model', 'kimi-k2.5:cloud',
        '--medical-model', 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest',
        '--embedding-model', 'embeddinggemma:latest',
        '--ollama-url', 'http://localhost:11434/v1',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'true',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => {
          throw new Error('prompt should not be called');
        },
      },
    );

    // RETIRED -> these asserted that setup bootstrapped `--workspace` and created sibling
    // `<config parent>/sessions` and `<config parent>/heartbeats` directories. Setup now
    // selects owner identity and DERIVES one workspace inside the state root, so the owner's
    // workspace is bootstrapped and the scheduler store/audit log live under its `.state`.
    const owner = fixtureOwner(path.dirname(configPath));
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(owner.workspace, 'HEALTH_PROFILE.md'))).toBe(true);
    expect(fs.existsSync(path.join(owner.workspace, 'conditions'))).toBe(true);
    expect(fs.existsSync(path.join(owner.workspace, 'medications'))).toBe(true);
    expect(fs.existsSync(path.join(owner.workspace, 'reports'))).toBe(true);
    expect(fs.existsSync(path.join(owner.workspace, 'goals'))).toBe(true);
    expect(fs.existsSync(path.dirname(owner.storePath))).toBe(true);
    expect(output.join('')).not.toContain('prompt should not be called');
  });

  it('refuses a non-empty owner workspace instead of bootstrapping over existing files', async () => {
    // S1 change (old -> new): this used to pre-create the workspace, assert templates were written
    // around an existing SOUL.md, and prove nothing was overwritten. Setup now REFUSES a non-empty
    // owner workspace outright, so the guarantee is stronger and simpler: nothing is written at all.
    const owner = fixtureOwner(path.dirname(configPath));
    fs.mkdirSync(owner.workspace, { recursive: true });
    fs.writeFileSync(path.join(owner.workspace, 'SOUL.md'), 'existing soul', 'utf8');

    const output: string[] = [];
    const code = await runServiceOnboarding(
      ['--yes', '--config', configPath, '--provider', 'ollama', '--telegram-enabled', 'false'],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => {
          throw new Error('prompt should not be called');
        },
      },
    );

    expect(code).toBe(1);
    expect(output.join('')).toContain('not empty');
    expect(output.join('')).toContain('never removed');
    expect(fs.readFileSync(path.join(owner.workspace, 'SOUL.md'), 'utf8')).toBe('existing soul');
    expect(fs.existsSync(path.join(owner.workspace, 'HEALTH_PROFILE.md'))).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('creates the unpaired owner record before the config document, for the selected owner id', async () => {
    const output: string[] = [];
    const code = await runServiceOnboarding(
      ['--yes', '--config', configPath, '--owner-id', 'kiran', '--provider', 'ollama', '--telegram-enabled', 'false'],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => {
          throw new Error('prompt should not be called');
        },
      },
    );

    expect(code).toBe(0);
    const owner = fixtureOwner(path.dirname(configPath), 'kiran');
    // The record exists, is owner-only, and is unpaired — not a default profile.
    expect(JSON.parse(fs.readFileSync(owner.ownerRecord, 'utf8'))).toMatchObject({
      version: 1,
      ownerId: 'kiran',
      phase: 'unpaired',
    });
    expect(fs.statSync(owner.ownerRecord).mode & 0o777).toBe(0o600);
    // The document selects the SAME identity, so a record can never sit behind a config that
    // disagrees about who the owner is.
    expect(await loadRuntimeConfig({ configPath })).toMatchObject({
      profiles: { baseDir: path.dirname(configPath), defaultProfileId: 'kiran' },
    });
  });

  it('refuses an owner id that the config decoder would later reject', async () => {
    const output: string[] = [];
    const code = await runServiceOnboarding(
      ['--yes', '--config', configPath, '--owner-id', 'Not A Valid Id', '--provider', 'ollama'],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => {
          throw new Error('prompt should not be called');
        },
      },
    );

    expect(code).toBe(1);
    expect(output.join('')).toContain('Invalid --owner-id');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('fails when telegram is enabled without a token', async () => {
    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
                '--provider', 'ollama',
        '--main-model', 'kimi-k2.5:cloud',
        '--medical-model', 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest',
        '--embedding-model', 'embeddinggemma:latest',
        '--ollama-url', 'http://localhost:11434/v1',
        '--telegram-enabled', 'true',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'true',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      },
    );

    expect(code).toBe(1);
    expect(output.join('')).toContain('telegram');
    expect(output.join('')).toContain('token');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('uses TELEGRAM_BOT_TOKEN for non-interactive init without printing it', async () => {
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = '123456:secret-token';
    try {
      const output: string[] = [];
      const code = await runServiceOnboarding(
        [
          '--yes',
          '--config', configPath,
                    '--provider', 'ollama',
          '--telegram-enabled', 'true',
          '--timezone', 'Asia/Kolkata',
          '--heartbeats-enabled', 'true',
        ],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => {
            throw new Error('prompt should not be called');
          },
        },
      );

      expect(code).toBe(0);
      expect(output.join('')).not.toContain('secret-token');
      expect((await loadRuntimeConfig({ configPath })).channels.telegram.botToken).toBe(
        '123456:secret-token',
      );
    } finally {
      if (originalToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = originalToken;
      }
    }
  });

  it('writes a valid config when telegram is disabled', async () => {
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
                '--provider', 'ollama',
        '--main-model', 'kimi-k2.5:cloud',
        '--medical-model', 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest',
        '--embedding-model', 'embeddinggemma:latest',
        '--ollama-url', 'http://localhost:11434/v1',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'true',
      ],
      {
        stdout: () => undefined,
        stderr: () => undefined,
        input: async () => '',
      },
    );

    expect(code).toBe(0);
    const config = await loadRuntimeConfig({ configPath });
    const result = validateConfig(config);

    expect(config.channels.telegram.enabled).toBe(false);
    expect(result.valid).toBe(true);
  });

  it('non-interactive init still writes config through the shared setup path', async () => {
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
                '--provider', 'ollama',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'true',
      ],
      {
        stdout: () => undefined,
        stderr: () => undefined,
        input: async () => {
          throw new Error('prompt should not be called');
        },
      },
    );

    expect(code).toBe(0);
    expect(fs.existsSync(configPath)).toBe(true);

    // S1 change (old -> new): the workspace used to be whatever `--workspace` said. It is now
    // DERIVED from the state root plus the owner id, so a retired `--workspace` value can no longer
    // silently become the serving workspace.
    const config = await loadRuntimeConfig({ configPath });
    expect(config.memory.workspace).toBe(fixtureOwner(path.dirname(configPath)).workspace);
    expect(config.channels.telegram.enabled).toBe(false);
    expect(config.heartbeat.timezone).toBe('Asia/Kolkata');
    expect(config.heartbeat.enabled).toBe(true);
  });

  it('refuses to overwrite an existing config during non-interactive init without force', async () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"existing":true}\n', 'utf8');
    const output: string[] = [];

    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
                '--provider', 'ollama',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'true',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => {
          throw new Error('prompt should not be called');
        },
      },
    );

    expect(code).toBe(1);
    // S1 change (old -> new): this used to point the operator at `--force`. There is no overwrite
    // path any more, so the refusal names the real remedy — a fresh target.
    expect(output.join('')).toContain('already exists');
    expect(output.join('')).toContain('never overwrites');
    expect(output.join('')).toContain('--state-root');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{"existing":true}\n');
  });

  it('refuses the retired --force flag with guidance instead of overwriting', async () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"existing":true}\n', 'utf8');

    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--force',
        '--config', configPath,
        '--provider', 'ollama',
        '--telegram-enabled', 'false',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => {
          throw new Error('prompt should not be called');
        },
      },
    );

    // S1 change (old -> new): this test asserted `--force` OVERWROTE an existing config. Setup is
    // now additive only — there is no overwrite, no resume and no unsolicited wipe.
    expect(code).toBe(1);
    expect(output.join('')).toContain('--force is retired');
    expect(output.join('')).toContain('never removed');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{"existing":true}\n');
  });

  it('refuses the retired --workspace flag instead of silently ignoring it', async () => {
    const output: string[] = [];
    const code = await runServiceOnboarding(
      ['--yes', '--config', configPath, '--workspace', workspacePath, '--provider', 'ollama'],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => {
          throw new Error('prompt should not be called');
        },
      },
    );

    // S1 change (old -> new): `--workspace` used to be accepted and then overridden by the derived
    // owner path. An old invocation now fails loudly rather than quietly writing somewhere else.
    expect(code).toBe(1);
    expect(output.join('')).toContain('--workspace is retired');
    expect(output.join('')).toContain('--state-root');
    expect(fs.existsSync(configPath)).toBe(false);
  });
  it('fails clearly for OpenAI provider without an API key', async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const output: string[] = [];
      const code = await runServiceOnboarding(
        [
          '--yes',
          '--config', configPath,
                    '--provider', 'openai',
          '--telegram-enabled', 'false',
          '--timezone', 'Asia/Kolkata',
          '--heartbeats-enabled', 'false',
        ],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      expect(code).toBe(1);
      expect(output.join('')).toContain('OPENAI_API_KEY');
      expect(fs.existsSync(configPath)).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = original;
      }
    }
  });

  it('writes OpenAI defaults without leaking Ollama baseUrl when API key is provided', async () => {
    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
                '--provider', 'openai',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'false',
        '--api-key', 'sk-test-secret',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      },
    );

    expect(code).toBe(0);
    expect(output.join('')).not.toContain('sk-test-secret');
    const config = await loadRuntimeConfig({ configPath });
    expect(config.providers.main.type).toBe('openai');
    expect(config.providers.main.model).toBe('gpt-4o-mini');
    expect(config.providers.main.apiKey).toBe('sk-test-secret');
    expect(config.providers.main.baseUrl).toBeUndefined();
    // forka #11: medical defaults to on-device Ollama medgemma even when main is
    // cloud, so it has an Ollama baseUrl (not undefined).
    expect(config.providers.medical.type).toBe('ollama');
    expect(config.providers.medical.baseUrl).toBe('http://localhost:11434/v1');
    // ASSERTION MIGRATION (R05). The protected intent of this case was "no Ollama baseUrl leaks
    // into the CLOUD role". Line 408 above still asserts that, on the role that is actually cloud.
    // The old `embeddings.baseUrl === undefined` assertion only held because embeddings had been
    // dragged onto the cloud provider; embeddings is a LOCAL role again, so it legitimately carries
    // the local endpoint. What replaces it asserts the real invariant on the embedding role.
    expect(config.providers.embeddings).toEqual({
      type: 'ollama',
      model: 'embeddinggemma:latest',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(config.providers.embeddings.apiKey).toBeUndefined();
  });

  it('medical defaults to on-device medgemma even when main is OpenAI (forka #11)', () => {
    const config = buildConfigFromArgs({ provider: 'openai', apiKey: 'sk-x', configPath: '/tmp/forka11/config.json' });
    expect(config.providers.main.type).toBe('openai');
    expect(config.providers.medical).toEqual({
      type: 'ollama',
      model: 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest',
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('opt-out: --medical-provider routes the medical model to the cloud (forka #11)', () => {
    const config = buildConfigFromArgs({
      provider: 'openai',
      apiKey: 'sk-x',
      medicalProvider: 'openai',
      medicalModel: 'gpt-4o',
      configPath: '/tmp/forka11b/config.json',
    });
    expect(config.providers.medical.type).toBe('openai');
    expect(config.providers.medical.model).toBe('gpt-4o');
    expect(config.providers.medical.apiKey).toBe('sk-x');
  });

  it('uses cloud defaults for anthropic and google but medical stays on-device medgemma (forka #11)', () => {
    const medgemma = 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest';
    expect(modelDefaultsForProvider('anthropic')).toEqual({
      main: 'gpt-4o-mini',
      medical: medgemma,
      embeddings: 'text-embedding-3-small',
    });
    expect(modelDefaultsForProvider('google')).toEqual({
      main: 'gpt-4o-mini',
      medical: medgemma,
      embeddings: 'text-embedding-3-small',
    });
  });

  it('offers openrouter as a supported onboarding provider', () => {
    expect(SUPPORTED_ONBOARDING_PROVIDERS).toContain('openrouter');
  });

  it('defaults openrouter onboarding to stealth/ox-alpha at low reasoning effort', () => {
    const medgemma = 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest';
    expect(modelDefaultsForProvider('openrouter')).toEqual({
      main: 'stealth/ox-alpha',
      medical: medgemma,
      embeddings: 'openai/text-embedding-3-small',
    });
  });

  // ASSERTION MIGRATION (R05, brief §8B / §11). The old assertion here was:
  //     expect(config.providers.embeddings).toEqual({ type: 'openrouter', …, baseUrl: <router>, apiKey: 'or-x' });
  // That encoded the R05 defect itself — "cloud main silently selects cloud embeddings" — so it
  // cannot be preserved as-is; the locked outcome now requires local Ollama embeddings unless an
  // embedding role is selected explicitly. Everything else this case protected is kept verbatim:
  // routed main, `reasoningEffort: 'low'`, no reasoningEffort on embeddings (a chat-completion
  // concern), and on-device medical.
  it('builds an OpenRouter config: routed main, LOCAL embeddings, on-device medical', () => {
    const config = buildConfigFromArgs({
      provider: 'openrouter',
      apiKey: 'or-x',
      configPath: '/tmp/openrouter-onboard/config.json',
    });
    expect(config.providers.main).toEqual({
      type: 'openrouter',
      model: 'stealth/ox-alpha',
      baseUrl: 'https://openrouter.ai/api/v1',
      reasoningEffort: 'low',
      apiKey: 'or-x',
    });
    // R05: main=cloud must NOT move embeddings to cloud. The default embedding role is the
    // existing local Ollama default, and `--api-key` must not be copied into it.
    // No reasoningEffort here: it is a chat-completion concern, embeddings ignore it.
    expect(config.providers.embeddings).toEqual({
      type: 'ollama',
      model: 'embeddinggemma:latest',
      baseUrl: 'http://localhost:11434/v1',
    });
    // Medical resolves INDEPENDENTLY and defaults to on-device medgemma (#11).
    expect(config.providers.medical).toEqual({
      type: 'ollama',
      model: 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest',
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('rejects unsupported onboarding provider choices clearly', async () => {
    const output: string[] = [];

    const code = await runServiceOnboarding(
      ['--yes', '--config', configPath, '--provider', 'anthropic'],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
      },
    );

    expect(code).toBe(1);
    expect(output.join('')).toContain('Unsupported onboard provider');
    expect(output.join('')).toContain('ollama, openai');
  });

  // ── R04: a supported cloud endpoint must SURVIVE setup and reload ────────────────────────────
  //
  // RED-first finding SOL-01: OpenRouter setup constructs the endpoint its installed adapter
  // requires (`OPENROUTER_DEFAULT_BASE_URL`), but the shared decoder refused ANY baseUrl on a
  // non-ollama role, so supported setup always failed with `invalid-url` and wrote no config.
  //
  // These go through the real entry point, the real lease-owning writer and the real loader. A
  // unit assertion on `checkProviderBaseUrl` would not prove the saved document reloads.
  it('saves OpenRouter setup and reloads it through the real loader with the adapter endpoint', async () => {
    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'or-synthetic-environment-key';
    try {
      const output: string[] = [];
      const code = await runServiceOnboarding(
        [
          '--yes',
          '--config', configPath,
          '--provider', 'openrouter',
          '--main-model', 'stealth/ox-alpha',
          '--embedding-provider', 'ollama',
          '--embedding-model', 'embeddinggemma:latest',
          '--telegram-enabled', 'false',
          '--timezone', 'Asia/Kolkata',
          '--heartbeats-enabled', 'false',
        ],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      // The whole point of R04: supported setup must COMMIT, not refuse its own endpoint.
      expect(output.join('')).not.toContain('invalid-url');
      expect(code).toBe(0);
      expect(fs.existsSync(configPath)).toBe(true);

      // The persisted document must be schema-2 and carry the adapter's endpoint...
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        schemaVersion: number;
        providers: { main: { type: string; baseUrl: string; reasoningEffort?: string } };
      };
      expect(persisted.schemaVersion).toBe(2);
      expect(persisted.providers.main.type).toBe('openrouter');
      expect(persisted.providers.main.baseUrl).toBe('https://openrouter.ai/api/v1');

      // ...and the real loader must accept the bytes that setup just wrote.
      const reloaded = await loadRuntimeConfig({ configPath });
      expect(reloaded.providers.main.type).toBe('openrouter');
      expect(reloaded.providers.main.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(reloaded.providers.main.model).toBe('stealth/ox-alpha');
      expect(reloaded.providers.medical.type).toBe('ollama');
      // The environment key is used for the role; nothing is printed.
      expect(output.join('')).not.toContain('or-synthetic-environment-key');
    } finally {
      if (original === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = original;
      }
    }
  });

  it('still saves ordinary OpenAI and Ollama setup with no cloud base URL inherited', async () => {
    // R04 keeps the two paths that already worked working: "ordinary OpenAI and Ollama setup still
    // work" (brief §8A). OpenAI must not gain a baseUrl just because the rule was relaxed.
    const openaiOutput: string[] = [];
    const openaiCode = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
        '--provider', 'openai',
        '--api-key', 'sk-openai-synthetic',
        '--embedding-provider', 'ollama',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'false',
      ],
      {
        stdout: (text: string) => openaiOutput.push(text),
        stderr: (text: string) => openaiOutput.push(text),
        input: async () => '',
      },
    );

    expect(openaiOutput.join('')).not.toContain('invalid-url');
    expect(openaiCode).toBe(0);
    const openai = await loadRuntimeConfig({ configPath });
    expect(openai.providers.main.type).toBe('openai');
    expect(openai.providers.main.baseUrl).toBeUndefined();

    // A SEPARATE directory: setup refuses a non-empty owner workspace, and both configs would
    // otherwise derive the same state root from their shared parent. That refusal is correct
    // behavior and would make this assertion prove nothing about endpoints.
    const ollamaStateRoot = path.join(tmpDir, 'ollama-install');
    const ollamaConfigPath = path.join(ollamaStateRoot, 'config.json');
    const ollamaOutput: string[] = [];
    const ollamaCode = await runServiceOnboarding(
      [
        '--yes',
        '--config', ollamaConfigPath,
        '--provider', 'ollama',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'false',
      ],
      {
        stdout: (text: string) => ollamaOutput.push(text),
        stderr: (text: string) => ollamaOutput.push(text),
        input: async () => '',
      },
    );

    expect(ollamaCode).toBe(0);
    const ollama = await loadRuntimeConfig({ configPath: ollamaConfigPath });
    expect(ollama.providers.main.type).toBe('ollama');
    expect(ollama.providers.main.baseUrl).toBe('http://localhost:11434/v1');
  });

  // ── R05: embeddings are an independent selection in BOTH entry modes ─────────────────────────
  //
  // RED-first finding SOL-02: cloud main silently selected cloud embeddings, and there was no
  // `--embedding-provider` / `--embedding-url` / `--embedding-api-key` at all — `--embedding-provider
  // ollama` was silently IGNORED while its `--embedding-model` was accepted under the cloud
  // provider (SOL-02, verbatim from the original acceptance ledger).
  it('keeps local Ollama embeddings when only --provider openai is given', async () => {
    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
        '--provider', 'openai',
        '--api-key', 'sk-main-role-only',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'false',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      },
    );

    expect(code).toBe(0);
    const config = await loadRuntimeConfig({ configPath });
    // Main is cloud…
    expect(config.providers.main.type).toBe('openai');
    expect(config.providers.main.apiKey).toBe('sk-main-role-only');
    // …and embeddings kept the existing LOCAL default, including its own model and local URL.
    // This is the core R05 assertion: it fails on the coupled mechanism, not on a helper.
    expect(config.providers.embeddings).toEqual({
      type: 'ollama',
      model: 'embeddinggemma:latest',
      baseUrl: 'http://localhost:11434/v1',
    });
    // The main role's key must NOT be copied into the embedding role.
    expect(config.providers.embeddings.apiKey).toBeUndefined();
  });

  it('honours an explicit local embedding provider and model without a main-role change', async () => {
    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
        '--provider', 'openai',
        '--api-key', 'sk-main-role-only',
        '--embedding-provider', 'ollama',
        '--embedding-model', 'nomic-embed-text:latest',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'false',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      },
    );

    expect(code).toBe(0);
    const config = await loadRuntimeConfig({ configPath });
    // `--embedding-model` changes the LOCAL embedding model, not its provider.
    expect(config.providers.embeddings).toEqual({
      type: 'ollama',
      model: 'nomic-embed-text:latest',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(config.providers.main.model).toBe('gpt-4o-mini');
  });

  it('saves an explicit cloud embedding role with its own endpoint and key, independent of main', async () => {
    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
        '--provider', 'openai',
        '--api-key', 'sk-main-role-only',
        '--embedding-provider', 'openai',
        '--embedding-model', 'text-embedding-3-small',
        '--embedding-url', 'https://proxy.internal.example/v1',
        '--embedding-api-key', 'sk-embedding-role-only',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'false',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      },
    );

    expect(code).toBe(0);
    const config = await loadRuntimeConfig({ configPath });

    // Each role keeps its OWN endpoint and key. `--api-key` is not reused for embeddings, and the
    // embedding endpoint is not the main endpoint.
    expect(config.providers.main).toMatchObject({ type: 'openai', apiKey: 'sk-main-role-only' });
    expect(config.providers.main.baseUrl).toBeUndefined();
    expect(config.providers.embeddings).toEqual({
      type: 'openai',
      model: 'text-embedding-3-small',
      baseUrl: 'https://proxy.internal.example/v1',
      apiKey: 'sk-embedding-role-only',
    });
    // Neither synthetic secret may appear in operator output.
    expect(output.join('')).not.toContain('sk-main-role-only');
    expect(output.join('')).not.toContain('sk-embedding-role-only');
  });

  it('keeps --ollama-url as the LOCAL role control and never lets it override a cloud main endpoint', async () => {
    const cloudConfigPath = path.join(tmpDir, 'cloud-install', 'config.json');
    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', cloudConfigPath,
        '--provider', 'openai',
        '--api-key', 'sk-main-role-only',
        // A local Ollama URL supplied for the medical/local roles…
        '--ollama-url', 'http://127.0.0.1:11434/v1',
        // …with embeddings explicitly left on the local default.
        '--embedding-provider', 'ollama',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'false',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      },
    );

    expect(code).toBe(0);
    const config = await loadRuntimeConfig({ configPath: cloudConfigPath });
    // `--ollama-url` must NOT have become the cloud main endpoint.
    expect(config.providers.main.baseUrl).toBeUndefined();
    expect(config.providers.main.type).toBe('openai');
    // Local roles use it.
    expect(config.providers.embeddings.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(config.providers.medical.baseUrl).toBe('http://127.0.0.1:11434/v1');
  });

  it('lets an explicit --embedding-url win over the local Ollama URL for the embedding role only', async () => {
    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
        '--provider', 'ollama',
        '--ollama-url', 'http://127.0.0.1:11434/v1',
        '--embedding-provider', 'openai',
        '--embedding-url', 'https://embeddings.internal.example/v1',
        '--embedding-api-key', 'sk-embedding-role-only',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'false',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      },
    );

    expect(code).toBe(0);
    const config = await loadRuntimeConfig({ configPath });
    // Main and medical keep the LOCAL endpoint; only embeddings moved.
    expect(config.providers.main.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(config.providers.medical.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(config.providers.embeddings).toMatchObject({
      type: 'openai',
      baseUrl: 'https://embeddings.internal.example/v1',
      model: 'text-embedding-3-small',
    });
  });

  it('refuses a cloud embedding role with no key of its own, before any write', async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const originalRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const output: string[] = [];
      const code = await runServiceOnboarding(
        [
          '--yes',
          '--config', configPath,
          '--provider', 'openai',
          '--api-key', 'sk-main-role-only',
          '--embedding-provider', 'openai',
          '--telegram-enabled', 'false',
          '--timezone', 'Asia/Kolkata',
          '--heartbeats-enabled', 'false',
        ],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      // A required missing embedding cloud key must refuse, and must not silently reuse the main key.
      expect(code).toBe(1);
      expect(output.join('')).toContain('OPENAI_API_KEY');
      expect(output.join('')).toContain('--embedding-api-key');
      expect(fs.existsSync(configPath)).toBe(false);
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
      if (originalRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalRouter;
    }
  });

  it('accepts the embedding cloud role key from that provider environment variable alone', async () => {
    const originalMain = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-main-env';
    const originalRouter = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'or-embedding-env';
    try {
      const output: string[] = [];
      const code = await runServiceOnboarding(
        [
          '--yes',
          '--config', configPath,
          '--provider', 'openai',
          '--embedding-provider', 'openrouter',
          '--embedding-url', 'https://openrouter.ai/api/v1',
          '--telegram-enabled', 'false',
          '--timezone', 'Asia/Kolkata',
          '--heartbeats-enabled', 'false',
        ],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      expect(code).toBe(0);
      const config = await loadRuntimeConfig({ configPath });
      // The embedding role resolved its OWN provider's env var — no cross-role key copying.
      expect(config.providers.embeddings.type).toBe('openrouter');
      expect(config.providers.main.apiKey).toBeUndefined();
      expect(output.join('')).not.toContain('or-embedding-env');
      expect(output.join('')).not.toContain('sk-main-env');
    } finally {
      if (originalMain === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalMain;
      if (originalRouter === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalRouter;
    }
  });

  it('warns about remote embeddings on the NON-interactive path too', async () => {
    // Cold-review finding 3. specs/13 amendment B1 requires an honest warning for remote embeddings,
    // and R05 requires the embedding selection to work "in both entry modes". The warning used to
    // exist only in the wizard, so `--yes --embedding-provider openrouter` committed a
    // remote-embedding install with no latency/privacy statement at all.
    const original = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'or-embedding-env-key';
    try {
      const output: string[] = [];
      const code = await runServiceOnboarding(
        [
          '--yes',
          '--config', configPath,
          '--provider', 'openai',
          '--api-key', 'sk-main-role-only',
          '--embedding-provider', 'openrouter',
          '--telegram-enabled', 'false',
          '--timezone', 'Asia/Kolkata',
          '--heartbeats-enabled', 'false',
        ],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      expect(code).toBe(0);
      const printed = output.join('');
      // The honest statement, not just a provider name.
      expect(printed).toContain('embeddings are remote');
      expect(printed).toContain('p50<=300ms');
      // Configured is not verified-ready.
      expect(printed).toContain('configured, not verified');
      expect(printed).not.toContain('or-embedding-env-key');
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = original;
    }
  });

  it('does not warn about remote embeddings when the embedding role is local', async () => {
    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
        '--provider', 'ollama',
        '--embedding-provider', 'ollama',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'false',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      },
    );

    expect(code).toBe(0);
    // A false warning on the default local role would train operators to ignore it.
    expect(output.join('')).not.toContain('embeddings are remote');
  });

  it('never prints credentials embedded in a configured endpoint URL', async () => {
    // Cold-review observation. A base URL may carry `user:password@` userinfo, which is a secret.
    // `redactConfig` masks the apiKey/botToken KEYS but has no idea a URL string can hold one, so
    // the endpoint lines added for R05 had to be made safe themselves.
    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
        '--provider', 'ollama',
        '--embedding-provider', 'openai',
        '--embedding-url', 'https://url-user:url-password@embeddings.internal.example/v1',
        '--embedding-api-key', 'sk-embedding-role-only',
        '--telegram-enabled', 'false',
        '--timezone', 'Asia/Kolkata',
        '--heartbeats-enabled', 'false',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      },
    );

    expect(code).toBe(0);
    const printed = output.join('');
    expect(printed).not.toContain('url-user');
    expect(printed).not.toContain('url-password');
    // The endpoint is still identifiable.
    expect(printed).toContain('embeddings.internal.example');
  });

  // ASSERTION MIGRATION (C04-P01, follow-up brief §8A). The old assertion here was:
  //     expect(output.join('')).toContain('anthropic');
  // That required the refusal to PRINT the rejected value, which is exactly the C04-P01 disclosure
  // the locked contract forbids (`plans/15:92` "field/reason errors (never input values)"). It could
  // not be preserved as-is.
  //
  // old -> new, and what each old fragment actually protected:
  //   `code === 1`            -> UNCHANGED. The refusal stays controlled and nonzero.
  //   `toContain('embedding')`-> UNCHANGED. The operator still learns the EMBEDDING role was rejected.
  //   `toContain('anthropic')`-> REPLACED by the two things that make the refusal useful without the
  //                              value: the option that must change (`--embedding-provider`) and the
  //                              supported set (`ollama, openai, openrouter`). Plus a new assertion
  //                              that the rejected value is NOT printed, and a prompt count of zero.
  //   `existsSync(configPath)`-> UNCHANGED, and strengthened into the file-inventory form below.
  it('refuses an unsupported embedding provider selection without writing', async () => {
    const output: string[] = [];
    let prompts = 0;
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
        '--provider', 'ollama',
        '--embedding-provider', 'anthropic',
        '--telegram-enabled', 'false',
      ],
      {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async (): Promise<string> => {
          prompts += 1;
          return '';
        },
      },
    );

    expect(code).toBe(1);
    expect(output.join('')).toContain('embedding');
    // Useful guidance replaces the value echo: which option to change, and the accepted set.
    expect(output.join('')).toContain('--embedding-provider');
    expect(output.join('')).toContain('ollama, openai, openrouter');
    // The rejected value itself is never printed.
    expect(output.join('')).not.toContain('anthropic');
    expect(prompts).toBe(0);
    // Nothing was committed: no config document, and no owner record, workspace or derived store.
    // (The surrounding temp root itself pre-exists — `beforeEach` created it — so asserting the
    // directory is absent would test the fixture, not the product.)
    const owner = fixtureOwner(path.dirname(configPath));
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(owner.ownerRecord)).toBe(false);
    expect(fs.existsSync(owner.workspace)).toBe(false);
    expect(fs.existsSync(owner.storePath)).toBe(false);
  });

  it('uses OpenAI defaults for interactive init when model prompts are accepted', async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const output: string[] = [];
      // S1 change (old -> new): the wizard's workspace prompt became a state-root prompt plus an
      // owner-id prompt, because every owner path is now derived from that pair. The answer stream
      // gains the owner id and the former workspace path becomes the state root.
      // C04 change (old -> new): R05 added a separate EMBEDDING step between the provider step and
      // Telegram. Its provider choice and local URL are answered here; every earlier answer keeps
      // its original meaning, so each pre-existing assertion below still protects what it protected.
      const answers = [
        path.dirname(configPath),      // 1 owner state root
        'default',                     // 2 owner id
        'openai',                      // 3 main provider type
        'sk-interactive-secret',       // 4 main API key
        '',                            // 5 main model (default)
        '',                            // 6 medical model (default)
        'ollama',                      // 7 embedding provider (independent role)
        '',                            // 8 local embedding URL (default)
        '',                            // 9 embedding model (default)
        'n',                           // 10 enable Telegram
        'Asia/Kolkata',                // 11 timezone
        'n',                           // 12 enable heartbeats
        '1',                           // 13 review action: apply
        '3',                           // 14 completion action: exit
      ];
      const prompts: string[] = [];
      const code = await runServiceOnboarding(['--config', configPath], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async (prompt: string) => {
          prompts.push(prompt);
          return answers.shift() ?? '';
        },
      });

      expect(code).toBe(0);
      expect(prompts).toContain('• OpenAI API key\n  › ');
      expect(output.join('')).not.toContain('sk-interactive-secret');
      const config = await loadRuntimeConfig({ configPath });
      expect(config.providers.main).toEqual({
        type: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-interactive-secret',
      });
      // forka #11: medical defaults to on-device Ollama medgemma, NOT the cloud provider.
      expect(config.providers.medical).toEqual({
        type: 'ollama',
        model: 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest',
        baseUrl: 'http://localhost:11434/v1',
      });
      // ASSERTION MIGRATION (R05). The old expectation was embeddings == {type:'openai',
      // apiKey:'sk-interactive-secret'}: the interactive path silently moved embeddings to the
      // cloud chat provider AND copied the main key into the embedding role. Both were the R05
      // defect. The operator chose the local embedding role in the stream above, and what is now
      // asserted is that choice surviving resolution, build, write and reload.
      expect(config.providers.embeddings).toEqual({
        type: 'ollama',
        model: 'embeddinggemma:latest',
        baseUrl: 'http://localhost:11434/v1',
      });
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = original;
      }
    }
  });

  it('preserves a prefilled API key when Enter is pressed during interactive cloud setup', async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const output: string[] = [];
      const answers = [
        path.dirname(configPath),      // 1 owner state root
        'default',                     // 2 owner id
        '',                            // 3 main provider type (prefilled openai)
        '',                            // 4 main API key (prefilled secret preserved on Enter)
        '',                            // 5 main model
        '',                            // 6 medical model
        'ollama',                      // 7 embedding provider (independent role)
        '',                            // 8 local embedding URL
        '',                            // 9 embedding model
        'n',                           // 10 enable Telegram
        '',                            // 11 timezone
        '',                            // 12 enable heartbeats
        '1',                           // 13 review action: apply
        '3',                           // 14 completion action: exit
      ];

      const code = await runServiceOnboarding(
        [
          '--config', configPath,
          '--provider', 'openai',
          '--api-key', 'sk-prefilled-secret',
          '--telegram-enabled', 'false',
          '--timezone', 'Asia/Kolkata',
          '--heartbeats-enabled', 'true',
        ],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => answers.shift() ?? '',
        },
      );

      expect(code).toBe(0);
      expect(output.join('')).not.toContain('sk-prefilled-secret');

      const config = await loadRuntimeConfig({ configPath });
      expect(config.providers.main).toEqual({
        type: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-prefilled-secret',
      });
      // forka #11: medical defaults to on-device Ollama medgemma, NOT the cloud provider.
      expect(config.providers.medical).toEqual({
        type: 'ollama',
        model: 'aadide/medgemma-1.5-4b-it-Q4_K_S:latest',
        baseUrl: 'http://localhost:11434/v1',
      });
      // ASSERTION MIGRATION (R05), same defect and same reason as the case above: embeddings
      // followed the cloud chat provider and inherited its key. The prefilled-key assertion above
      // still protects what it was written for — that the MAIN role key survives Enter.
      expect(config.providers.embeddings).toEqual({
        type: 'ollama',
        model: 'embeddinggemma:latest',
        baseUrl: 'http://localhost:11434/v1',
      });
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = original;
      }
    }
  });

  it('returns a structured failure when daemon spawn throws synchronously', async () => {
    const result = await startDaemon(
      configPath,
      {},
      {
        projectRoot: '/repo',
        existsSync: () => false,
        spawnProcess: () => {
          throw new Error('spawn sync failed');
        },
        startupWindowMs: 1,
      },
    );

    expect(result).toEqual({
      started: false,
      message: 'Failed to start MedClaw: spawn sync failed',
    });
  });
});
