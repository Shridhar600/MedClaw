// tests/cli/admin.test.ts
//
// T1 assertion migration for the retained local admin surfaces. Retired assertions record
// the stronger contract that replaced them.
//
// The protected flow is real: a document on disk → the retained command → a decoded,
// validated replacement → an honest commit outcome → the persisted bytes.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HeartbeatStore } from '../../src/scheduler/store';
import type { ConfigFileSync } from '../../src/runtime/adapters/config-file';
import {
  setConfigValue,
  showConfig,
  showProfile,
  showStatus,
  showUserSummary,
  listHeartbeats,
} from '../../src/cli/admin';
import { writeConfigFixture } from '../helpers/config-fixture';
import { makeTestTemp } from '../helpers/test-temp';

/** A durability seam that fails after the replacement is already visible on disk. */
const failingDirectoryFlush: ConfigFileSync = {
  syncFile: () => undefined,
  syncDir: () => {
    throw new Error('simulated directory flush failure');
  },
};

describe('cli admin surfaces', () => {
  let tmpDir: string;
  let workspacePath: string;
  let configPath: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-cli-admin-');
    workspacePath = path.join(tmpDir, 'workspace');
    storePath = path.join(tmpDir, 'heartbeats', 'jobs.json');
    fs.mkdirSync(workspacePath, { recursive: true });
    const fixture = writeConfigFixture(tmpDir, {
      telegramEnabled: true,
      telegramToken: '123:secret-token',
      providerType: 'openai',
    });
    configPath = fixture.configPath;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('redacts secrets in config output', async () => {
    const text = await showConfig({ configPath });

    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-fixture-key');
    expect(text).not.toContain('secret-token');
  });

  it('shows the derived owner workspace rather than a stored path', async () => {
    const text = await showConfig({ configPath });

    expect(text).toContain(`workspace: ${path.join(tmpDir, 'state', 'profiles', 'owner')}`);
  });

  it('updates a declared non-identity value and persists it', async () => {
    const message = await setConfigValue(configPath, 'providers.main.model', 'gpt-4.1');

    expect(message).toContain('Updated providers.main.model');
    expect(message).toContain('Restart the daemon');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).providers.main.model).toBe('gpt-4.1');
  });

  // RETIRED -> `setConfigValue` mutated and saved with no validation, so
  // `agent.maxIterations 0` persisted and the agent loop then ran zero times.
  it('refuses a value that the serving decoder would reject and keeps the prior bytes', async () => {
    const before = fs.readFileSync(configPath, 'utf8');

    await expect(setConfigValue(configPath, 'agent.maxIterations', '0')).rejects.toThrow(
      /agent\.maxIterations: below the allowed minimum \[out-of-range\]/,
    );
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it.each([
    ['agent.maxIterations', 'not-a-number'],
    ['heartbeat.timezone', 'Not/AZone'],
    ['memory.search.hybridWeights', '{"vector":0.9,"keyword":0.9}'],
    ['providers.main.baseUrl', 'not-a-url'],
  ])('refuses an invalid %s and keeps the prior bytes', async (field, value) => {
    const before = fs.readFileSync(configPath, 'utf8');

    await expect(setConfigValue(configPath, field, value)).rejects.toThrow(/Refused/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  // RETIRED -> `config set memory.workspace <path>` and
  // `config set profiles.defaultProfileId other` both succeeded, letting a plain config
  // command relocate state or change the serving identity.
  it.each([
    ['memory.workspace'],
    ['heartbeat.storePath'],
    ['heartbeat.audit.path'],
    ['profiles.defaultProfileId'],
    ['profiles.baseDir'],
    ['schemaVersion'],
  ])('refuses %s because it selects identity or is derived', async (field) => {
    const before = fs.readFileSync(configPath, 'utf8');

    await expect(setConfigValue(configPath, field, '/tmp/socs-s1-hijack')).rejects.toThrow(
      /Cannot set/,
    );
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('refuses a key that is not part of the stored schema and keeps the prior bytes', async () => {
    const before = fs.readFileSync(configPath, 'utf8');

    await expect(setConfigValue(configPath, 'heartbeat.storepath', '/tmp/typo')).rejects.toThrow(/Refused/);
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('rejects dangerous config paths instead of mutating object prototypes', async () => {
    await expect(setConfigValue(configPath, '__proto__.polluted', 'true')).rejects.toThrow(
      'Unsafe config path segment',
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  // RETIRED -> the old writer performed rename-then-chmod with no try/catch and reported an
  // ordinary failure, so a caller saw an error for a write that had already landed, with no
  // way to tell whether the old bytes survived.
  it('reports an uncertain commit honestly and does not restore the old bytes', async () => {
    const message = await setConfigValue(configPath, 'agent.maxIterations', '7', {
      sync: failingDirectoryFlush,
    });

    expect(message).toContain('could not be confirmed');
    expect(message).toContain('was NOT restored');
    expect(message).not.toContain('The configuration is unchanged');

    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(persisted.agent.maxIterations).toBe(7);
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

  // RETIRED -> an unreadable file was reported identically to a missing one, so an outage
  // rendered as a healthy empty state.
  it('distinguishes an unreadable workspace file from a missing one', async () => {
    const oversize = path.join(workspacePath, 'USER.md');
    fs.writeFileSync(oversize, 'x'.repeat(256 * 1024 + 1), 'utf8');

    const text = await showUserSummary({ workspacePath });

    expect(text).toContain('USER.md unavailable');
    expect(text).not.toContain('No USER.md found.');
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

  // RETIRED -> an absent job store printed "No heartbeat jobs configured." on a machine that
  // had never been set up.
  it('says which owner the empty job list belongs to when no store exists yet', async () => {
    const text = await listHeartbeats({ storePath: path.join(tmpDir, 'absent', 'jobs.json') });

    expect(text).toContain('No heartbeat jobs configured');
    expect(text).toContain('no scheduler store yet');
  });

  it('reports readiness without requiring network access', async () => {
    const text = await showStatus({ configPath, workspacePath, storePath });

    expect(text).toContain('status');
    expect(text).toContain('telegram');
    expect(text).toContain('main provider');
  });

  it('does not report unchecked unreachable providers as ready', async () => {
    const fixture = writeConfigFixture(path.join(tmpDir, 'unreachable'), {});
    const raw = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
    for (const key of ['main', 'medical', 'embeddings']) {
      raw.providers[key].baseUrl = 'http://127.0.0.1:1/v1';
    }
    fs.writeFileSync(fixture.configPath, JSON.stringify(raw));

    const text = await showStatus({
      configPath: fixture.configPath,
      workspacePath,
      storePath,
    });

    expect(text).toContain('main provider: configured');
    expect(text).not.toContain('main provider: ready');
  });

  it('refuses an admin read of a document that cannot be decoded instead of showing defaults', async () => {
    const fixture = writeConfigFixture(path.join(tmpDir, 'broken'), { raw: '{ "schemaVersion": 1 }' });

    await expect(showStatus({ configPath: fixture.configPath })).rejects.toThrow(/schemaVersion/);
    expect(os.homedir()).toBeTruthy();
  });
});
