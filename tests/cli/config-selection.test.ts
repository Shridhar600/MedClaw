// Every CLI command operates on the installation the operator selected, through the precedence
// `--config > REDACTED_CONFIG_PATH > ~/.redacted/config.json`, and a malformed invocation changes nothing.
// Real `runCli` entry point and real fixtures on disk.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli/index';
import { runServiceOnboarding } from '../../src/cli/service-onboarding';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { writeConfigFixture } from '../helpers/config-fixture';
import { makeTestTemp } from '../helpers/test-temp';

interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  input: () => Promise<string>;
}

function captureIo(): { io: Io; text: () => string; prompts: () => number } {
  const output: string[] = [];
  let prompts = 0;
  return {
    io: {
      stdout: (text: string): void => { output.push(text); },
      stderr: (text: string): void => { output.push(text); },
      input: async (): Promise<string> => { prompts += 1; return ''; },
    },
    text: () => output.join(''),
    prompts: () => prompts,
  };
}

/** Points HOME and REDACTED_CONFIG_PATH at fixtures; `restore` undoes both and removes the temp root. */
function selectEnvironment(root: string, homeDir: string, envConfigPath: string): () => void {
  const originalHome = process.env.HOME;
  const originalEnv = process.env.REDACTED_CONFIG_PATH;
  process.env.HOME = homeDir;
  process.env.REDACTED_CONFIG_PATH = envConfigPath;
  return () => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalEnv === undefined) delete process.env.REDACTED_CONFIG_PATH; else process.env.REDACTED_CONFIG_PATH = originalEnv;
    fs.rmSync(root, { recursive: true, force: true });
  };
}

describe('CLI honours the locked configuration selection order everywhere', () => {
  let envConfigPath: string;
  let envOwnerRecord: string;
  let homeConfigPath: string;
  let homeOwnerRecord: string;
  let restore: () => void;

  beforeEach(async () => {
    const root = makeTestTemp('cli-config-selection');
    const homeDir = path.join(root, 'home');
    const envFixture = writeConfigFixture(path.join(root, 'alternate'), { ownerId: 'alternate-owner' });
    const homeFixture = writeConfigFixture(path.join(homeDir, '.redacted'), { ownerId: 'home-default-owner' });
    envConfigPath = envFixture.configPath;
    envOwnerRecord = envFixture.ownerRecord;
    homeConfigPath = homeFixture.configPath;
    homeOwnerRecord = homeFixture.ownerRecord;

    // Only the selected installation gets an unpaired owner record, so a pairing code that lands
    // anywhere else would have nothing to write into.
    const { FileOwnerStatePort } = await import('../../src/runtime/adapters/owner-state-file');
    const { CryptoPairingCodePort } = await import('../../src/runtime/adapters/pairing-code');
    const { OwnerAdmissionService, asProfileId } = await import('../../src/profiles');
    const { systemClock } = await import('../../src/ports/defaults');
    const id = asProfileId(envFixture.ownerId)!;
    await new OwnerAdmissionService({
      store: new FileOwnerStatePort(envOwnerRecord, id),
      codes: new CryptoPairingCodePort(),
      clock: systemClock,
      expectedOwnerId: id,
    }).initialize();

    restore = selectEnvironment(root, homeDir, envConfigPath);
  });

  afterEach(() => restore());

  it('config show, status and pairing issue use the REDACTED_CONFIG_PATH installation, and an explicit --config outranks it', async () => {
    const show = captureIo();
    expect(await runCli(['config', 'show'], show.io)).toBe(0);
    expect(show.text()).toContain('alternate-owner');
    expect(show.text()).not.toContain('home-default-owner');

    const status = captureIo();
    expect(await runCli(['status'], status.io)).toBe(0);
    expect(status.text()).toContain(envConfigPath);

    const explicit = captureIo();
    expect(await runCli(['--config', homeConfigPath, 'config', 'show'], explicit.io)).toBe(0);
    expect(explicit.text()).toContain('home-default-owner');
    expect(explicit.text()).not.toContain('alternate-owner');

    const pairing = captureIo();
    expect(await runCli(['pairing', 'issue'], pairing.io)).toBe(0);
    expect(pairing.text()).toContain('Pairing code issued');
    expect(fs.existsSync(envOwnerRecord)).toBe(true);
    expect(fs.existsSync(homeOwnerRecord)).toBe(false);
  });

  it('config set mutates the environment-selected installation and leaves the home default byte-identical', async () => {
    const before = fs.readFileSync(homeConfigPath, 'utf8');

    const { io } = captureIo();
    expect(await runCli(['config', 'set', 'providers.main.baseUrl', 'http://127.0.0.1:11434'], io)).toBe(0);

    expect(fs.readFileSync(envConfigPath, 'utf8')).toContain('127.0.0.1:11434');
    expect(fs.readFileSync(homeConfigPath, 'utf8')).toBe(before);
  });
});

