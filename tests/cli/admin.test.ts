// tests/cli/admin.test.ts
//
// T1 assertion migration for the retained local admin surfaces. Retired assertions record
// the stronger contract that replaced them.
//
// The protected flow is real: a document on disk → the retained command → a decoded,
// validated replacement → an honest commit outcome → the persisted bytes.
import fs = require('fs');
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { HeartbeatStore, HeartbeatScheduler, buildDesiredHeartbeatJobs, reconcilePolicyJobs } from '../../src/scheduler';
import type { ConfigFileSync } from '../../src/runtime';
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
import { runCli } from '../../src/cli';
import { loadRuntimeConfig, DirectoryLease } from '../../src/runtime';
import { bindOwnerFixture } from '../helpers/owner-authority-fixture';

/** A durability seam that fails after the replacement is already visible on disk. */
const failingDirectoryFlush: ConfigFileSync = {
  syncFile: () => undefined,
  syncDir: () => {
    throw new Error('simulated directory flush failure');
  },
};

/** Small synthetic tree only; records directories, content, modes and write metadata, excluding atime. */
function inspectionSnapshot(root: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  const walk = (entry: string): void => {
    if (Object.keys(entries).length > 100) throw new Error('synthetic inventory exceeded its bound');
    const stat = fs.lstatSync(entry);
    entries[path.relative(root, entry)] = {
      mode: stat.mode, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs,
      content: stat.isFile() ? createHash('sha256').update(fs.readFileSync(entry)).digest('hex') : undefined,
      link: stat.isSymbolicLink() ? fs.readlinkSync(entry) : undefined,
    };
    if (stat.isDirectory()) for (const name of fs.readdirSync(entry).sort()) walk(path.join(entry, name));
  };
  walk(root);
  return entries;
}

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

  it('keeps bound owner identity and paths across normalized protected refusals and an offline update', async () => {
    const fixture = writeConfigFixture(path.join(tmpDir, 'selected'));
    await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId);
    const configBytes = fs.readFileSync(fixture.configPath);
    const ownerBytes = fs.readFileSync(fixture.ownerRecord);
    const before = await loadRuntimeConfig({ configPath: fixture.configPath });

    for (const [field, value] of [
      ['profiles .defaultProfileId', 'other-owner'],
      [' profiles . baseDir ', JSON.stringify(path.join(tmpDir, 'elsewhere'))],
      ['profiles', '{"baseDir":"/unselected","defaultProfileId":"other-owner"}'],
      ['profiles.defaultProfileId.child', 'other-owner'],
      ['heartbeat', '{}'],
      ['memory', '{}'],
      ['profiles..defaultProfileId', 'other-owner'],
      ['profiles[0].defaultProfileId', 'other-owner'],
      ['providers.main.__proto__.polluted', 'true'],
      ['providers.main.model.PATH_SECRET_MARKER[]', 'VALUE_SECRET_MARKER'],
    ]) {
      let output = '';
      const exit = await runCli(['--config', fixture.configPath, 'config', 'set', field, value], {
        stdout: (text) => { output += text; }, stderr: (text) => { output += text; },
      });
      expect({ field, exit }).toEqual({ field, exit: 1 });
      expect(output).not.toContain('SECRET_MARKER');
      expect(fs.readFileSync(fixture.configPath)).toEqual(configBytes);
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(ownerBytes);
      expect(await loadRuntimeConfig({ configPath: fixture.configPath })).toEqual(before);
    }

    const lease = await new DirectoryLease().tryAcquire({ kind: 'config', canonicalPath: fixture.configPath });
    expect(lease.kind).toBe('acquired');
    if (lease.kind !== 'acquired') throw new Error('fixture lease not acquired');
    try {
      await expect(setConfigValue(fixture.configPath, 'agent.maxIterations', '7')).rejects.toThrow(/Cannot set/);
      expect(fs.readFileSync(fixture.configPath)).toEqual(configBytes);
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(ownerBytes);
    } finally {
      await lease.release();
    }
    await expect(setConfigValue(fixture.configPath, ' agent . maxIterations ', '0')).rejects.toThrow(/Refused/);
    expect(fs.readFileSync(fixture.configPath)).toEqual(configBytes);
    expect(fs.readFileSync(fixture.ownerRecord)).toEqual(ownerBytes);
    const message = await setConfigValue(fixture.configPath, ' agent . maxIterations ', '7');
    expect(message).toContain('Updated agent.maxIterations');
    expect(message).toContain('Restart the daemon');
    const reloaded = await loadRuntimeConfig({ configPath: fixture.configPath });
    expect(reloaded.agent.maxIterations).toBe(7);
    expect(reloaded.profiles).toEqual(before.profiles);
    expect(reloaded.memory.workspace).toBe(before.memory.workspace);
    expect(reloaded.heartbeat.storePath).toBe(before.heartbeat.storePath);
    expect(fs.readFileSync(fixture.ownerRecord)).toEqual(ownerBytes);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses unusable cron before publication and during restart decoding', async () => {
    const fixture = writeConfigFixture(path.join(tmpDir, 'cron-refusal'));
    await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId);
    const before = fs.readFileSync(fixture.configPath);
    const ownerBefore = fs.readFileSync(fixture.ownerRecord);
    const field = 'heartbeat.policy.defaults.morningCheckIn.cron';
    for (const expression of ['99 99 * * *', '0 24 * * *', '0 8 0 * *', '0 8 * 13 *', '0 8 * * 9', '*/0 * * * *', 'CRON_SECRET_MARKER']) {
      let output = '';
      expect(await runCli(['--config', fixture.configPath, 'config', 'set', field, expression], {
        stdout: (text) => { output += text; }, stderr: (text) => { output += text; },
      })).toBe(1);
      expect(output).toContain(`${field}:`);
      expect(output).toContain('[invalid-cron]');
      expect(output).not.toContain(expression);
      expect(fs.readFileSync(fixture.configPath)).toEqual(before);
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(ownerBefore);
    }
    const invalid = JSON.parse(before.toString('utf8'));
    invalid.heartbeat.policy.defaults.morningCheckIn.cron = '99 99 * * *';
    fs.writeFileSync(fixture.configPath, JSON.stringify(invalid));
    await expect(loadRuntimeConfig({ configPath: fixture.configPath })).rejects.toThrow(/invalid-cron/);
    expect(fs.readFileSync(fixture.ownerRecord)).toEqual(ownerBefore);
  });

  it('publishes supported cron and reconciles the expected durable policy job without duplicates', async () => {
    const fixture = writeConfigFixture(path.join(tmpDir, 'cron-reconcile'), {
      apply: (stored) => {
        stored.heartbeat.enabled = true;
        stored.heartbeat.policy.defaults.morningCheckIn.enabled = true;
        stored.heartbeat.policy.defaults.eveningSummary.enabled = false;
      },
    });
    await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId, 'scheduler-owner-chat');
    let triggered = 0;
    const scheduler = new HeartbeatScheduler(new HeartbeatStore(fixture.storePath), async () => { triggered += 1; }, 'UTC', {
      canAddressChat: (chatId): boolean => chatId === 'scheduler-owner-chat',
    });
    const field = 'heartbeat.policy.defaults.morningCheckIn.cron';
    let jobId: string | undefined;
    try {
      // Actual installed conversion: five/six fields, names, lists, reversed/chained ranges,
      // weekday aliases and a large step divisor that does not amplify range allocation.
      for (const expression of [
        '0 8 * * *', '0 */15 8-10 * January,Sep Monday-Friday',
        '0 30-0/15 10-8 * Dec-Jan Fri-Mon', '0 8 * * 0,7',
        '0 8 * * 6-7', '0 8 * * 7-7', '0/1000000000 0 8 * * *',
        '0 3-2-1 8 * * *',
        `${Array.from({ length: 60 }, (_, i) => i).join(',')} 0 8 * * *`,
        '0 8 * January,February,March,April,May,June,July,August,September,October,November,December Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday',
      ]) {
        expect(await setConfigValue(fixture.configPath, field, expression)).toContain('Restart the daemon');
        const config = await loadRuntimeConfig({ configPath: fixture.configPath });
        const desired = await buildDesiredHeartbeatJobs({
          workspacePath: config.memory.workspace, chatId: 'scheduler-owner-chat',
          timezone: config.heartbeat.timezone, policy: config.heartbeat.policy,
        });
        expect(desired).toEqual([{
          title: 'Morning check-in', chatId: 'scheduler-owner-chat', cron: expression,
          timezone: config.heartbeat.timezone, prompt: config.heartbeat.policy.defaults.morningCheckIn.prompt,
          source: 'system', kind: 'routine', policyKey: 'defaults:morning-check-in',
        }]);
        expect(await reconcilePolicyJobs(scheduler, desired)).toEqual({ created: jobId ? 0 : 1, updated: jobId ? 1 : 0, deleted: 0 });
        const durable = await new HeartbeatStore(fixture.storePath).list();
        expect(durable).toHaveLength(1);
        expect(durable[0]).toMatchObject({ ...desired[0], enabled: true, deliveryState: 'ready' });
        if (jobId) expect(durable[0].id).toBe(jobId);
        jobId = durable[0].id;
        expect(await reconcilePolicyJobs(scheduler, desired)).toEqual({ created: 0, updated: 0, deleted: 0 });
      }
      expect(triggered).toBe(0);
    } finally {
      await scheduler.stop();
    }
  });

  it('refuses cron amplification before installed conversion across edit, restart and validation', async () => {
    const fixture = writeConfigFixture(path.join(tmpDir, 'cron-resource-refusal'));
    await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId);
    const configBefore = fs.readFileSync(fixture.configPath);
    const ownerBefore = fs.readFileSync(fixture.ownerRecord);
    const selectedBefore = await loadRuntimeConfig({ configPath: fixture.configPath });

    // Execute the installed range converter verbatim except for a finite per-validation brake.
    // Never allocate the requested billion-entry range, even on received code or an inverse.
    const converterPath = require.resolve('node-cron/src/convert-expression/range-conversion');
    const converterSource = fs.readFileSync(converterPath, 'utf8');
    expect(Buffer.byteLength(converterSource)).toBeLessThan(16 * 1024);
    expect(converterSource.split('numbers.push(i);')).toHaveLength(2);
    let target = '';
    let active = false;
    let libraryCalls = 0;
    let expansionSteps = 0;
    let callSteps = 0;
    const installedWithBrake = new Function('module', 'step',
      `${converterSource.replace('numbers.push(i);', 'step(); numbers.push(i);')}\nreturn module.exports;`,
    )({ exports: {} }, () => {
      if (active) {
        expansionSteps += 1;
        if (++callSteps >= 2048) throw new Error('SYNTHETIC_FINITE_RANGE_BRAKE');
      }
    });
    const observations: Array<Record<string, unknown>> = [];
    const unsafe = [
      ['huge-domain', '0 8 1-1000000000 * *'],
      ['reversed-huge', '0 8 1000000000-1 * *'],
      ['unsafe-integer', '0 8 9007199254740992-9007199254740992 * *'],
      ['nonfinite-endpoint', `0 8 1-${'9'.repeat(310)} * *`],
      ['normalized-names', '0 8 * JanJanJanJanJanJanJanJanJanJan-2 *'],
      ['chained-range', '0 8 1-2-1000000000 * *'],
      ['six-field-seconds', '0-1000000000 0 8 * * *'],
      ['out-of-domain', '0 8 32-33 * *'],
      ['total-work', `${Array.from({ length: 10 }, () => '0-59').join(',')} 8 * * *`],
      ['input-length', `${'0'.repeat(1025)} 8 * * *`],
    ];
    jest.doMock('node-cron/src/convert-expression/range-conversion', () => installedWithBrake);
    jest.doMock('node-cron', () => {
      const installed = jest.requireActual<typeof import('node-cron')>('node-cron');
      return { ...installed, validate: (expression: string): boolean => {
        const previous = active;
        active = expression === target;
        if (active) { libraryCalls += 1; callSteps = 0; }
        try { return installed.validate(expression); } finally { active = previous; }
      } };
    });
    try {
      await jest.isolateModulesAsync(async () => {
        const cli = await import('../../src/cli');
        const runtime = await import('../../src/runtime');
        const configPolicy = await import('../../src/config');
        for (const key of ['morningCheckIn', 'eveningSummary'] as const) {
          for (const enabled of [true, false]) {
            const baseline = JSON.parse(configBefore.toString('utf8'));
            baseline.heartbeat.policy.defaults[key].enabled = enabled;
            const bytes = Buffer.from(JSON.stringify(baseline));
            for (const [label, expression] of unsafe) {
              fs.writeFileSync(fixture.configPath, bytes);
              target = expression;
              libraryCalls = 0;
              expansionSteps = 0;
              const field = `heartbeat.policy.defaults.${key}.cron`;
              let output = '';
              const exit = await cli.runCli(['--config', fixture.configPath, 'config', 'set', field, expression], {
                stdout: (text) => { output += text; }, stderr: (text) => { output += text; },
              });
              const editPreserved = fs.readFileSync(fixture.configPath).equals(bytes);
              const invalid = structuredClone(baseline);
              invalid.heartbeat.policy.defaults[key].cron = expression;
              const manualBytes = Buffer.from(JSON.stringify(invalid));
              fs.writeFileSync(fixture.configPath, manualBytes);
              let loadMessage = '';
              try { await runtime.loadRuntimeConfig({ configPath: fixture.configPath }); }
              catch (error) { loadMessage = (error as Error).message; }
              const validation = configPolicy.validateConfig({
                ...selectedBefore, heartbeat: { ...selectedBefore.heartbeat, ...invalid.heartbeat },
              });
              observations.push({ label, key, enabled, libraryCalls, expansionSteps });
              // These remain meaningful on the inverse, but the causal assertion below runs first.
              observations.push({ label, key, enabled, refused: exit === 1 && !validation.valid,
                fieldOnly: [output, loadMessage, ...validation.errors].every((message) =>
                  message.includes(field) && message.includes('[invalid-cron]') && !message.includes(expression)),
                editPreserved, loadPreserved: fs.readFileSync(fixture.configPath).equals(manualBytes),
                ownerPreserved: fs.readFileSync(fixture.ownerRecord).equals(ownerBefore),
              });
            }
          }
        }
      });
      // Removing the preflight must fail here because the actual expanding library was entered.
      expect(observations.filter((item) => 'libraryCalls' in item && (item.libraryCalls !== 0 || item.expansionSteps !== 0))).toEqual([]);
      for (const observation of observations.filter((item) => 'refused' in item)) {
        expect(observation).toMatchObject({ refused: true, fieldOnly: true, editPreserved: true, loadPreserved: true, ownerPreserved: true });
      }
    } finally {
      jest.dontMock('node-cron');
      jest.dontMock('node-cron/src/convert-expression/range-conversion');
      fs.writeFileSync(fixture.configPath, configBefore);
    }
    expect(await loadRuntimeConfig({ configPath: fixture.configPath })).toEqual(selectedBefore);
    expect(fs.readFileSync(fixture.ownerRecord)).toEqual(ownerBefore);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
    const lease = await new DirectoryLease().tryAcquire({ kind: 'config', canonicalPath: fixture.configPath });
    expect(lease.kind).toBe('acquired');
    if (lease.kind !== 'acquired') throw new Error('fixture config lease not released');
    await lease.release();
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

  it('reports each selected heartbeat snapshot truthfully without file or directory mutation', async () => {
    // Positive control: the detector must observe directory-only and content/mode changes.
    const detector = path.join(tmpDir, 'detector');
    fs.mkdirSync(detector);
    fs.writeFileSync(path.join(detector, 'sentinel'), 'before');
    const initial = inspectionSnapshot(detector);
    fs.mkdirSync(path.join(detector, 'new-directory'));
    expect(inspectionSnapshot(detector)).not.toEqual(initial);
    const withDirectory = inspectionSnapshot(detector);
    fs.writeFileSync(path.join(detector, 'sentinel'), 'after');
    fs.chmodSync(path.join(detector, 'sentinel'), 0o400);
    expect(inspectionSnapshot(detector)).not.toEqual(withDirectory);

    for (const state of ['missing', 'empty', 'populated', 'bad-json', 'zero', 'bad-record', 'bad-state', 'unavailable', 'oversize']) {
      const selected = path.join(tmpDir, `inspect-${state}`);
      const fixture = writeConfigFixture(selected);
      if (state !== 'missing') fs.mkdirSync(path.dirname(fixture.storePath), { recursive: true });
      if (state === 'empty') fs.writeFileSync(fixture.storePath, '[]');
      if (state === 'zero') fs.writeFileSync(fixture.storePath, '');
      if (state === 'bad-json') fs.writeFileSync(fixture.storePath, 'SECRET_HEALTH_MARKER{');
      if (state === 'bad-record') fs.writeFileSync(fixture.storePath, '[{}]');
      if (state === 'unavailable') fs.mkdirSync(fixture.storePath);
      if (state === 'oversize') fs.writeFileSync(fixture.storePath, `[]${' '.repeat(256 * 1024)}`);
      if (state === 'populated' || state === 'bad-state') {
        await new HeartbeatStore(fixture.storePath).create({
          title: 'Selected owner check-in', chatId: 'selected-chat', cron: '0 8 * * *',
          timezone: 'UTC', prompt: 'Synthetic check-in', source: 'system', kind: 'routine',
        });
        const jobs = JSON.parse(fs.readFileSync(fixture.storePath, 'utf8'));
        if (state === 'populated') delete jobs[0].deliveryState; // Existing documented default only.
        else jobs[0].deliveryState = 12;
        fs.writeFileSync(fixture.storePath, JSON.stringify(jobs));
      }
      const before = inspectionSnapshot(selected);
      let output = '';
      expect(await runCli(['--config', fixture.configPath, 'heartbeats', 'list'], {
        stdout: (text) => { output += text; }, stderr: (text) => { output += text; },
      })).toBe(0);
      expect(inspectionSnapshot(selected)).toEqual(before);
      const expected = state === 'missing' ? 'no scheduler store yet'
        : state === 'empty' ? 'No heartbeat jobs configured.'
          : state === 'populated' ? 'Selected owner check-in'
            : ['unavailable', 'oversize'].includes(state) ? 'Heartbeat store unavailable'
              : 'Heartbeat store corrupt';
      expect({ state, output }).toEqual({ state, output: expect.stringContaining(expected) });
      if (state === 'populated') expect(output).toContain('deliveryState: ready');
      if (!['missing', 'empty', 'populated'].includes(state)) expect(output).not.toContain('No heartbeat jobs');
      expect(output).not.toContain('SECRET_HEALTH_MARKER');
      expect(inspectionSnapshot(selected)).toEqual(before);

      // Status is a second reader of the same store, and must not invoke recovery either.
      output = '';
      expect(await runCli(['--config', fixture.configPath, 'status'], {
        stdout: (text) => { output += text; }, stderr: (text) => { output += text; },
      })).toBe(0);
      if (!['missing', 'empty', 'populated'].includes(state)) {
        expect(output).toContain('heartbeat jobs: unavailable');
        expect(output).not.toContain('heartbeat jobs: 0');
      }
      expect(inspectionSnapshot(selected)).toEqual(before);
    }
  });

  it('bounds actual opened heartbeat reads when metadata understates the file, and closes on refusal', async () => {
    const fixture = writeConfigFixture(path.join(tmpDir, 'inspect-opened-bound'));
    fs.mkdirSync(path.dirname(fixture.storePath), { recursive: true });
    // Still valid JSON, so removing only the actual byte bound would yield healthy-empty.
    fs.writeFileSync(fixture.storePath, `[]${' '.repeat(256 * 1024)}`);
    const before = inspectionSnapshot(path.dirname(fixture.storePath));
    const realOpen = fs.openSync;
    const realPathStat = fs.statSync;
    const realStat = fs.fstatSync;
    const realClose = fs.closeSync;
    const realRead = fs.readSync;
    const opened = new Set<number>();
    let metadataCalls = 0;
    let readBytes = 0;
    let readFault = false;
    const pathStatSpy = jest.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike) => {
      const stat = realPathStat(file);
      return file === fixture.storePath ? Object.assign(stat, { size: 2 }) : stat;
    }) as typeof fs.statSync);
    const openSpy = jest.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = realOpen(...args);
      if (args[0] === fixture.storePath) opened.add(fd);
      return fd;
    });
    const statSpy = jest.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stat = realStat(fd);
      if (opened.has(fd)) {
        metadataCalls += 1;
        return Object.assign(stat, { size: 2 });
      }
      return stat;
    }) as typeof fs.fstatSync);
    const closeSpy = jest.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      realClose(fd);
      opened.delete(fd);
    });
    const readSpy = jest.spyOn(fs, 'readSync').mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
      if (opened.has(fd)) {
        if (readFault) throw new Error('SECRET_IO_MARKER');
        // Exercise short reads rather than assuming one read fills the budget.
        const bytes = realRead(fd, buffer, offset, Math.min(length, 4096), position);
        readBytes += bytes;
        return bytes;
      }
      return realRead(fd, buffer, offset, length, position);
    }) as typeof fs.readSync);
    try {
      let output = '';
      expect(await runCli(['--config', fixture.configPath, 'heartbeats', 'list'], {
        stdout: (text) => { output += text; }, stderr: (text) => { output += text; },
      })).toBe(0);
      expect(output).toContain('Heartbeat store unavailable');
      expect(output).toContain('262144');
      expect(output).not.toContain('No heartbeat jobs');
      expect(metadataCalls).toBeGreaterThan(0);
      expect(readBytes).toBe(256 * 1024 + 1);
      expect(opened.size).toBe(0);
      readFault = true;
      output = '';
      expect(await runCli(['--config', fixture.configPath, 'heartbeats', 'list'], {
        stdout: (text) => { output += text; }, stderr: (text) => { output += text; },
      })).toBe(0);
      expect(output).toContain('Heartbeat store unavailable');
      expect(output).not.toContain('SECRET_IO_MARKER');
      expect(opened.size).toBe(0);
    } finally {
      openSpy.mockRestore(); pathStatSpy.mockRestore(); statSpy.mockRestore(); closeSpy.mockRestore(); readSpy.mockRestore();
      for (const fd of opened) realClose(fd);
    }
    expect(inspectionSnapshot(path.dirname(fixture.storePath))).toEqual(before);
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
