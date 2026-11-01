
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { InstallationService } from '../../src/runtime/installation';
import type { OwnerStateStoreFactory } from '../../src/runtime/installation';
import { DirectoryLease, leasePathFor } from '../../src/runtime/adapters/directory-lease';
import { FileOwnerStatePort } from '../../src/runtime/adapters/owner-state-file';
import type { OwnerStateRead, OwnerStateWriteResult } from '../../src/ports/owner-state';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { resolveOwnerPaths, asProfileId } from '../../src/profiles';
import type { ProfileId } from '../../src/profiles';
import type { EffectiveConfig } from '../../src/config';
import { makeTestTemp } from '../helpers/test-temp';

const DEFAULT_HOME_CONTENDER = path.join(__dirname, '..', 'helpers', 'setup-default-home-contender.ts');

const liveChildren = new Set<ChildProcess>();

function prospectiveSetup(rootDir: string): {
  configPath: string;
  ownerId: ProfileId;
  config: EffectiveConfig;
  ownerPaths: ReturnType<typeof resolveOwnerPaths>;
} {
  const ownerId = asProfileId('default') as ProfileId;
  const baseDir = path.join(rootDir, 'state');
  const ownerPaths = resolveOwnerPaths(baseDir, ownerId);
  const configPath = path.join(rootDir, 'config.json');

  const config = {
    schemaVersion: 2,
    profiles: { baseDir, defaultProfileId: 'default' },
    memory: { workspace: ownerPaths.workspace },
    heartbeat: { storePath: ownerPaths.schedulerStore },
    providers: { main: { type: 'ollama' } },
    channels: { telegram: { enabled: false } },
  } as unknown as EffectiveConfig;

  return { configPath, ownerId, config, ownerPaths };
}

// `resolveSetupValues` derives the state root, so the config parent and workspace root are one directory.
function absentParentSetup(
  syntheticHome: string,
  ownerId: ProfileId,
  parentSegments: string[] = ['.redacted'],
): {
  configPath: string;
  baseDir: string;
  ownerId: ProfileId;
  config: EffectiveConfig;
  ownerPaths: ReturnType<typeof resolveOwnerPaths>;
} {
  const baseDir = path.join(syntheticHome, ...parentSegments);
  const ownerPaths = resolveOwnerPaths(baseDir, ownerId);
  const configPath = path.join(baseDir, 'config.json');

  const config = {
    schemaVersion: 2,
    profiles: { baseDir, defaultProfileId: ownerId },
    memory: { workspace: ownerPaths.workspace },
    heartbeat: { storePath: ownerPaths.schedulerStore },
    providers: { main: { type: 'ollama' } },
    channels: { telegram: { enabled: false } },
  } as unknown as EffectiveConfig;

  return { configPath, baseDir, ownerId, config, ownerPaths };
}

