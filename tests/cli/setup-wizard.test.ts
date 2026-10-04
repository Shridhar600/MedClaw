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
    const answers = [
      stateRoot,
      'default',
      'ollama',
      '',
      '',
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

  it('shows readiness and validation summary during completion, not just review', async () => {
    const output: string[] = [];
    const answers = [
      stateRoot,
      'default',
      'ollama',
      '',
      '',
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
    const answers = [
      workspacePath,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '1',
      '3',
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
    const answers = [
      stateRoot,
      'default',
      'ollama',
      '',
      '',
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
    const answers = [
      stateRoot,
      'default',
      'ollama',
      '',
      '',
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
    const answers = [
      stateRoot,
      'default',
      'ollama',
      '',
      '',
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
    const answers = [
      nestedWorkspacePath,
      'default',
      'ollama',
      '',
      '',
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
