import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCli } from '../../src/cli/index';
import { SessionManager } from '../../src/gateway/session';
import { writeConfigFixture } from '../helpers/config-fixture';
import { makeTestTemp } from '../helpers/test-temp';

function createTempHome(): { tmpDir: string; restore: () => void } {
  const tmpDir = makeTestTemp('redacted-cli-home-');
  const originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  return {
    tmpDir,
    restore: () => {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('cli router', () => {
  it('keeps per-chat session archives isolated by chat id', async () => {
    const sessionsDir = makeTestTemp('redacted-cli-sessions-');
    try {
      const sessions = new SessionManager({ sessionsPath: sessionsDir, perChatArchive: true });
      await sessions.recordTurn('chat-a', [{ role: 'user', content: 'private A' }]);
      await sessions.recordTurn('chat-b', [{ role: 'user', content: 'private B' }]);

      const day = `${new Date().toISOString().slice(0, 10)}.jsonl`;
      expect(fs.existsSync(path.join(sessionsDir, 'chat-a', day))).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, 'chat-b', day))).toBe(true);
      expect(sessions.getHistory('chat-a').map((m) => m.content)).toEqual(['private A']);
      expect(sessions.getHistory('chat-b').map((m) => m.content)).toEqual(['private B']);
    } finally {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it('prints help and exits cleanly', async () => {
    const output: string[] = [];
    const code = await runCli(['--help'], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => '',
    });

    expect(code).toBe(0);
    expect(output.join('')).toContain('init');
    expect(output.join('')).toContain('config set');
    expect(output.join('')).toContain('heartbeats list');
  });

  it('rejects unknown commands with a useful error', async () => {
    const output: string[] = [];
    const code = await runCli(['bogus'], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => '',
    });

    expect(code).toBe(1);
    expect(output.join('')).toContain('Unknown command');
    expect(output.join('')).toContain('bogus');
  });

  it('routes config show through the admin surface', async () => {
    const home = createTempHome();
    try {
      const fixture = writeConfigFixture(home.tmpDir, {
        telegramEnabled: true,
        telegramToken: '123:secret-token',
        providerType: 'openai',
        apply: (stored) => {
          stored.providers.main.apiKey = 'sk-secret';
        },
      });
      const configPath = fixture.configPath;

      const output: string[] = [];
      const code = await runCli(['--config', configPath, 'config', 'show'], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      });

      expect(code).toBe(0);
      expect(output.join('')).toContain('[REDACTED]');
      expect(output.join('')).not.toContain('sk-secret');
      expect(output.join('')).not.toContain('secret-token');
    } finally {
      home.restore();
    }
  });

  it('never prints endpoint credentials in status output', async () => {
    const home = createTempHome();
    try {
      const fixture = writeConfigFixture(home.tmpDir, {
        apply: (stored) => {
          stored.providers.main.baseUrl = 'https://url-user:url-password@proxy.example/v1';
        },
      });
      const output: string[] = [];
      const code = await runCli(['--config', fixture.configPath, 'status'], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      });

      expect(code).toBe(0);
      const printed = output.join('');
      expect(printed).not.toContain('url-user');
      expect(printed).not.toContain('url-password');
      expect(printed).toContain('proxy.example');
    } finally {
      home.restore();
    }
  });

  it.each([
    ['config with an option-shaped subcommand', ['config', '--api-key=sk-config-sub-secret']],
    ['config set with an option-shaped path', ['config', 'set', '--api-key=sk-config-set-secret', 'x']],
    ['config set with a single-dash path', ['config', 'set', '-sk-single-set-secret', 'x']],
  ])('never echoes a secret-shaped token from %s', async (_label, argv) => {
    const home = createTempHome();
    try {
      const fixture = writeConfigFixture(home.tmpDir, {});
      const output: string[] = [];
      const code = await runCli(['--config', fixture.configPath, ...argv], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      });

      expect(code).toBe(1);
      expect(output.join('')).not.toContain('sk-config-sub-secret');
      expect(output.join('')).not.toContain('sk-config-set-secret');
      expect(output.join('')).not.toContain('sk-single-set-secret');
    } finally {
      home.restore();
    }
  });

  it('routes heartbeats list through the admin surface', async () => {
    const home = createTempHome();
    try {
      const fixture = writeConfigFixture(home.tmpDir, {});
      const configPath = fixture.configPath;
      const output: string[] = [];
      const code = await runCli(['--config', configPath, 'heartbeats', 'list'], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      });

      expect(code).toBe(0);
      expect(output.join('')).toContain('No heartbeat jobs configured');
    } finally {
      home.restore();
    }
  });

  it('real CLI onboard shows staged wizard output instead of the old flat prompt chain', () => {
    const home = createTempHome();
    try {
      const configPath = path.join(home.tmpDir, 'config.json');
      const stateRoot = path.join(home.tmpDir, 'state');
      const input = [
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
      ].join('\n');

      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/cli/index.ts', 'onboard', '--config', configPath],
        {
          cwd: path.join(__dirname, '..', '..'),
          env: { ...process.env, HOME: home.tmpDir },
          input,
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('MedClaw');
      expect(result.stdout).toContain('Personal AI Health Assistant');
      expect(result.stdout).toContain('[1/5]');
      expect(result.stdout).toContain('Setup complete');
      expect(fs.existsSync(configPath)).toBe(true);
    } finally {
      home.restore();
    }
  });

  it('real CLI onboard fails fast (no hang) when piped input runs out of answers', () => {
    const home = createTempHome();
    try {
      const configPath = path.join(home.tmpDir, 'config.json');
      const stateRoot = path.join(home.tmpDir, 'state');
      const input = [stateRoot, 'default', 'ollama'].join('\n');

      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/cli/index.ts', 'onboard', '--config', configPath],
        {
          cwd: path.join(__dirname, '..', '..'),
          env: { ...process.env, HOME: home.tmpDir },
          input,
          encoding: 'utf8',
          timeout: 20_000,
        },
      );

      expect(result.signal).toBeNull(); // not killed by the timeout = no hang
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain('Piped input exhausted');
    } finally {
      home.restore();
    }
  });

  it('real CLI onboard can print the redacted config from the completion menu', () => {
    const home = createTempHome();
    try {
      const configPath = path.join(home.tmpDir, 'config.json');
      const stateRoot = path.join(home.tmpDir, 'state');
      const input = [
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
        '2',
        '3',
      ].join('\n');

      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/cli/index.ts', 'onboard', '--config', configPath],
        {
          cwd: path.join(__dirname, '..', '..'),
          env: { ...process.env, HOME: home.tmpDir },
          input,
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Configuration:');
      expect(result.stdout).toContain('telegram token: [REDACTED]');
      expect(result.stdout).not.toContain('123456:test-token');
    } finally {
      home.restore();
    }
  });
});
