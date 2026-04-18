// tests/config/config.test.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from '../../src/config/config';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('returns defaults when no config file exists', async () => {
    const config = await loadConfig(path.join(tmpDir, 'nonexistent.json'));
    expect(config.agent.maxIterations).toBe(15);
    expect(config.agent.disclaimerEnabled).toBe(true);
    expect(config.providers.main.type).toBe('ollama');
    expect(config.memory.workspace).toContain('.redacted');
  });

  it('merges user config over defaults', async () => {
    const userConfig = {
      providers: {
        main: { type: 'openai', model: 'gpt-4o', apiKey: 'sk-test' }
      }
    };
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(userConfig));

    const config = await loadConfig(cfgPath);
    expect(config.providers.main.type).toBe('openai');
    expect(config.providers.main.model).toBe('gpt-4o');
    // Defaults preserved for unset fields
    expect(config.agent.maxIterations).toBe(15);
  });

  it('resolves ~ in workspace path', async () => {
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ memory: { workspace: '~/.redacted/workspace' } }));
    const config = await loadConfig(cfgPath);
    expect(config.memory.workspace).toContain(os.homedir());
    expect(config.memory.workspace).not.toContain('~');
  });

  it('provides a default heartbeat store path', async () => {
    const config = await loadConfig(path.join(tmpDir, 'nonexistent.json'));
    expect(config.heartbeat.storePath).toContain(path.join('.redacted', 'heartbeats', 'jobs.json'));
  });

  it('resolves ~ in heartbeat store path', async () => {
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ heartbeat: { storePath: '~/.redacted/custom-heartbeats.json' } }),
    );
    const config = await loadConfig(cfgPath);
    expect(config.heartbeat.storePath.startsWith(os.homedir())).toBe(true);
    expect(config.heartbeat.storePath).not.toContain('~');
  });
});
