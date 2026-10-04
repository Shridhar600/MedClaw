// tests/cli/config-selection.test.ts
//
// The protected invariant: **every CLI command operates on the installation the operator selected**
// through the locked precedence `--config > REDACTED_CONFIG_PATH > ~/.redacted/config.json`.
//
// `selectConfigPath` has always implemented that precedence correctly, and `tests/runtime-startup`
// has always proved it. The defect was that the CLI mostly did not CALL it: eight sites in
// `src/cli/index.ts` and `src/cli/admin.ts` wrote `configPath ?? defaultRuntimeConfigPath()` by hand,
// which skips the environment step entirely. `onboard` went further and manufactured a `--config`
// flag holding the default, so even correct selection downstream could not recover.
//
// These cases go through the real `runCli` entry point with a real fixture on disk, because the bug
// lives in the wiring between the flag parser and the command — not in `selectConfigPath` itself.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli/index';
import { writeConfigFixture } from '../helpers/config-fixture';
import { makeTestTemp } from '../helpers/test-temp';

interface Selected {
  /** The environment-selected installation. */
  envConfigPath: string;
  /** Its owner record — the file `pairing issue` must write. */
  envOwnerRecord: string;
  /** The home-default installation — must never be touched when the env var is set. */
  homeConfigPath: string;
  homeOwnerRecord: string;
  lines: string[];
  stderr: string[];
  restore: () => void;
}

/** Two complete, distinct installations: one selected by env, one the home default. */
async function twoInstallations(): Promise<Selected> {
  const root = makeTestTemp('cli-config-selection');
  const envDir = path.join(root, 'alternate');
  const homeDir = path.join(root, 'home');

  const envFixture = writeConfigFixture(envDir, { ownerId: 'alternate-owner' });
  // MUST be `$HOME/.redacted/config.json` — that is what `defaultRuntimeConfigPath()` returns.
  // My first version wrote it to `$HOME/config.json`, a path no code path ever resolves to,
  // which made the "unselected install was untouched" assertions tautological.
  const homeFixture = writeConfigFixture(path.join(homeDir, '.redacted'), { ownerId: 'home-default-owner' });

  // Real setup creates the unpaired owner record BEFORE anything may issue a code against it, and
  // `issueChallenge` expects to find that record. The config fixture writes only the document, so the
  // record is created here through the same real collaborators setup uses.
  //
  // Created for the SELECTED installation ONLY. That is what keeps "the unselected record does not
  // exist" a meaningful assertion instead of something the fixture arranged in advance — if `pairing
  // issue` targeted the wrong installation it would have nothing to write and the test would fail.
  void initializeUnpairedRecord(envFixture.ownerRecord, envFixture.ownerId);

  const originalHome = process.env.HOME;
  const originalEnv = process.env.REDACTED_CONFIG_PATH;
  process.env.HOME = homeDir;
  process.env.REDACTED_CONFIG_PATH = envFixture.configPath;

  const lines: string[] = [];
  const stderr: string[] = [];
  return {
    envConfigPath: envFixture.configPath,
    envOwnerRecord: envFixture.ownerRecord,
    homeConfigPath: homeFixture.configPath,
    homeOwnerRecord: homeFixture.ownerRecord,
    lines,
    stderr,
    restore: () => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalEnv === undefined) delete process.env.REDACTED_CONFIG_PATH;
      else process.env.REDACTED_CONFIG_PATH = originalEnv;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Create the unpaired owner record exactly as `InstallationService.setup()` does: real state file
 * adapter, real pairing-code port, real admission service. Returns the create outcome.
 */
async function initializeUnpairedRecord(recordPath: string, ownerId: string): Promise<string> {
  const { FileOwnerStatePort } = await import('../../src/runtime/adapters/owner-state-file');
  const { CryptoPairingCodePort } = await import('../../src/runtime/adapters/pairing-code');
  const { OwnerAdmissionService, asProfileId } = await import('../../src/profiles');
  const { systemClock } = await import('../../src/ports/defaults');

  const id = asProfileId(ownerId);
  if (id === undefined) throw new Error(`invalid fixture owner id: ${ownerId}`);

  return new OwnerAdmissionService({
    store: new FileOwnerStatePort(recordPath, id),
    codes: new CryptoPairingCodePort(),
    clock: systemClock,
    expectedOwnerId: id,
  }).initialize();
}

function ioFor(sel: Selected) {
  return {
    stdout: (text: string): void => {
      sel.lines.push(...text.split('\n'));
    },
    stderr: (text: string): void => {
      sel.stderr.push(...text.split('\n'));
    },
  };
}

describe('CLI honours the locked configuration selection order everywhere', () => {
  let sel: Selected;
  beforeEach(async () => {
    sel = await twoInstallations();
  });
  afterEach(() => {
    sel.restore();
  });

  it('config show reads the installation REDACTED_CONFIG_PATH selects', async () => {
    const code = await runCli(['config', 'show'], ioFor(sel));

    expect(sel.stderr).toEqual([]);
    expect(code).toBe(0);
    // The alternate installation names a different owner, so its identity appearing in the output is
    // proof the env-selected document was the one read.
    expect(sel.lines.join('\n')).toContain('alternate-owner');
    expect(sel.lines.join('\n')).not.toContain('home-default-owner');
  });

  it('config set MUTATES the environment-selected installation, never the home default', async () => {
    // Before the fix this wrote the home default instead: the operator selected one installation and
    // the CLI silently edited another one.
    const before = fs.readFileSync(sel.homeConfigPath, 'utf8');

    const code = await runCli(
      ['config', 'set', 'providers.main.baseUrl', 'http://127.0.0.1:11434'],
      ioFor(sel),
    );

    expect(code).toBe(0);
    // The selected installation changed…
    expect(fs.readFileSync(sel.envConfigPath, 'utf8')).toContain('127.0.0.1:11434');
    // …and the unselected one is byte-identical.
    expect(fs.readFileSync(sel.homeConfigPath, 'utf8')).toBe(before);
  });

  it('status reports the environment-selected configuration path', async () => {
    const code = await runCli(['status'], ioFor(sel));

    expect(code).toBe(0);
    expect(sel.lines.join('\n')).toContain(sel.envConfigPath);
  });

  it('an explicit --config still outranks REDACTED_CONFIG_PATH', async () => {
    const code = await runCli(['--config', sel.homeConfigPath, 'config', 'show'], ioFor(sel));

    expect(code).toBe(0);
    expect(sel.lines.join('\n')).toContain('home-default-owner');
    expect(sel.lines.join('\n')).not.toContain('alternate-owner');
  });

  it('pairing issue targets the environment-selected installation', async () => {
    // `pairing issue` refuses against a bound owner, but it must refuse against the SELECTED one.
    // Running it against the unselected default would succeed and write a code into an installation
    // the operator never chose.
    const code = await runCli(['pairing', 'issue'], ioFor(sel));

    // Both fixtures are unpaired, so this issues against the selected one. What matters is that the
    // code lands in the selected installation's owner record and nowhere else.
    expect(code).toBe(0);
    expect(sel.lines.join('\n')).toContain('Pairing code issued');
    expect(fs.existsSync(sel.envOwnerRecord)).toBe(true);
    expect(fs.existsSync(sel.homeOwnerRecord)).toBe(false);
  });
});