function modeOf(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

describe('installation setup holds both leases across its commit', () => {
  let root: string;
  beforeEach(() => {
    root = makeTestTemp('setup-lease');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('REFUSES when a running daemon already holds the owner workspace lease', async () => {
    const { configPath, ownerId, config, ownerPaths } = prospectiveSetup(root);

    fs.mkdirSync(path.dirname(ownerPaths.workspaceLease), { recursive: true, mode: 0o700 });
    const daemon = new DirectoryLease();
    const held = await daemon.tryAcquire({
      kind: 'owner',
      canonicalPath: ownerPaths.workspace,
      leasePath: ownerPaths.workspaceLease,
    });
    expect(held.kind).toBe('acquired');

    try {
      const service = new InstallationService(new DirectoryLease());
      const outcome = await service.setup({ configPath, config, ownerId });

      if (outcome.kind !== 'busy') throw new Error(`expected busy, got ${outcome.kind}`);
      expect(outcome.resource).toBe('owner');
      expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(false);
      expect(fs.existsSync(configPath)).toBe(false);
    } finally {
      if (held.kind === 'acquired') await held.release();
    }
  });

  it('REFUSES when the config lease is already held, and writes nothing', async () => {
    const { configPath, ownerId, config, ownerPaths } = prospectiveSetup(root);

    const holder = new DirectoryLease();
    const held = await holder.tryAcquire({ kind: 'config', canonicalPath: path.resolve(configPath) });
    expect(held.kind).toBe('acquired');

    try {
      const service = new InstallationService(new DirectoryLease());
      const outcome = await service.setup({ configPath, config, ownerId });

      if (outcome.kind !== 'busy') throw new Error(`expected busy, got ${outcome.kind}`);
      expect(outcome.resource).toBe('config');
      expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(false);
      expect(fs.existsSync(configPath)).toBe(false);
    } finally {
      if (held.kind === 'acquired') await held.release();
    }
  });

});

describe('setup tells the truth about the owner record it published', () => {
  let root: string;
  beforeEach(() => {
    root = makeTestTemp('setup-owner-record-truth');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A store whose replacement throws before touching the filesystem, so the publication is unknown. */
  function storeThrowingBeforeWriting(): OwnerStateStoreFactory {
    return (ownerRecordPath, ownerId) => {
      const real = new FileOwnerStatePort(ownerRecordPath, ownerId);
      return {
        read: (): OwnerStateRead => real.read(),
        replace: async (): Promise<OwnerStateWriteResult> => {
          throw new Error('injected lost acknowledgement before any write');
        },
      };
    };
  }

  it('never reports success when the owner record publication was not confirmed', async () => {
    const { configPath, ownerId, config, ownerPaths } = prospectiveSetup(root);

    const outcome = await new InstallationService(new DirectoryLease(), {
      ownerStore: storeThrowingBeforeWriting(),
    }).setup({ configPath, config, ownerId });

    expect(outcome.kind).toBe('incomplete');
    if (outcome.kind !== 'incomplete') return;
    expect(outcome.message).not.toMatch(/setup complete|wrote the owner record/i);
    expect(outcome.message).toMatch(/could not be read back/i);
    expect(outcome.message).toMatch(/--state-root/);

    expect(new FileOwnerStatePort(ownerPaths.ownerRecord, ownerId).read().kind).toBe('missing');
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(leasePathFor(path.resolve(configPath)))).toBe(false);
    expect(fs.existsSync(ownerPaths.workspaceLease)).toBe(false);

    const retry = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });
    expect(retry.kind).toBe('not-fresh');
  });
});

describe('setup acquires its leases into a target whose structural parents are absent', () => {
  let root: string;
  beforeEach(() => {
    root = makeTestTemp('setup-absent-parent');
  });
  afterEach(() => {
    for (const child of liveChildren) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    liveChildren.clear();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* permissions restored by the case itself where relevant */
    }
  });

  it('commits the advertised first run, reloads it through the real decoder, and re-owns it', async () => {
    const syntheticHome = path.join(root, 'synthetic-home');
    fs.mkdirSync(syntheticHome, { mode: 0o700 });
    const ownerId = asProfileId('default') as ProfileId;
    const { configPath, ownerPaths, config } = absentParentSetup(syntheticHome, ownerId);

    expect(fs.existsSync(path.dirname(configPath))).toBe(false);
    expect(fs.existsSync(ownerPaths.workspace)).toBe(false);

    const outcome = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });

    if (outcome.kind !== 'committed') {
      throw new Error(`expected committed, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.canonicalConfigPath).toBe(configPath);

    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(true);
    expect(fs.existsSync(path.join(ownerPaths.workspace, 'SOUL.md'))).toBe(true);
    expect(fs.existsSync(path.join(ownerPaths.workspace, 'conditions'))).toBe(true);

    expect(modeOf(path.dirname(configPath))).toBe(0o700);
    expect(modeOf(path.join(syntheticHome, '.redacted', 'profiles'))).toBe(0o700);
    expect(modeOf(ownerPaths.workspace)).toBe(0o700);
    expect(modeOf(configPath)).toBe(0o600);
    expect(modeOf(ownerPaths.ownerRecord)).toBe(0o600);
    expect(modeOf(path.join(ownerPaths.workspace, 'SOUL.md'))).toBe(0o600);

    const reloaded = await loadRuntimeConfig({ configPath, homeDir: syntheticHome });
    expect(reloaded.profiles.defaultProfileId).toBe(ownerId);
    expect(reloaded.profiles.baseDir).toBe(path.dirname(configPath));
    expect(reloaded.memory.workspace).toBe(ownerPaths.workspace);

    const owned = await new InstallationService(new DirectoryLease()).acquireOwnership(configPath, syntheticHome);
    expect(owned.kind).toBe('owned');
    if (owned.kind !== 'owned') return;
    expect(fs.existsSync(leasePathFor(configPath))).toBe(true);
    expect(fs.existsSync(ownerPaths.workspaceLease)).toBe(true);
    await owned.ownership.release();
    expect(fs.existsSync(leasePathFor(configPath))).toBe(false);
    expect(fs.existsSync(ownerPaths.workspaceLease)).toBe(false);
  });

  it('refuses a non-directory config parent with a bounded message and creates nothing', async () => {
    const syntheticHome = path.join(root, 'synthetic-home');
    fs.mkdirSync(syntheticHome, { mode: 0o700 });
    const blocker = path.join(syntheticHome, 'blocked');
    fs.writeFileSync(blocker, 'synthetic non-directory', { mode: 0o600 });

    const ownerId = asProfileId('default') as ProfileId;
    const baseDir = path.join(blocker, 'nested');
    const ownerPaths = resolveOwnerPaths(baseDir, ownerId);
    const config = {
      schemaVersion: 2,
      profiles: { baseDir, defaultProfileId: ownerId },
      memory: { workspace: ownerPaths.workspace },
      heartbeat: { storePath: ownerPaths.schedulerStore },
      providers: { main: { type: 'ollama' } },
      channels: { telegram: { enabled: false } },
    } as unknown as EffectiveConfig;

    const outcome = await new InstallationService(new DirectoryLease()).setup({
      configPath: path.join(baseDir, 'config.json'),
      config,
      ownerId,
    });

    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toBe('unsafe-parent');
    expect(outcome.guidance).toContain('not a directory');
    expect(outcome.guidance).toContain('Choose a different');
    expect(outcome.guidance).not.toContain('Create the installation directory');
    expect(fs.existsSync(baseDir)).toBe(false);
    expect(fs.readFileSync(blocker, 'utf8')).toBe('synthetic non-directory');
  });

  it('leaves prior owner content untouched when setup refuses it as not fresh', async () => {
    const syntheticHome = path.join(root, 'synthetic-home');
    fs.mkdirSync(syntheticHome, { mode: 0o700 });
    const ownerId = asProfileId('default') as ProfileId;
    const { configPath, config, ownerPaths } = absentParentSetup(syntheticHome, ownerId);

    fs.mkdirSync(ownerPaths.workspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ownerPaths.workspace, 'MEMORY.md'), 'synthetic prior owner content', { mode: 0o600 });

    const outcome = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });

    expect(outcome.kind).toBe('not-fresh');
    expect(fs.readFileSync(path.join(ownerPaths.workspace, 'MEMORY.md'), 'utf8')).toBe(
      'synthetic prior owner content',
    );
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(false);
    expect(fs.existsSync(path.join(ownerPaths.workspace, 'SOUL.md'))).toBe(false);
  });

  it('completes the real default first run when the home config parent has never existed', async () => {
    const syntheticHome = path.join(root, 'synthetic-home');
    fs.mkdirSync(syntheticHome, { mode: 0o700 });
    const expectedConfigPath = path.join(syntheticHome, '.redacted', 'config.json');
    expect(fs.existsSync(path.dirname(expectedConfigPath))).toBe(false);

    const result = await new Promise<{
      exit: number;
      selectedPath: string;
      stdoutClaimsSetupComplete: boolean;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', DEFAULT_HOME_CONTENDER], {
        cwd: path.join(__dirname, '..', '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: syntheticHome, REDACTED_CONFIG_PATH: '', TELEGRAM_BOT_TOKEN: '' },
      });
      liveChildren.add(child);
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => { out += String(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { out += String(chunk); });
      child.on('error', reject);
      child.on('close', () => {
        liveChildren.delete(child);
        const line = out.split('\n').filter((l) => l.startsWith('{')).pop();
        if (!line) return reject(new Error(`default-home contender produced no result: ${out}`));
        resolve(JSON.parse(line));
      });
    });

    expect(result.selectedPath).toBe(expectedConfigPath);
    expect(result.exit).toBe(0);
    expect(result.stdoutClaimsSetupComplete).toBe(true);
    expect(result.stderr).toBe('');

    const ownerPaths = resolveOwnerPaths(path.dirname(expectedConfigPath), 'default' as ProfileId);
    expect(fs.existsSync(expectedConfigPath)).toBe(true);
    expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(true);
    expect(fs.existsSync(path.join(ownerPaths.workspace, 'HEALTH_PROFILE.md'))).toBe(true);
    expect(modeOf(path.dirname(expectedConfigPath))).toBe(0o700);
    expect(modeOf(expectedConfigPath)).toBe(0o600);
    expect(modeOf(ownerPaths.ownerRecord)).toBe(0o600);

    const reloaded = await loadRuntimeConfig({ configPath: expectedConfigPath, homeDir: syntheticHome });
    expect(reloaded.memory.workspace).toBe(ownerPaths.workspace);
  }, 60_000);
});
