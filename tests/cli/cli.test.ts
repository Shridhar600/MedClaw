import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runCli } from '../../src/cli/index';

function createTempHome(): { tmpDir: string; restore: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-cli-home-'));
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
      const configPath = path.join(home.tmpDir, 'config.json');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          providers: { main: { type: 'openai', model: 'gpt-4o', apiKey: 'sk-secret' } },
          channels: { telegram: { enabled: true, botToken: '123:secret-token' } },
        }),
      );

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

  it('routes heartbeats list through the admin surface', async () => {
    const home = createTempHome();
    try {
      const configPath = path.join(home.tmpDir, 'config.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          memory: { workspace: path.join(home.tmpDir, 'workspace') },
          heartbeat: { storePath: path.join(home.tmpDir, 'heartbeats', 'jobs.json') },
        }),
      );
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
      const workspacePath = path.join(home.tmpDir, 'workspace');
      const input = [
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
      const workspacePath = path.join(home.tmpDir, 'workspace');
      // Deliberately too few answers: the wizard must abort with a clear
      // error, not spin in a re-prompt loop (the old Node-26 hang).
      const input = [workspacePath, 'ollama'].join('\n');

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
      const workspacePath = path.join(home.tmpDir, 'workspace');
      const input = [
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
