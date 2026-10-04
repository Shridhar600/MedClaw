// tests/runtime-startup.test.ts
//
// RETIRED -> the old first case asserted that `config.memory.workspace` equalled a path
// persisted in the document. The workspace is now derived from the selected owner, so the
// replacement asserts identity selection plus derivation, and additionally that the
// selection precedence and the usage errors are real.
import * as fs from 'fs';
import * as path from 'path';
import {
  ConfigSelectionError,
  ConfigUnavailableError,
  defaultRuntimeConfigPath,
  loadRuntimeConfig,
  parseGlobalOptions,
  selectConfigPath,
} from '../src/runtime/startup';
import { writeConfigFixture } from './helpers/config-fixture';
import { makeTestTemp } from './helpers/test-temp';

describe('runtime startup config resolution', () => {
  const originalConfigPath = process.env.REDACTED_CONFIG_PATH;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-runtime-startup-');
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

  it('falls back to the home config path when REDACTED_CONFIG_PATH is absent or empty', () => {
    expect(selectConfigPath({ env: {}, homeDir: tmpDir })).toBe(defaultRuntimeConfigPath(tmpDir));
    expect(selectConfigPath({ env: { REDACTED_CONFIG_PATH: '' }, homeDir: tmpDir })).toBe(
      defaultRuntimeConfigPath(tmpDir),
    );
  });

  it('prefers REDACTED_CONFIG_PATH over the home default and --config over both', () => {
    const fromEnv = path.join(tmpDir, 'env.json');
    const fromFlag = path.join(tmpDir, 'flag.json');

    expect(selectConfigPath({ env: { REDACTED_CONFIG_PATH: fromEnv }, homeDir: tmpDir })).toBe(fromEnv);
    expect(
      selectConfigPath({ flagValue: fromFlag, env: { REDACTED_CONFIG_PATH: fromEnv }, homeDir: tmpDir }),
    ).toBe(fromFlag);
  });

  // RETIRED -> a missing `--config` value silently fell back to the home default and consumed
  // the following token (the command) as its value.
  it('refuses a --config flag with no value instead of falling back', () => {
    expect(() => parseGlobalOptions(['--config'])).toThrow(ConfigSelectionError);
    expect(() => parseGlobalOptions(['--config', '--help'])).toThrow(/requires a path/);
    expect(() => selectConfigPath({ flagValue: '' })).toThrow(ConfigSelectionError);
  });

  // RETIRED -> an unknown global flag fell through and was interpreted as the command, so
  // `status --bogus` was silently ignored.
  //
  // S1 change (old -> new): global parsing now STOPS at the command, so that
  // `medclaw onboard --yes --owner-id kiran` reaches `onboard`'s own parser instead of dying as an
  // "unknown option" (which made `--yes` unreachable through `runCli` entirely). The protection this
  // test protects is preserved one layer out: a command that declares no options of its own still
  // refuses a stray flag, in `runCli` — see tests/cli/cli.test.ts.
  it('stops global parsing at the command so command options reach their own parser', () => {
    expect(parseGlobalOptions(['onboard', '--yes', '--owner-id', 'kiran'])).toEqual({
      configPath: undefined,
      help: false,
      rest: ['onboard', '--yes', '--owner-id', 'kiran'],
    });
    // An unrecognised flag BEFORE the command is still refused, so a global typo is not forwarded.
    expect(() => parseGlobalOptions(['--bogus', 'status'])).toThrow(/Unknown option: --bogus/);
    expect(parseGlobalOptions(['--config', '/x/y.json', 'status'])).toEqual({
      configPath: '/x/y.json',
      help: false,
      rest: ['status'],
    });
  });

  it('loads the home config and derives every owner path from the selected identity', async () => {
    const baseDir = path.join(tmpDir, 'state');
    const fixture = writeConfigFixture(tmpDir, { baseDir, ownerId: 'shridhar', raw: undefined });
    // Move the document to the home default location so this exercises the fallback.
    fs.mkdirSync(path.dirname(defaultRuntimeConfigPath(tmpDir)), { recursive: true });
    fs.renameSync(fixture.configPath, defaultRuntimeConfigPath(tmpDir));

    const config = await loadRuntimeConfig({ homeDir: tmpDir });

    expect(config.profiles.defaultProfileId).toBe('shridhar');
    expect(config.memory.workspace).toBe(path.join(baseDir, 'profiles', 'shridhar'));
    expect(config.heartbeat.storePath).toBe(path.join(baseDir, 'profiles', 'shridhar', '.state', 'heartbeat-jobs.json'));
    expect(config.heartbeat.audit.path).toBe(path.join(baseDir, 'profiles', 'shridhar', '.state', 'audit.jsonl'));
    expect(config.channels.telegram.enabled).toBe(false);
    expect(config.heartbeat.enabled).toBe(true);
  });

  it('refuses to serve when the selected document is absent, keeping the onboard guidance', async () => {
    await expect(loadRuntimeConfig({ homeDir: tmpDir })).rejects.toThrow(
      `Config file not found at ${path.join(tmpDir, '.redacted', 'config.json')}. Run \`npm run cli -- onboard\``,
    );
  });

  it('refuses a document with no owner identity rather than serving a default owner', async () => {
    const fixture = writeConfigFixture(tmpDir, { raw: '{ "schemaVersion": 2 }' });

    await expect(loadRuntimeConfig({ configPath: fixture.configPath, homeDir: tmpDir })).rejects.toThrow(
      ConfigUnavailableError,
    );
    await expect(loadRuntimeConfig({ configPath: fixture.configPath, homeDir: tmpDir })).rejects.toThrow(
      /profiles\.defaultProfileId: required setting is absent/,
    );
  });

  it('leaves the refused document byte-identical', async () => {
    const raw = '{ "schemaVersion": 2, "profiles": { "baseDir": "/tmp/s", "defaultProfileId": "BAD ID" } }';
    const fixture = writeConfigFixture(tmpDir, { raw });
    const before = fs.readFileSync(fixture.configPath, 'utf8');

    await expect(loadRuntimeConfig({ configPath: fixture.configPath, homeDir: tmpDir })).rejects.toThrow();

    expect(fs.readFileSync(fixture.configPath, 'utf8')).toBe(before);
  });

  it('reports the selected path so a refusal names the document it refused', async () => {
    const fixture = writeConfigFixture(tmpDir, { raw: 'not json at all {' });

    // A homeDir with no config document in it. Workspace-local, and strictly better than system temp:
    // a shared temp directory could in principle hold a stray config, which would make this pass or
    // fail for reasons unrelated to the behaviour under test.
    const emptyHome = makeTestTemp('r14-empty-home');
    await expect(loadRuntimeConfig({ configPath: fixture.configPath, homeDir: emptyHome })).rejects.toThrow(
      new RegExp(fixture.configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });
});
