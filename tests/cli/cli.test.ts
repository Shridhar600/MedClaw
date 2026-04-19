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

  it('real CLI init consumes scripted interactive stdin instead of blank defaults', () => {
    const home = createTempHome();
    try {
      const configPath = path.join(home.tmpDir, 'config.json');
      const workspacePath = path.join(home.tmpDir, 'workspace');
      const input = [
        workspacePath,
        'ollama',
        'llama3.1',
        'amsaravi/medgemma-4b-it:q8',
        'nomic-embed-text',
        'http://localhost:11434/v1',
        'n',
        'Asia/Kolkata',
        'y',
        '',
      ].join('\n');

      const result = spawnSync(
        'npx',
        ['tsx', 'src/cli/index.ts', 'init', '--config', configPath],
        {
          cwd: path.join(__dirname, '..', '..'),
          env: { ...process.env, HOME: home.tmpDir },
          input,
          encoding: 'utf8',
        },
      );

      expect(result.status).toBe(0);
      expect(fs.existsSync(configPath)).toBe(true);
      const raw = fs.readFileSync(configPath, 'utf8');
      expect(JSON.parse(raw).channels.telegram.enabled).toBe(false);
      expect(raw).toContain(workspacePath);
    } finally {
      home.restore();
    }
  });
});
