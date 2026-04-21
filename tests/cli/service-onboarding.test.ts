import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../../src/config/config';
import { validateConfig } from '../../src/config/validation';
import { runServiceOnboarding } from '../../src/cli/service-onboarding';

describe('service onboarding init', () => {
  let tmpDir: string;
  let workspacePath: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-cli-init-'));
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
        '--workspace', workspacePath,
        '--provider', 'ollama',
        '--main-model', 'llama3.1',
        '--medical-model', 'aadide/medgemma-1.5-4b-it-Q4_K_S',
        '--embedding-model', 'nomic-embed-text',
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

    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(workspacePath, 'SOUL.md'), 'utf8')).toBe('existing soul');
    expect(fs.existsSync(path.join(workspacePath, 'HEALTH_PROFILE.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'conditions'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'medications'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'reports'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'goals'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'sessions'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'heartbeats'))).toBe(true);
    expect(output.join('')).not.toContain('prompt should not be called');
  });

  it('fails when telegram is enabled without a token', async () => {
    const output: string[] = [];
    const code = await runServiceOnboarding(
      [
        '--yes',
        '--config', configPath,
        '--workspace', workspacePath,
        '--provider', 'ollama',
        '--main-model', 'llama3.1',
        '--medical-model', 'aadide/medgemma-1.5-4b-it-Q4_K_S',
        '--embedding-model', 'nomic-embed-text',
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
          '--workspace', workspacePath,
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
      expect((await loadConfig({ configPath, requireFile: true })).channels.telegram.botToken).toBe(
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
        '--workspace', workspacePath,
        '--provider', 'ollama',
        '--main-model', 'llama3.1',
        '--medical-model', 'aadide/medgemma-1.5-4b-it-Q4_K_S',
        '--embedding-model', 'nomic-embed-text',
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
    const config = await loadConfig({ configPath, requireFile: true });
    const result = validateConfig(config);

    expect(config.channels.telegram.enabled).toBe(false);
    expect(result.valid).toBe(true);
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
          '--workspace', workspacePath,
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
        '--workspace', workspacePath,
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
    const config = await loadConfig({ configPath, requireFile: true });
    expect(config.providers.main.type).toBe('openai');
    expect(config.providers.main.model).toBe('gpt-4o-mini');
    expect(config.providers.main.apiKey).toBe('sk-test-secret');
    expect(config.providers.main.baseUrl).toBeUndefined();
    expect(config.providers.medical.baseUrl).toBeUndefined();
    expect(config.providers.embeddings.baseUrl).toBeUndefined();
  });

  it('uses OpenAI defaults for interactive init when model prompts are accepted', async () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const output: string[] = [];
      const answers = [
        workspacePath,
        'openai',
        'sk-interactive-secret',
        '',
        '',
        '',
        'n',
        'Asia/Kolkata',
        'n',
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
      expect(prompts).toContain('OpenAI API key ');
      expect(output.join('')).not.toContain('sk-interactive-secret');
      const config = await loadConfig({ configPath, requireFile: true });
      expect(config.providers.main).toEqual({
        type: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-interactive-secret',
      });
      expect(config.providers.medical).toEqual({
        type: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-interactive-secret',
      });
      expect(config.providers.embeddings).toEqual({
        type: 'openai',
        model: 'text-embedding-3-small',
        apiKey: 'sk-interactive-secret',
      });
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = original;
      }
    }
  });
});
