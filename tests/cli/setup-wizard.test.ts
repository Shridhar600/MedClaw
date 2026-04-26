import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SpawnOptions } from 'child_process';
import { getDefaultConfig } from '../../src/config/config';
import { loadConfig } from '../../src/config/config';
import { maskSecret, renderStepHeader, renderStatus, renderWizardBanner } from '../../src/cli/wizard-render';
import { askChoice, askSecret, askValue } from '../../src/cli/wizard-prompts';
import {
  handleCompletionAction,
  resolveDaemonLaunchSpec,
  runServiceOnboarding,
} from '../../src/cli/service-onboarding';

describe('setup wizard', () => {
  let tmpDir: string;
  let workspacePath: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-setup-wizard-'));
    workspacePath = path.join(tmpDir, 'workspace');
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

    expect(output.join('')).toContain('medclaw onboard');
    expect(output.join('')).toContain('Guided setup for your local health agent');
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
      workspacePath,
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

    const config = await loadConfig({ configPath, requireFile: true });
    expect(config.channels.telegram.botToken).toBe('123456:test-token');
  });

  it('shows readiness and validation summary during completion, not just review', async () => {
    const output: string[] = [];
    const answers = [
      workspacePath,
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

    const config = await loadConfig({ configPath, requireFile: true });
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.telegram.botToken).toBe('123456:prefilled-token');
  });

  it('allows editing from review before persisting config', async () => {
    const output: string[] = [];
    const answers = [
      workspacePath,
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

    const config = await loadConfig({ configPath, requireFile: true });
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.telegram.botToken).toBe('123456:updated-token');
  });

  it('re-prompts immediately when telegram is enabled without a token', async () => {
    const output: string[] = [];
    const answers = [
      workspacePath,
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

    const config = await loadConfig({ configPath, requireFile: true });
    expect(config.channels.telegram.botToken).toBe('123456:retried-token');
  });

  it('can cancel from review without persisting config', async () => {
    const output: string[] = [];
    const answers = [
      workspacePath,
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

  it('prints the redacted config when review-config is selected from completion', async () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          main: { type: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-secret' },
        },
        channels: {
          telegram: { enabled: true, botToken: '123456:test-token' },
        },
      }),
      'utf8',
    );

    const output: string[] = [];
    const code = await handleCompletionAction('review-config', configPath, {
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
    const config = getDefaultConfig();
    config.memory.workspace = workspacePath;
    config.channels.telegram.enabled = false;
    config.heartbeat.enabled = true;
    config.providers.main = { type: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test' };
    config.providers.medical = { type: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test' };
    config.providers.embeddings = { type: 'openai', model: 'text-embedding-3-small', apiKey: 'sk-test' };
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');

    const code = await handleCompletionAction(
      'start',
      configPath,
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
    expect(spawnCalls[0].options.env?.REDACTED_CONFIG_PATH).toBe(configPath);
  });
});
