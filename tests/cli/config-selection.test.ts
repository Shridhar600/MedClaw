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
import { loadRuntimeConfig } from '../../src/runtime/startup';
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

interface Targets {
  root: string;
  homeDir: string;
  /** Selected explicitly by flag — must be the only target that could be written. */
  selectedConfig: string;
  /** Selected by REDACTED_CONFIG_PATH. */
  envConfig: string;
  /** The home default. A refusal must never reach it. */
  homeConfig: string;
  restore: () => void;
}

/**
 * The explicitly-selected target is deliberately FRESH.
 *
 * My first version pointed every case at a pre-existing installation. That made the no-write
 * assertion hollow: a lenient parser would sail past the parser and then be stopped by the
 * existing-target refusal, so the test would "prove" no writes for the wrong reason. With a fresh
 * target, a parser that lets malformed input through really does create files, and
 * `unexpectedPaths` catches it.
 *
 * The environment and home installations DO exist, with sentinel bytes, so a wrong-target
 * attempt is additionally visible as modified bytes.
 */
function threeTargets(): Targets {
  const root = makeTestTemp('c04-malformed');
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(path.join(homeDir, '.redacted'), { recursive: true });

  const selected = { configPath: path.join(root, 'selected', 'config.json') };
  const envFixture = writeConfigFixture(path.join(root, 'env-selected'), { ownerId: 'env-owner' });
  const homeFixture = writeConfigFixture(path.join(homeDir, '.redacted'), { ownerId: 'home-owner' });

  // Sentinels: existing bytes that must survive byte-for-byte.
  fs.appendFileSync(envFixture.configPath, '\n// sentinel-env\n');
  fs.appendFileSync(homeFixture.configPath, '\n// sentinel-home\n');

  const originalHome = process.env.HOME;
  const originalEnv = process.env.REDACTED_CONFIG_PATH;
  process.env.HOME = homeDir;
  process.env.REDACTED_CONFIG_PATH = envFixture.configPath;

  return {
    root,
    homeDir,
    selectedConfig: selected.configPath,
    envConfig: envFixture.configPath,
    homeConfig: homeFixture.configPath,
    restore: (): void => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalEnv === undefined) delete process.env.REDACTED_CONFIG_PATH;
      else process.env.REDACTED_CONFIG_PATH = originalEnv;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Exact bytes of every config target, for a before/after comparison. Absent reads as absent. */
function snapshot(t: Targets): Record<string, string> {
  const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '<absent>');
  return {
    selected: read(t.selectedConfig),
    env: read(t.envConfig),
    home: read(t.homeConfig),
  };
}

/** Any path created anywhere under the temp root that is not part of the original fixtures. */
function unexpectedPaths(t: Targets, before: string[]): string[] {
  const walk = (dir: string, out: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else out.push(path.relative(t.root, full));
    }
  };
  const now: string[] = [];
  walk(t.root, now);
  return now.filter((entry) => !before.includes(entry)).sort();
}

function listAll(t: Targets): string[] {
  const walk = (dir: string, out: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else out.push(path.relative(t.root, full));
    }
  };
  const out: string[] = [];
  walk(t.root, out);
  return out.sort();
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