describe('a malformed invocation refuses before any mutation and never echoes a pasted value', () => {
  let root: string;
  let selectedConfig: string;
  let envConfig: string;
  let homeConfig: string;
  let restore: () => void;

  /** Every file under the temp root plus the bytes of the two pre-existing installations. */
  const snapshot = (): { files: string[]; env: string; home: string } => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full); else files.push(path.relative(root, full));
      }
    };
    walk(root);
    return { files: files.sort(), env: fs.readFileSync(envConfig, 'utf8'), home: fs.readFileSync(homeConfig, 'utf8') };
  };

  // The explicitly selected target is fresh, so a parser that lets malformed input through really creates files.
  beforeEach(() => {
    root = makeTestTemp('cli-malformed');
    const homeDir = path.join(root, 'home');
    selectedConfig = path.join(root, 'selected', 'config.json');
    envConfig = writeConfigFixture(path.join(root, 'env-selected'), { ownerId: 'env-owner' }).configPath;
    homeConfig = writeConfigFixture(path.join(homeDir, '.redacted'), { ownerId: 'home-owner' }).configPath;
    fs.appendFileSync(envConfig, '\n// sentinel-env\n');
    fs.appendFileSync(homeConfig, '\n// sentinel-home\n');
    restore = selectEnvironment(root, homeDir, envConfig);
  });

  afterEach(() => restore());

  const providerMarker = 'sk-Pasted-Provider-Key';
  const ownerMarker = 'sk-PASTED-OWNER-KEY';
  const onboard = (...extra: string[]) => (selected: string): string[] => ['--config', selected, 'onboard', '--yes', ...extra];

  type Row = {
    label: string;
    argv: (selected: string) => string[];
    entry?: 'cli' | 'service';
    contains: string[];
    secrets?: string[];
  };

  const valueFree = (label: string, flag: string, marker: string, guidance: string[]): Row[] => [
    { label: `${label} (cli)`, argv: onboard(flag, marker), contains: [flag, ...guidance], secrets: [marker] },
    { label: `${label} (direct service)`, argv: (selected) => ['--config', selected, flag, marker], entry: 'service', contains: [flag, ...guidance], secrets: [marker] },
  ];
  const supported = 'ollama, openai, openrouter';

  const refusals: Row[] = [
    { label: 'an unknown option', argv: onboard('--owner-idd', 'kiran'), contains: ['Unknown option'] },
    { label: 'a bare token', argv: onboard('kiran'), contains: ['Unexpected argument'] },
    { label: 'a secret pasted as a bare token', argv: onboard('sk-pasted-as-a-positional-argument'), contains: ['Unexpected argument'], secrets: ['sk-pasted-as-a-positional-argument'] },
    { label: 'a missing value', argv: onboard('--state-root'), contains: ['--state-root requires a value'] },
    { label: 'an empty value', argv: onboard('--owner-id', '   '), contains: ['requires a non-empty value'] },
    { label: 'a flag used as a value', argv: onboard('--owner-id', '--yes'), contains: ['--owner-id requires a value'] },
    { label: 'an invalid boolean holding a secret-shaped value', argv: onboard('--telegram-enabled', 'sk-should-never-be-echoed'), contains: ['--telegram-enabled'], secrets: ['sk-should-never-be-echoed'] },
    { label: 'an invalid endpoint', argv: onboard('--embedding-url', 'not-a-url'), contains: ['--embedding-url must be an absolute http or https URL'] },
    { label: 'an api key in equals form', argv: onboard('--api-key=sk-equals-form-secret'), contains: ['Unknown option: --api-key'], secrets: ['sk-equals-form-secret'] },
    { label: 'a telegram token in equals form', argv: onboard('--telegram-token=123:equals-form-secret'), contains: ['Unknown option: --telegram-token'], secrets: ['123:equals-form-secret'] },
    { label: 'a help token as a value', argv: onboard('--provider', '--help'), contains: [] },
    { label: 'a help token as a --config value', argv: onboard('--config', '--help'), contains: [] },
    { label: 'a help token after an invalid provider', argv: onboard('--provider', 'bogus', '--help'), contains: [] },
    { label: 'a help token after a retired flag', argv: onboard('--force', '--help'), contains: [] },
    { label: 'a trailing --config without a value', argv: onboard('--provider', 'ollama', '--config'), contains: ['--config requires a value'] },
    { label: 'an empty global --config', argv: () => ['--config', '', 'onboard', '--yes'], contains: ['--config requires a path'] },
    { label: 'a direct empty leading --config', argv: () => ['--config', '', '--help'], entry: 'service', contains: ['--config'] },
    { label: 'a direct whitespace leading --config', argv: () => ['--config', '   ', '--help'], entry: 'service', contains: ['--config'] },
    { label: 'a direct --config whose value is the help token', argv: () => ['--config', '--help'], entry: 'service', contains: ['--config requires a value'] },
    ...valueFree('a malformed main provider', '--provider', providerMarker, ['Unsupported onboard provider', supported]),
    ...valueFree('a malformed medical provider', '--medical-provider', providerMarker, ['Unsupported onboard medical provider', supported]),
    ...valueFree('a malformed embedding provider', '--embedding-provider', providerMarker, ['Unsupported onboard embedding provider', supported]),
    ...valueFree('a malformed owner id', '--owner-id', ownerMarker, ['/^[a-z0-9][a-z0-9-]{0,63}$/']),
  ];

  it.each(refusals)('refuses $label', async ({ argv, entry = 'cli', contains, secrets = [] }) => {
    const before = snapshot();
    const { io, text, prompts } = captureIo();
    const args = argv(selectedConfig);

    const code = entry === 'service' ? await runServiceOnboarding(args, io) : await runCli(args, io);

    expect(code).toBe(1);
    for (const secret of secrets) expect(text()).not.toContain(secret);
    for (const fragment of contains) expect(text()).toContain(fragment);
    expect(text()).not.toContain('Usage: medclaw onboard [options]');
    expect(text()).not.toContain('Setup complete');
    expect(text()).not.toContain(homeConfig);
    expect(prompts()).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ['an unknown option in the global position', ['--api-key=sk-global-equals-secret', 'status'], ['Unknown option', '--api-key']],
    ['an unknown option after a plain command', ['status', '--api-key=sk-command-equals-secret'], ['Unknown option', '--api-key']],
    ['a token after --', ['--', '--api-key=sk-dash-secret'], []],
    ['a single-dash stray on a plain command', ['status', '-sk-single-secret'], []],
    ['a single-dash global token', ['-sk-global-secret', 'status'], []],
    ['an unknown global option', ['--bogus', 'status'], ['Unknown option', '--bogus']],
    ['an unknown command (kept in the message)', ['bogus'], ['Unknown command', 'bogus']],
  ])('returns a controlled refusal for %s without echoing a secret', async (_label, argv, contains) => {
    const { io, text } = captureIo();

    const code = await runCli(argv, io);

    expect(code).toBe(1);
    for (const fragment of contains) expect(text()).toContain(fragment);
    expect(text()).not.toMatch(/sk-(global|command|dash|single)[-a-z]*secret/);
  });

  it.each([
    ['onboard --help through runCli', 'cli', ['--config', '@SELECTED@', 'onboard', '--help']],
    ['a direct leading --help', 'service', ['--help']],
    ['a direct leading -h', 'service', ['-h']],
    ['a direct valid --config then --help', 'service', ['--config', '@SELECTED@', '--help']],
  ] as const)('still answers %s with the option list and writes nothing', async (_label, entry, template) => {
    const before = snapshot();
    const { io, text, prompts } = captureIo();
    const args = template.map((token) => (token === '@SELECTED@' ? selectedConfig : token));

    const code = entry === 'service' ? await runServiceOnboarding(args, io) : await runCli(args, io);

    expect(code).toBe(0);
    expect(text()).toContain('Usage: medclaw onboard [options]');
    expect(text()).toContain('--embedding-provider');
    expect(text()).toContain('--embedding-api-key');
    expect(text()).toContain('--owner-id');
    expect(prompts()).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it('still creates the intended installation: the last explicit --config wins and the owner id is trimmed', async () => {
    const laterTarget = path.join(root, 'later', 'config.json');
    const { io, text } = captureIo();

    const code = await runCli([
      '--config', selectedConfig, 'onboard', '--yes', '--provider', 'ollama',
      '--owner-id', '  sk-pasted-owner-key  ', '--telegram-enabled', 'false', '--heartbeats-enabled', 'false',
      '--config', laterTarget,
    ], io);

    expect(code).toBe(0);
    expect(text()).not.toContain('Invalid --owner-id');
    expect(fs.existsSync(selectedConfig)).toBe(false);
    const reloaded = await loadRuntimeConfig({ configPath: laterTarget });
    expect(reloaded.profiles).toEqual({ baseDir: path.join(root, 'later'), defaultProfileId: 'sk-pasted-owner-key' });
    expect(fs.readFileSync(homeConfig, 'utf8')).toContain('// sentinel-home');
    expect(fs.readFileSync(envConfig, 'utf8')).toContain('// sentinel-env');
  });
});
