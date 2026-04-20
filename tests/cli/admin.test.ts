import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDefaultConfig, saveConfig } from '../../src/config/config';
import { HeartbeatStore } from '../../src/scheduler/store';
import {
  setConfigValue,
  showConfig,
  showProfile,
  showStatus,
  showUserSummary,
  listHeartbeats,
} from '../../src/cli/admin';

describe('cli admin surfaces', () => {
  let tmpDir: string;
  let workspacePath: string;
  let configPath: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-cli-admin-'));
    workspacePath = path.join(tmpDir, 'workspace');
    configPath = path.join(tmpDir, 'config.json');
    storePath = path.join(tmpDir, 'heartbeats', 'jobs.json');
    fs.mkdirSync(workspacePath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('redacts secrets in config output', async () => {
    const config = getDefaultConfig();
    config.providers.main.type = 'openai';
    config.providers.main.model = 'gpt-4o';
    config.providers.main.apiKey = 'sk-secret';
    config.channels.telegram.botToken = '123:secret-token';
    await saveConfig(configPath, config);

    const text = await showConfig({ configPath });

    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('secret-token');
  });

  it('updates nested config values and persists them', async () => {
    const config = getDefaultConfig();
    config.providers.main.type = 'openai';
    config.providers.main.model = 'gpt-4o';
    config.providers.main.apiKey = 'sk-secret';
    await saveConfig(configPath, config);

    await setConfigValue(configPath, 'providers.main.model', 'gpt-4.1');

    const raw = fs.readFileSync(configPath, 'utf8');
    expect(JSON.parse(raw).providers.main.model).toBe('gpt-4.1');
  });

  it('handles missing profile files gracefully', async () => {
    const text = await showProfile({ workspacePath });
    expect(text).toContain('No health profile found');
  });

  it('summarizes the user state from workspace files', async () => {
    fs.writeFileSync(path.join(workspacePath, 'USER.md'), '# User Preferences\n- **Timezone**: Asia/Kolkata\n', 'utf8');
    fs.writeFileSync(path.join(workspacePath, 'HEALTH_PROFILE.md'), '# Health Profile\n- **Age**: 34\n', 'utf8');

    const text = await showUserSummary({ workspacePath });

    expect(text).toContain('Asia/Kolkata');
    expect(text).toContain('Age: 34');
  });

  it('reports heartbeat jobs from durable storage', async () => {
    const store = new HeartbeatStore(storePath);
    await store.create({
      title: 'Morning check-in',
      chatId: 'chat-1',
      cron: '0 8 * * *',
      timezone: 'UTC',
      prompt: 'How are you?',
      source: 'system',
      kind: 'routine',
    });

    const text = await listHeartbeats({ storePath });

    expect(text).toContain('Morning check-in');
    expect(text).toContain('chat-1');
  });

  it('reports readiness without requiring network access', async () => {
    const config = getDefaultConfig();
    config.providers.main.type = 'openai';
    config.providers.main.model = 'gpt-4o';
    config.providers.main.apiKey = 'sk-secret';
    config.channels.telegram.enabled = true;
    config.channels.telegram.botToken = '123:secret-token';
    await saveConfig(configPath, config);

    const text = await showStatus({ configPath, workspacePath, storePath });

    expect(text).toContain('status');
    expect(text).toContain('telegram');
    expect(text).toContain('main provider');
  });

  it('does not report unchecked unreachable providers as ready', async () => {
    const config = getDefaultConfig();
    config.providers.main.baseUrl = 'http://127.0.0.1:1/v1';
    config.providers.medical.baseUrl = 'http://127.0.0.1:1/v1';
    config.providers.embeddings.baseUrl = 'http://127.0.0.1:1/v1';
    config.channels.telegram.enabled = false;
    await saveConfig(configPath, config);

    const text = await showStatus({ configPath, workspacePath, storePath });

    expect(text).toContain('main provider: configured (not checked)');
    expect(text).toContain('medical provider: configured (not checked)');
    expect(text).not.toContain('main provider: ready');
  });
});