// ── R06: malformed input refuses BEFORE any mutation, and the selected target survives ─────────
//
// These go through the real `runCli`, with three complete synthetic installations on disk
// (explicit-flag target, environment-selected target, home default) plus sentinel files in each.
//
// The original review established the unknown-option write and the pure target-loss resolution but
// explicitly did NOT prove a wrong-home publication. So the assertions below are about what is on
// disk after a refusal: no new config, no owner record, no workspace, and the pre-existing bytes of
// the installation the operator actually selected are untouched.
describe('malformed setup input refuses before any mutation', () => {

  // One case per malformed shape required by brief §8C. Each asserts: controlled nonzero exit, a
  // message naming the field, and NO new file anywhere in the three-target tree.
  // `expectMessage`, not `expect`: the latter is Jest's global and shadowing it breaks the suite.
  const malformed: Array<{ label: string; extra: string[]; expectMessage: string }> = [
    { label: 'unknown option', extra: ['--owner-idd', 'kiran'], expectMessage: 'Unknown option' },
    { label: 'bare token', extra: ['kiran'], expectMessage: 'Unexpected argument' },
    { label: 'missing value', extra: ['--state-root'], expectMessage: '--state-root requires a value' },
    { label: 'empty value', extra: ['--owner-id', '   '], expectMessage: 'requires a non-empty value' },
    { label: 'flag used as a value', extra: ['--owner-id', '--yes'], expectMessage: '--owner-id requires a value' },
    { label: 'invalid boolean', extra: ['--telegram-enabled', 'maybe'], expectMessage: '--telegram-enabled requires one of' },
    { label: 'invalid provider', extra: ['--embedding-provider', 'llamafile'], expectMessage: 'Unsupported onboard embedding provider' },
    { label: 'invalid endpoint', extra: ['--embedding-url', 'not-a-url'], expectMessage: '--embedding-url must be an absolute http or https URL' },
    // Cold re-review D1: the `=` form of a secret-bearing option must refuse without echoing the
    // value. The name is reported; everything after the first '=' must never reach output.
    { label: 'secret option in equals form', extra: ['--api-key=sk-equals-form-secret'], expectMessage: 'Unknown option: --api-key' },
    { label: 'telegram token in equals form', extra: ['--telegram-token=123:equals-form-secret'], expectMessage: 'Unknown option: --telegram-token' },
  ];

  it.each(malformed)('refuses $label before touching any target', async ({ extra, expectMessage }) => {
    const t = threeTargets();
    try {
      const before = listAll(t);
      const bytes = snapshot(t);

      const output: string[] = [];
      const code = await runCli(
        ['--config', t.selectedConfig, 'onboard', '--yes', ...extra],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      // A controlled nonzero usage/validation result — not a throw, not a hang, not a write.
      expect(code).toBe(1);
      expect(output.join('')).toContain(expectMessage);
      // Every refusal in this table must be value-free. `secret` shapes are listed above.
      expect(output.join('')).not.toContain('sk-equals-form-secret');
      expect(output.join('')).not.toContain('123:equals-form-secret');
      // No unhandled rejection, no wizard banner, no success line.
      expect(output.join('')).not.toContain('Setup complete');
      expect(output.join('')).not.toContain('Review');

      // The decisive assertion: NOTHING was created or removed anywhere, in ANY of the three
      // installations — not the explicitly selected one, not the env one, not the home default.
      expect(unexpectedPaths(t, before)).toEqual([]);
      expect(snapshot(t)).toEqual(bytes);
    } finally {
      t.restore();
    }
  });

  it('never prints a supplied secret value in a refusal', async () => {
    const t = threeTargets();
    try {
      const output: string[] = [];
      const secret = 'sk-should-never-be-echoed';
      const code = await runCli(
        ['--config', t.selectedConfig, 'onboard', '--yes', '--telegram-enabled', secret],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      expect(code).toBe(1);
      expect(output.join('')).toContain('--telegram-enabled');
      expect(output.join('')).not.toContain(secret);
    } finally {
      t.restore();
    }
  });

  it('does not echo a secret-shaped value pasted as a bare positional token', async () => {
    // Cold-review finding 2. An operator who forgets `--api-key` and pastes the key positionally
    // must not have it written to stderr and into any captured log. The refusal names the position.
    const t = threeTargets();
    try {
      const output: string[] = [];
      const secret = 'sk-pasted-as-a-positional-argument';
      const code = await runCli(
        ['--config', t.selectedConfig, 'onboard', '--yes', secret],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      expect(code).toBe(1);
      expect(output.join('')).toContain('Unexpected argument');
      expect(output.join('')).not.toContain(secret);
    } finally {
      t.restore();
    }
  });

  it.each([
    ['value position', ['--provider', '--help']],
    ['value position on --config', ['--config', '--help']],
    ['after an invalid provider', ['--provider', 'bogus', '--help']],
    ['after a retired flag', ['--force', '--help']],
  ])('refuses a help token in a %s rather than answering it with usage', async (_label, extra) => {
    // Cold-review finding 1. Only a LEADING --help is a help request; anywhere else it is either a
    // missing value or an unknown option, and must be refused with exit 1 rather than exit 0.
    const t = threeTargets();
    try {
      const before = listAll(t);
      const bytes = snapshot(t);
      const output: string[] = [];

      const code = await runCli(
        ['--config', t.selectedConfig, 'onboard', '--yes', ...extra],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      expect(code).toBe(1);
      expect(output.join('')).not.toContain('Usage: medclaw onboard [options]');
      expect(unexpectedPaths(t, before)).toEqual([]);
      expect(snapshot(t)).toEqual(bytes);
    } finally {
      t.restore();
    }
  });

  it('refuses a direct --config whose value is a help token instead of treating it as help', async () => {
    // Cold re-review D4: the injected-pair skip must not fire when `--config` has no real value.
    // Through `runCli` the first `--config` is always a resolved absolute path, but the direct
    // service entry must not gain a help-loop hole.
    const { runServiceOnboarding } = await import('../../src/cli/service-onboarding');
    const output: string[] = [];
    const code = await runServiceOnboarding(['--config', '--help', '--help'], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => '',
    });

    expect(code).toBe(1);
    expect(output.join('')).toContain('--config requires a value');
    expect(output.join('')).not.toContain('Usage: medclaw onboard [options]');
  });

  it('still answers a leading onboard --help with the option list', async () => {
    const output: string[] = [];
    const code = await runCli(['onboard', '--help'], {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => '',
    });

    expect(code).toBe(0);
    // The help text must name the independent embedding options, so parsing and help cannot drift.
    expect(output.join('')).toContain('--embedding-provider');
    expect(output.join('')).toContain('--embedding-url');
    expect(output.join('')).toContain('--embedding-api-key');
  });

  it('keeps the globally selected target when a trailing command --config has no value', async () => {
    // The R06 target-loss defect. `runCli` injects `--config <selected>` and then forwards the
    // command's own arguments; a bare trailing `--config` used to overwrite the parsed value with
    // `undefined`, after which `resolveSetupValues` fell back to the HOME default.
    //
    // The correct behavior is to REFUSE — never clear the selection and never fall back.
    const t = threeTargets();
    try {
      const before = listAll(t);
      const bytes = snapshot(t);
      const output: string[] = [];

      const code = await runCli(
        ['--config', t.selectedConfig, 'onboard', '--yes', '--provider', 'ollama', '--config'],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      expect(code).toBe(1);
      expect(output.join('')).toContain('--config requires a value');
      // The refusal must not even NAME a different target: on the baseline mechanism this line
      // named the HOME default, which is precisely the wrong-home publication path.
      expect(output.join('')).not.toContain(t.homeConfig);
      expect(output.join('')).not.toContain(t.envConfig);
      expect(unexpectedPaths(t, before)).toEqual([]);
      expect(snapshot(t)).toEqual(bytes);
    } finally {
      t.restore();
    }
  });

  it('honours a valid trailing command-level --config as the last explicit occurrence', async () => {
    // The counterpart: a well-formed later occurrence must still work, so the strict parser does
    // not simply ban the command-level position. The later explicit value wins.
    const t = threeTargets();
    try {
      const laterTarget = path.join(t.root, 'later', 'config.json');
      const output: string[] = [];

      const code = await runCli(
        [
          '--config', t.selectedConfig,
          'onboard', '--yes',
          '--provider', 'ollama',
          '--telegram-enabled', 'false',
          '--heartbeats-enabled', 'false',
          '--config', laterTarget,
        ],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      expect(code).toBe(0);
      // Written to the LAST explicit occurrence...
      expect(fs.existsSync(laterTarget)).toBe(true);
      // ...and NOT to the earlier global target, which must still not exist.
      expect(fs.existsSync(t.selectedConfig)).toBe(false);
    } finally {
      t.restore();
    }
  });

  it('refuses an empty --config in the global position instead of falling back to the home default', async () => {
    const t = threeTargets();
    try {
      const before = listAll(t);
      const bytes = snapshot(t);
      const output: string[] = [];

      const code = await runCli(['--config', '', 'onboard', '--yes'], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      });

      expect(code).toBe(1);
      expect(output.join('')).toContain('--config requires a path');
      expect(unexpectedPaths(t, before)).toEqual([]);
      expect(snapshot(t)).toEqual(bytes);
    } finally {
      t.restore();
    }
  });

  it.each([
    ['global position', ['--api-key=sk-global-equals-secret', 'status']],
    ['plain command position', ['status', '--api-key=sk-command-equals-secret']],
  ])('never echoes a secret value from an unknown option in the %s', async (_label, argv) => {
    const output: string[] = [];
    const code = await runCli(argv, {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => '',
    });

    expect(code).toBe(1);
    expect(output.join('')).toContain('Unknown option');
    expect(output.join('')).toContain('--api-key');
    expect(output.join('')).not.toContain('sk-global-equals-secret');
    expect(output.join('')).not.toContain('sk-command-equals-secret');
  });

  it.each([
    ['after -- as the command', ['--', '--api-key=sk-dash-secret']],
    ['single-dash stray on a plain command', ['status', '-sk-single-secret']],
    ['single-dash global token', ['-sk-global-secret', 'status']],
  ])('never echoes a secret-shaped option token in the %s', async (_label, argv) => {
    const output: string[] = [];
    const code = await runCli(argv, {
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
      input: async () => '',
    });

    expect(code).toBe(1);
    expect(output.join('')).not.toContain('sk-dash-secret');
    expect(output.join('')).not.toContain('sk-single-secret');
    expect(output.join('')).not.toContain('sk-global-secret');
  });

  it('keeps a plain unknown command name in the error for usefulness', async () => {
    // The sanitization above must not remove the genuinely useful typo report.
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

  it('returns a controlled refusal for an unknown GLOBAL option instead of rejecting', async () => {
    // `parseGlobalOptions` throws, and it used to be called ABOVE `runCli`'s try block, so an
    // unknown global option produced an unhandled rejection rather than an exit code.
    const t = threeTargets();
    try {
      const output: string[] = [];
      const code = await runCli(['--bogus', 'status'], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      });

      expect(code).toBe(1);
      expect(output.join('')).toContain('Unknown option');
      expect(output.join('')).toContain('--bogus');
    } finally {
      t.restore();
    }
  });

  // ── C04-P01: a refused value must NEVER be printed ─────────────────────────────────────────
  //
  // One shared table, three real entry points. The parent review reproduced 12/12 echoes: the three
  // provider roles and the owner id, through CLI noninteractive, CLI interactive-selection and the
  // direct service entry. All four refusals happen inside `runServiceOnboarding`'s single `try`,
  // before the wizard is imported, so a correct refusal must also produce ZERO prompts.
  //
  // The markers are deliberately secret-SHAPED, because that is the realistic disclosure shape, and
  // deliberately INVALID:
  //  - a provider value must not be in `ollama|openai|openrouter`;
  //  - an owner id must violate `/^[a-z0-9][a-z0-9-]{0,63}$/`. Upper-case letters do, which is why
  //    these markers are upper-case: a lower-case hyphenated `sk-…` is a VALID owner id and would
  //    refuse for the wrong reason (or not at all). `it` below proves that directly.
  const providerMarker = 'sk-P01-Pasted-Provider-Key';
  const ownerMarker = 'sk-P01-PASTED-OWNER-KEY';
  const valueFreeCases: Array<{
    label: string;
    extra: string[];
    guidance: string[];
  }> = [
    {
      label: 'main provider',
      extra: ['--provider', providerMarker],
      guidance: ['--provider', 'Unsupported onboard provider', 'ollama, openai, openrouter'],
    },
    {
      label: 'medical provider',
      extra: ['--medical-provider', providerMarker],
      guidance: ['--medical-provider', 'Unsupported onboard medical provider', 'ollama, openai, openrouter'],
    },
    {
      label: 'embedding provider',
      extra: ['--embedding-provider', providerMarker],
      guidance: ['--embedding-provider', 'Unsupported onboard embedding provider', 'ollama, openai, openrouter'],
    },
    {
      label: 'owner id',
      extra: ['--owner-id', ownerMarker],
      // The grammar itself is the guidance: an operator who typed an uppercase or spaced id is told
      // the rule, not shown their own string back.
      guidance: ['--owner-id', '/^[a-z0-9][a-z0-9-]{0,63}$/'],
    },
  ];

  // Every entry targets the FRESH selected config, including the direct service column. Cold review
  // F3: with no `--config` at all, a direct call falls back to the HOME default, which is an
  // already-enrolled fixture with sentinel bytes — so a parser that failed to refuse would be stopped
  // by the "already exists" refusal and the no-write assertion would pass for the wrong reason.
  // Pointing every entry at the fresh target means a non-refusing parser really does create files,
  // which `unexpectedPaths` then catches.
  it.each(valueFreeCases)(
    'refuses a malformed $label with useful guidance, no echoed value and no write',
    async ({ extra, guidance }) => {
      const marker = extra[extra.length - 1] as string;

      for (const entry of ['cli-noninteractive', 'cli-interactive', 'direct-service'] as const) {
        const t = threeTargets();
        try {
          const before = listAll(t);
          const bytes = snapshot(t);
          const output: string[] = [];
          let prompts = 0;
          const io = {
            stdout: (text: string): void => {
              output.push(text);
            },
            stderr: (text: string): void => {
              output.push(text);
            },
            input: async (): Promise<string> => {
              prompts += 1;
              return '';
            },
          };

          const code = await (async (): Promise<number> => {
            if (entry === 'direct-service') {
              const { runServiceOnboarding } = await import('../../src/cli/service-onboarding');
              return runServiceOnboarding(['--config', t.selectedConfig, ...extra], io);
            }
            const argv = ['--config', t.selectedConfig, 'onboard'];
            if (entry === 'cli-noninteractive') argv.push('--yes');
            argv.push(...extra);
            return runCli(argv, io);
          })();

          // Every assertion below is wrapped in an object that names the entry point, because this
          // one case runs the same refusal three ways and a bare failure would not say which failed.
          const seen = { entry, printed: output.join(''), prompts, code };

          // The refusal is controlled and nonzero, on every entry point.
          expect(seen).toMatchObject({ code: 1 });
          // The decisive P01 assertion comes FIRST: the supplied value must never be printed, on
          // either stream. Asserting this before the guidance fragments means a future regression
          // fails on the disclosure itself instead of on a downstream wording change.
          expect(seen.printed.includes(marker)).toBe(false);
          // Useful: the rejected field/role is named, and the operator still gets the supported set
          // or the owner grammar. This is what replaces the value echo as the useful part.
          for (const fragment of guidance) {
            expect({ entry, printed: seen.printed }).toMatchObject({
              printed: expect.stringContaining(fragment),
            });
          }
          // No wizard: a refusal before the IO boundary means zero prompts.
          expect(seen.prompts).toBe(0);
          expect(seen.printed).not.toContain('Setup complete');
          // No new directory, lease, template, owner record or config in ANY of the three targets,
          // and the existing installations keep their sentinel bytes exactly.
          expect(unexpectedPaths(t, before)).toEqual([]);
          expect(snapshot(t)).toEqual(bytes);
        } finally {
          t.restore();
        }
      }
    },
  );

  it('accepts a lower-case hyphenated owner id and normalizes surrounding whitespace', async () => {
    // The control for the marker choice above, and the guard against over-tightening.
    //
    // `sk-p01-pasted-owner-key` DOES satisfy `/^[a-z0-9][a-z0-9-]{0,63}$/`, so it is a legal owner
    // id. A refusal rule written around "looks like a key" would break this supported flow; a rule
    // written around the actual grammar accepts it. Surrounding whitespace is trimmed, so the
    // persisted identity is the normalized id and not the padded one.
    const t = threeTargets();
    try {
      const target = path.join(t.root, 'owner-normalized', 'config.json');
      const output: string[] = [];

      const code = await runCli(
        [
          '--config', target,
          'onboard', '--yes',
          '--provider', 'ollama',
          '--owner-id', '  sk-p01-pasted-owner-key  ',
          '--telegram-enabled', 'false',
          '--heartbeats-enabled', 'false',
        ],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      expect(code).toBe(0);
      expect(output.join('')).not.toContain('Invalid --owner-id');
      const reloaded = await loadRuntimeConfig({ configPath: target });
      expect(reloaded.profiles.defaultProfileId).toBe('sk-p01-pasted-owner-key');
    } finally {
      t.restore();
    }
  });

  it('still creates the intended installation and reloads it for a valid invocation', async () => {
    // The positive counterpart. A refusal-everything parser would pass every case above; this is
    // what proves the strictness did not break the supported flow.
    const t = threeTargets();
    try {
      const target = path.join(t.root, 'fresh', 'config.json');
      const output: string[] = [];

      const code = await runCli(
        [
          '--config', target,
          'onboard', '--yes',
          '--provider', 'ollama',
          '--owner-id', 'kiran',
          '--telegram-enabled', 'false',
          '--heartbeats-enabled', 'false',
        ],
        {
          stdout: (text: string) => output.push(text),
          stderr: (text: string) => output.push(text),
          input: async () => '',
        },
      );

      expect(code).toBe(0);
      expect(fs.existsSync(target)).toBe(true);
      const reloaded = await loadRuntimeConfig({ configPath: target });
      expect(reloaded.profiles).toEqual({
        baseDir: path.join(t.root, 'fresh'),
        defaultProfileId: 'kiran',
      });
      // The unselected installations keep their sentinel bytes.
      expect(fs.readFileSync(t.homeConfig, 'utf8')).toContain('// sentinel-home');
      expect(fs.readFileSync(t.envConfig, 'utf8')).toContain('// sentinel-env');
    } finally {
      t.restore();
    }
  });
});
// ── C04-P02: a malformed leading --config value cannot become a SUCCESSFUL help request ────────
//
// `runCli` forwards `['--config', <already-resolved absolute path>, ...operatorArgs]`, so the
// injected pair must be skipped without complaint. But the skip predicate in
// `service-onboarding.ts` also accepted a pair whose VALUE was empty or whitespace, so a DIRECT
// service call with `['--config', '', '--help']` skipped a pair that carried no path and answered
// the next token with usage on stdout at exit 0.
//
// 0 is a success status. A malformed option value must never report success. These cases pin the
// refusal, and pin the legitimate help paths that must keep working.
describe('a malformed leading --config value refuses instead of answering with help', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
  ])('refuses a leading --config with a %s value at the direct service entry', async (_label, value) => {
    const t = threeTargets();
    try {
      const before = listAll(t);
      const bytes = snapshot(t);
      const output: string[] = [];
      let prompts = 0;
      const { runServiceOnboarding } = await import('../../src/cli/service-onboarding');

      const code = await runServiceOnboarding(['--config', value, '--help'], {
        stdout: (text: string): void => {
          output.push(text);
        },
        stderr: (text: string): void => {
          output.push(text);
        },
        input: async (): Promise<string> => {
          prompts += 1;
          return '';
        },
      });

      // Controlled nonzero usage result, not a success status.
      expect(code).toBe(1);
      // Field-specific: the refusal names `--config`, which is what an operator must change.
      expect(output.join('')).toContain('--config');
      // And it must NOT be answered with the option list, on either stream.
      expect(output.join('')).not.toContain('Usage: medclaw onboard [options]');
      expect(prompts).toBe(0);
      // Crucially, the malformed value must not have been swapped for the home default, so the home
      // and env installations keep their sentinel bytes and nothing new appears anywhere.
      expect(unexpectedPaths(t, before)).toEqual([]);
      expect(snapshot(t)).toEqual(bytes);
    } finally {
      t.restore();
    }
  });

  it('refuses a leading --config whose value is the help token itself', async () => {
    // The counterpart that must NOT change: a help token in a VALUE position is a missing value,
    // never a help request. This is the other side of the same pair-skip predicate.
    const t = threeTargets();
    try {
      const before = listAll(t);
      const bytes = snapshot(t);
      const output: string[] = [];
      const { runServiceOnboarding } = await import('../../src/cli/service-onboarding');

      const code = await runServiceOnboarding(['--config', '--help'], {
        stdout: (text: string): void => {
          output.push(text);
        },
        stderr: (text: string): void => {
          output.push(text);
        },
        input: async () => '',
      });

      expect(code).toBe(1);
      expect(output.join('')).toContain('--config requires a value');
      expect(output.join('')).not.toContain('Usage: medclaw onboard [options]');
      expect(unexpectedPaths(t, before)).toEqual([]);
      expect(snapshot(t)).toEqual(bytes);
    } finally {
      t.restore();
    }
  });

  // `@SELECTED@` is substituted with the fresh selected target just before the call. A placeholder is
  // used instead of a builder callback so no case carries a parameter it does not need.
  it.each([
    ['direct leading --help', ['--help']],
    ['direct leading -h', ['-h']],
    ['direct valid config then leading help', ['--config', '@SELECTED@', '--help']],
    ['direct valid config then leading -h', ['--config', '@SELECTED@', '-h']],
  ] as Array<[string, string[]]>)(
    'still answers %s with the option list at exit 0 and writes nothing',
    async (_label, template) => {
      // The positive counterpart. Validating the leading pair must not turn legitimate help into a
      // refusal; if it did, every case above would "pass" for the wrong reason.
      const t = threeTargets();
      try {
        const before = listAll(t);
        const bytes = snapshot(t);
        const output: string[] = [];
        let prompts = 0;
        const io = {
          stdout: (text: string): void => {
            output.push(text);
          },
          stderr: (text: string): void => {
            output.push(text);
          },
          input: async (): Promise<string> => {
            prompts += 1;
            return '';
          },
        };

        const { runServiceOnboarding } = await import('../../src/cli/service-onboarding');
        const argv = template.map((token) => (token === '@SELECTED@' ? t.selectedConfig : token));
        const code = await runServiceOnboarding(argv, io);

        expect(code).toBe(0);
        expect(output.join('')).toContain('Usage: medclaw onboard [options]');
        // The help text must still be able to explain the setup options.
        expect(output.join('')).toContain('--embedding-provider');
        expect(output.join('')).toContain('--owner-id');
        expect(prompts).toBe(0);
        expect(unexpectedPaths(t, before)).toEqual([]);
        expect(snapshot(t)).toEqual(bytes);
      } finally {
        t.restore();
      }
    },
  );

  it('still routes CLI onboard --help through the injected pair without writing', async () => {
    // The full real entry point, so the injected-pair skip is exercised the way `runCli` builds it
    // rather than by hand. `runCli` resolves the target from the flag, then injects it.
    const t = threeTargets();
    try {
      const before = listAll(t);
      const bytes = snapshot(t);
      const output: string[] = [];

      const code = await runCli(['--config', t.selectedConfig, 'onboard', '--help'], {
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => output.push(text),
        input: async () => '',
      });

      expect(code).toBe(0);
      expect(output.join('')).toContain('Usage: medclaw onboard [options]');
      expect(unexpectedPaths(t, before)).toEqual([]);
      expect(snapshot(t)).toEqual(bytes);
    } finally {
      t.restore();
    }
  });
});
