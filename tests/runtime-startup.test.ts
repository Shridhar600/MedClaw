import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultRuntimeConfigPath, loadRuntimeConfig } from '../src/runtime/startup';

describe('runtime startup config resolution', () => {
  const originalConfigPath = process.env.REDACTED_CONFIG_PATH;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-runtime-startup-'));
    delete process.env.REDACTED_CONFIG_PATH;
  });

  afterEach(() => {
    if (originalConfigPath === undefined) {
      delete process.env.REDACTED_CONFIG_PATH;
    } else {
      process.env.REDACTED_CONFIG_PATH = originalConfigPath;
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the default config path when REDACTED_CONFIG_PATH is not set', async () => {
    const configPath = defaultRuntimeConfigPath(tmpDir);
    const workspacePath = path.join(tmpDir, 'workspace-from-default-config');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      memory: { workspace: workspacePath },
      channels: { telegram: { enabled: false, botToken: '' } },
      heartbeat: { enabled: false },
    }));

    const config = await loadRuntimeConfig({ homeDir: tmpDir });

    expect(config.memory.workspace).toBe(workspacePath);
    expect(config.channels.telegram.enabled).toBe(false);
    expect(config.heartbeat.enabled).toBe(false);
  });

  it('throws onboard guidance when the default config file is missing', async () => {
    await expect(loadRuntimeConfig({ homeDir: tmpDir })).rejects.toThrow(
      `Config file not found at ${path.join(tmpDir, '.redacted', 'config.json')}. Run \`npm run cli -- onboard\``,
    );
  });
});
