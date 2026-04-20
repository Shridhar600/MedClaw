// tests/config/config.test.ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getDefaultConfig, loadConfig, saveConfig } from '../../src/config/config';
import { redactConfig, validateConfig } from '../../src/config/validation';

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

  it('fails with init guidance when config is required but missing', async () => {
    const cfgPath = path.join(tmpDir, 'missing.json');
    await expect(loadConfig({ configPath: cfgPath, requireFile: true })).rejects.toThrow(
      /run `npm run cli -- init`/i,
    );
  });

  it('returns isolated default config copies', () => {
    const first = getDefaultConfig();
    first.providers.main.model = 'mutated-model';

    const second = getDefaultConfig();
    expect(second.providers.main.model).toBe('llama3.1');
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

  it('atomically saves config as valid JSON and creates parent directories', async () => {
    const cfgPath = path.join(tmpDir, 'nested', 'config.json');
    const config = getDefaultConfig();
    config.channels.telegram.enabled = false;
    config.memory.workspace = path.join(tmpDir, 'workspace');

    await saveConfig(cfgPath, config);

    const raw = fs.readFileSync(cfgPath, 'utf8');
    expect(JSON.parse(raw).memory.workspace).toBe(path.join(tmpDir, 'workspace'));
    expect(fs.existsSync(`${cfgPath}.tmp`)).toBe(false);
  });

  it('redacts provider api keys and telegram tokens', () => {
    const config = getDefaultConfig();
    config.providers.main = { type: 'openai', model: 'gpt-4o', apiKey: 'sk-secret' };
    config.channels.telegram.botToken = '123456:secret-token';

    const redacted = redactConfig(config);

    expect(redacted.providers.main.apiKey).toBe('[REDACTED]');
    expect(redacted.channels.telegram.botToken).toBe('[REDACTED]');
    expect(JSON.stringify(redacted)).not.toContain('sk-secret');
    expect(JSON.stringify(redacted)).not.toContain('secret-token');
  });

  it('validates required provider and telegram fields', () => {
    const config = getDefaultConfig();
    config.channels.telegram.enabled = true;
    config.channels.telegram.botToken = '';
    config.providers.main.model = '';

    const result = validateConfig(config);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'providers.main.model is required',
        'channels.telegram.botToken is required when Telegram is enabled',
      ]),
    );
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

  it('provides heartbeat policy defaults', async () => {
    const config = await loadConfig(path.join(tmpDir, 'nonexistent.json'));
    expect(config.heartbeat.policy.quietHours.enabled).toBe(true);
    expect(config.heartbeat.policy.skipIfChatActiveWithinMinutes).toBe(60);
    expect(config.heartbeat.policy.defaults.morningCheckIn.enabled).toBe(true);
    expect(config.heartbeat.policy.defaults.eveningSummary.enabled).toBe(true);
  });

  it('provides heartbeat hardening defaults', async () => {
    const config = await loadConfig(path.join(tmpDir, 'nonexistent.json'));
    expect(config.heartbeat.recovery?.enabled).toBe(false);
    expect(config.heartbeat.recovery?.windowMinutes).toBe(60);
    expect(config.heartbeat.retry?.maxRetries).toBe(3);
    expect(config.heartbeat.retry?.backoffMinutes).toBe(5);
    expect(config.heartbeat.rateLimit?.maxGlobalTriggersPerMinute).toBe(10);
    expect(config.heartbeat.rateLimit?.maxPerChatTriggersPerMinute).toBe(3);
    expect(config.heartbeat.audit?.path).toContain(path.join('.redacted', 'heartbeats', 'audit.jsonl'));
  });

  it('allows overriding quiet hours and default routines', async () => {
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        heartbeat: {
          policy: {
            quietHours: { enabled: false, start: '23:00', end: '06:00' },
            skipIfChatActiveWithinMinutes: 15,
            defaults: {
              morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'unused' },
              eveningSummary: { enabled: true, cron: '0 21 * * *', prompt: 'Summarize the day.' },
            },
          },
        },
      }),
    );

    const config = await loadConfig(cfgPath);
    expect(config.heartbeat.policy.quietHours.enabled).toBe(false);
    expect(config.heartbeat.policy.quietHours.start).toBe('23:00');
    expect(config.heartbeat.policy.skipIfChatActiveWithinMinutes).toBe(15);
    expect(config.heartbeat.policy.defaults.morningCheckIn.enabled).toBe(false);
    expect(config.heartbeat.policy.defaults.eveningSummary.prompt).toBe('Summarize the day.');
  });

  it('allows overriding heartbeat hardening defaults', async () => {
    const cfgPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        heartbeat: {
          recovery: { enabled: true, windowMinutes: 180 },
          retry: { maxRetries: 7, backoffMinutes: 12 },
          rateLimit: { maxGlobalTriggersPerMinute: 4, maxPerChatTriggersPerMinute: 2 },
          audit: { path: '~/.redacted/custom-audit.jsonl' },
        },
      }),
    );

    const config = await loadConfig(cfgPath);
    expect(config.heartbeat.recovery?.enabled).toBe(true);
    expect(config.heartbeat.recovery?.windowMinutes).toBe(180);
    expect(config.heartbeat.retry?.maxRetries).toBe(7);
    expect(config.heartbeat.retry?.backoffMinutes).toBe(12);
    expect(config.heartbeat.rateLimit?.maxGlobalTriggersPerMinute).toBe(4);
    expect(config.heartbeat.rateLimit?.maxPerChatTriggersPerMinute).toBe(2);
    expect(config.heartbeat.audit?.path.startsWith(os.homedir())).toBe(true);
    expect(config.heartbeat.audit?.path).not.toContain('~');
  });
});
