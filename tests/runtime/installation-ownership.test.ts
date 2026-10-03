// tests/runtime/installation-ownership.test.ts
//
// The protected invariant: exactly one local process at a time owns a MedClaw installation.
//
// Real collaborators throughout — the real `InstallationService`, the real directory lease, the
// real `config set` writer, the real `Gateway` shutdown disposition — and real OS processes for
// the contention cases, released together by an IPC barrier. Nothing here mocks the ownership
// model.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InstallationService, describeOwnershipRefusal } from '../../src/runtime/installation';
import { DirectoryLease, leasePathFor, readHolder } from '../../src/runtime/adapters/directory-lease';
import { setConfigValue } from '../../src/cli/admin';
import { writeConfigFixture } from '../helpers/config-fixture';
import { fixtureOwner } from '../helpers/test-config';

const CONTENDER = path.join(__dirname, '..', 'helpers', 'ownership-contender.ts');

interface ContenderResult {
  label: string;
  outcome: 'owned' | 'busy' | 'unavailable' | 'invalid-config' | 'error';
  resource?: string;
  reason?: string;
}

/**
 * Every child spawned by this suite, so a failing assertion can never leave a contender spinning
 * on its barrier and holding the Jest process open.
 */
const liveChildren = new Set<import('child_process').ChildProcess>();

function killAllChildren(): void {
  for (const child of liveChildren) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  liveChildren.clear();
}

function spawnContender(
  label: string,
  configPath: string,
  barrierFile: string,
  releaseMarker: string,
  env: NodeJS.ProcessEnv = {},
): Promise<ContenderResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CONTENDER, label, configPath, barrierFile, '20000'],
      {
        cwd: path.join(__dirname, '..', '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env, SOCS_RELEASE_MARKER: releaseMarker },
      },
    );
    liveChildren.add(child);
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { out += String(c); });
    child.on('error', reject);
    child.on('close', () => {
      liveChildren.delete(child);
      const line = out.split('\n').filter((l) => l.startsWith('{')).pop();
      if (!line) return reject(new Error(`contender ${label} produced no result: ${out}`));
      resolve(JSON.parse(line) as ContenderResult);
    });
  });
}

/** Start N contenders and release them together. */
function raceContenders(
  count: number,
  configPath: string,
  barrierFile: string,
  releaseMarker: string,
): Promise<ContenderResult[]> {
  fs.writeFileSync(barrierFile, '');
  const started = Array.from({ length: count }, (_, i) =>
    spawnContender(`c${i}`, configPath, barrierFile, releaseMarker),
  );
  // Let every contender reach its barrier wait, then release them together. The winner holds its
  // lease briefly so the losers observe a genuinely held resource, then releases.
  return new Promise((resolve) => {
    setTimeout(() => {
      fs.writeFileSync(barrierFile, 'go');
      setTimeout(() => {
        fs.writeFileSync(releaseMarker, 'go');
      }, 1200);
      void Promise.all(started).then(resolve);
    }, 1800);
  });
}

describe('installation resource ownership', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socs-s1-ownership-'));
  });

  afterEach(() => {
    killAllChildren();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('takes both leases and releases only its own', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const services = new InstallationService(new DirectoryLease());

    const owned = await services.acquireOwnership(fixture.configPath, tmpDir);

    expect(owned.kind).toBe('owned');
    if (owned.kind !== 'owned') return;
    expect(owned.ownership.ownerId).toBe(fixture.ownerId);
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(true);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);

    await owned.ownership.release();

    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(false);
    expect(fs.existsSync(path.join(fixture.workspace, '.state', 'installation.lease'))).toBe(false);
  });

  it('acquires the config lease before validating, so a config edit cannot race a writer', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const services = new InstallationService(new DirectoryLease());

    const held = await services.acquireOwnership(fixture.configPath, tmpDir);
    expect(held.kind).toBe('owned');
    if (held.kind !== 'owned') return;

    // A second supported writer, in this same process, is refused rather than conflicting.
    const contender = await services.acquireOwnership(fixture.configPath, tmpDir);
    expect(contender.kind).toBe('busy');
    if (contender.kind !== 'busy') return;
    expect(contender.resource).toBe('config');
    expect(describeOwnershipRefusal(contender)).toContain('holds this config resource');

    await held.ownership.release();
  });

  it('refuses a second owner of the same workspace reached through a different config document', async () => {
    // Two configuration files, one owner workspace: the workspace lease is the real arbiter, so
    // an alias cannot smuggle a second daemon into the owner's state.
    const baseDir = path.join(tmpDir, 'shared-state');
    const first = writeConfigFixture(tmpDir, { baseDir, ownerId: 'owner' });
    const secondDir = path.join(tmpDir, 'alias');
    fs.mkdirSync(secondDir, { recursive: true });
    const secondConfig = path.join(secondDir, 'other-config.json');
    fs.copyFileSync(first.configPath, secondConfig);

    const services = new InstallationService(new DirectoryLease());
    const held = await services.acquireOwnership(first.configPath, tmpDir);
    expect(held.kind).toBe('owned');
    if (held.kind !== 'owned') return;

    const other = await services.acquireOwnership(secondConfig, tmpDir);

    // The second document is a different config resource, so it gets past the config lease and is
    // refused at the workspace lease — the resource that actually protects owner state.
    expect(other.kind).toBe('busy');
    if (other.kind !== 'busy') return;
    expect(other.resource).toBe('owner');
    expect(other.lease.reason).toBe('held');

    await held.ownership.release();
  });

  it('refuses a symlinked alias of the same config document instead of contending separately', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const alias = path.join(tmpDir, 'alias-config.json');
    fs.symlinkSync(fixture.configPath, alias);

    const services = new InstallationService(new DirectoryLease());
    const held = await services.acquireOwnership(alias, tmpDir);
    expect(held.kind).toBe('owned');
    if (held.kind !== 'owned') return;

    // The alias resolved to the target, so the original path contends on the same lease.
    const direct = await services.acquireOwnership(fixture.configPath, tmpDir);
    expect(direct.kind).toBe('busy');
    if (direct.kind !== 'busy') return;
    expect(direct.resource).toBe('config');

    await held.ownership.release();
  });

  it('lets the next contender succeed after a real release', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const services = new InstallationService(new DirectoryLease());

    const first = await services.acquireOwnership(fixture.configPath, tmpDir);
    expect(first.kind).toBe('owned');
    if (first.kind !== 'owned') return;
    await first.ownership.release();

    const second = await services.acquireOwnership(fixture.configPath, tmpDir);
    expect(second.kind).toBe('owned');
    if (second.kind !== 'owned') return;
    await second.ownership.release();
  });

  it('treats a malformed lease as busy and never clears it automatically', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const leasePath = leasePathFor(fixture.configPath);
    fs.mkdirSync(leasePath, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(leasePath, 'holder.json'), 'not-json', { mode: 0o600 });

    const services = new InstallationService(new DirectoryLease());
    const result = await services.acquireOwnership(fixture.configPath, tmpDir);

    expect(result.kind).toBe('busy');
    if (result.kind !== 'busy') return;
    expect(result.lease.reason).toBe('malformed-holder');
    expect(result.lease.holderState).toBe('malformed');
    expect(result.lease.guidance).toContain('never taken automatically');
    // Untouched: no automatic recovery.
    expect(fs.existsSync(leasePath)).toBe(true);
  });

  it('never lets a foreign token delete another holder lease', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const services = new InstallationService(new DirectoryLease());
    const held = await services.acquireOwnership(fixture.configPath, tmpDir);
    expect(held.kind).toBe('owned');
    if (held.kind !== 'owned') return;

    const leasePath = leasePathFor(fixture.configPath);
    const holder = readHolder(leasePath);
    expect(holder).toBeDefined();

    // A foreign release attempt leaves the real holder intact.
    const { releaseLeaseIfOwned } = await import('../../src/runtime/adapters/directory-lease');
    expect(releaseLeaseIfOwned(leasePath, 'a-token-that-is-not-ours')).toBe(false);
    expect(fs.existsSync(leasePath)).toBe(true);
    expect(readHolder(leasePath)?.token).toBe(holder?.token);

    // Release is idempotent for the real owner.
    await held.ownership.release();
    expect(fs.existsSync(leasePath)).toBe(false);
    await held.ownership.release();
    expect(fs.existsSync(leasePath)).toBe(false);
    expect(fs.existsSync(leasePath)).toBe(false);
  });

  it('releases only the config lease when the workspace lease cannot be taken', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const workspaceLease = path.join(fixture.workspace, '.state', 'installation.lease');
    fs.mkdirSync(workspaceLease, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(workspaceLease, 'holder.json'),
      JSON.stringify({ token: 'another-process', pid: process.pid, kind: 'owner' }),
      { mode: 0o600 },
    );

    const services = new InstallationService(new DirectoryLease());
    const result = await services.acquireOwnership(fixture.configPath, tmpDir);

    expect(result.kind).toBe('busy');
    if (result.kind !== 'busy') return;
    expect(result.resource).toBe('owner');
    // The failed second acquisition must NOT leave the first lease held.
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(false);
    expect(fs.existsSync(workspaceLease)).toBe(true);
  });

  it('refuses an undecodable configuration and leaves no lease held', async () => {
    const fixture = writeConfigFixture(tmpDir, { raw: '{ "schemaVersion": 1 }' });

    const services = new InstallationService(new DirectoryLease());
    const result = await services.acquireOwnership(fixture.configPath, tmpDir);

    expect(result.kind).toBe('invalid-config');
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(false);
  });

  it('has exactly one winner when real OS processes race for one installation', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const barrier = path.join(tmpDir, 'go');
    const release = path.join(tmpDir, 'release');

    const results = await raceContenders(4, fixture.configPath, barrier, release);

    const owned = results.filter((r) => r.outcome === 'owned');
    const busy = results.filter((r) => r.outcome === 'busy');
    expect(results).toHaveLength(4);
    expect(owned).toHaveLength(1);
    expect(busy).toHaveLength(3);
    expect(busy.every((r) => r.reason === 'held')).toBe(true);
  }, 60_000);

  it('a real config-set command refuses while another process holds the installation', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const barrier = path.join(tmpDir, 'go');
    const release = path.join(tmpDir, 'release');

    const contender = spawnContender('holder', fixture.configPath, barrier, release);
    // Give the contender time to pass its barrier and take both leases.
    await new Promise((r) => setTimeout(r, 1200));
    fs.writeFileSync(barrier, 'go');
    await new Promise((r) => setTimeout(r, 1200));

    const before = fs.readFileSync(fixture.configPath, 'utf8');
    await expect(
      setConfigValue(fixture.configPath, 'agent.maxIterations', '9'),
    ).rejects.toThrow(/holds this config resource/);
    expect(fs.readFileSync(fixture.configPath, 'utf8')).toBe(before);

    fs.writeFileSync(release, 'go');
    await contender;

    // Once the holder is gone the same command commits normally.
    const message = await setConfigValue(fixture.configPath, 'agent.maxIterations', '9');
    expect(message).toContain('Updated agent.maxIterations');
    expect(JSON.parse(fs.readFileSync(fixture.configPath, 'utf8')).agent.maxIterations).toBe(9);
  }, 60_000);

  it('resolves owner paths from the selected identity, never from a stored path', async () => {
    const baseDir = path.join(tmpDir, 'state');
    const fixture = writeConfigFixture(tmpDir, { baseDir, ownerId: 'shridhar' });

    const services = new InstallationService(new DirectoryLease());
    const owned = await services.acquireOwnership(fixture.configPath, tmpDir);

    expect(owned.kind).toBe('owned');
    if (owned.kind !== 'owned') return;
    expect(owned.ownership.ownerPaths.workspace).toBe(path.join(baseDir, 'profiles', 'shridhar'));
    expect(owned.ownership.ownerPaths.ownerRecord).toBe(
      path.join(baseDir, 'profiles', 'shridhar', '.state', 'owner-access.json'),
    );
    expect(owned.ownership.ownerPaths.mediaStaging).toBe(
      path.join(baseDir, 'profiles', 'shridhar', '.state', 'media-staging'),
    );
    expect(fixtureOwner(baseDir, 'shridhar').workspace).toBe(owned.ownership.ownerPaths.workspace);

    await owned.ownership.release();
  });

  it('reports a lease for local inspection without exposing the lease path', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const { describeLeaseForLocalInspection } = await import('../../src/runtime/adapters/directory-lease');

    expect(describeLeaseForLocalInspection(fixture.configPath)).toEqual({
      present: false,
      readable: false,
    });

    const services = new InstallationService(new DirectoryLease());
    const held = await services.acquireOwnership(fixture.configPath, tmpDir);
    expect(held.kind).toBe('owned');
    if (held.kind !== 'owned') return;

    const inspection = describeLeaseForLocalInspection(fixture.configPath);
    expect(inspection.present).toBe(true);
    expect(inspection.readable).toBe(true);
    expect(inspection.resource).toBe('config');
    expect(inspection.pid).toBe(process.pid);
    expect(inspection.pidAlive).toBe(true);
    expect(JSON.stringify(inspection)).not.toContain(leasePathFor(fixture.configPath));

    await held.ownership.release();
  });
});

describe('ownership release requires quiescence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'socs-s1-quiescence-'));
  });

  afterEach(() => {
    killAllChildren();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A real owner configuration for the suite. */
  function makeOwnerFixture(): ReturnType<typeof writeConfigFixture> {
    return writeConfigFixture(tmpDir, {});
  }

  /**
   * Real collaborators: a real Gateway over a real owner workspace. Only the external channel is
   * absent (telegram is disabled), which is the supported local configuration.
   */
  async function buildRealGateway(fixture: ReturnType<typeof writeConfigFixture>): Promise<import('../../src/gateway/gateway').Gateway> {
    const { Gateway } = await import('../../src/gateway/gateway');
    const { effectiveConfigFor, readConfigDocument } = await import('../../src/runtime/installation');
    const config = effectiveConfigFor(readConfigDocument(fixture.configPath, tmpDir).stored);
    // S1: admission is REQUIRED. This suite drives real boots, so it binds the owner for real rather than
    // stubbing the authority that decides who may serve.
    const { bindGatewayOwner } = await import('../helpers/gateway-owner-deps');
    return new Gateway(config, await bindGatewayOwner(config, 'owner-chat'));
  }

  async function bootRealGateway(fixture: ReturnType<typeof writeConfigFixture>): Promise<import('../../src/gateway/gateway').Gateway> {
    const gateway = await buildRealGateway(fixture);
    await gateway.start();
    return gateway;
  }

  it('reports quiescent when nothing is in flight', async () => {
    const fixture = makeOwnerFixture();
    const gateway = await bootRealGateway(fixture);

    expect(gateway.getShutdownDisposition()).toBe('quiescent');
    expect(gateway.shutdownWorkInFlight()).toEqual({ turns: 0, builds: 0, stopping: false });

    await gateway.stop();
  }, 60_000);

  it('reports pending while shutdown is still draining, then quiescent', async () => {
    const fixture = makeOwnerFixture();
    const gateway = await bootRealGateway(fixture);

    // Sampled synchronously: `stop()` is genuinely in flight, so ownership must not be released yet.
    const stopping = gateway.stop();
    expect(gateway.getShutdownDisposition()).toBe('pending');

    await stopping;

    expect(gateway.getShutdownDisposition()).toBe('quiescent');
  }, 60_000);

  it('releases both leases once the daemon is quiescent', async () => {
    const fixture = makeOwnerFixture();
    const gateway = await buildRealGateway(fixture);
    const services = new InstallationService(new DirectoryLease());
    const { startDaemon } = await import('../../src/index');

    const daemon = await startDaemon({
      services,
      configPath: fixture.configPath,
      homeDir: tmpDir,
      createGateway: () => gateway,
    });
    expect(daemon.kind).toBe('owned');
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(true);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);

    await daemon.shutdown();

    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(false);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
  }, 60_000);

  it('refuses to boot a second daemon that targets the same owner workspace', async () => {
    const fixture = makeOwnerFixture();
    const gateway = await buildRealGateway(fixture);
    const services = new InstallationService(new DirectoryLease());
    const { startDaemon } = await import('../../src/index');

    const daemon = await startDaemon({
      services,
      configPath: fixture.configPath,
      homeDir: tmpDir,
      createGateway: () => gateway,
    });

    // A refused boot throws with honest guidance rather than starting a second daemon.
    await expect(startDaemon({
      services,
      configPath: fixture.configPath,
      homeDir: tmpDir,
      createGateway: () => gateway,
    })).rejects.toThrow(/holds this config resource/);

    await daemon.shutdown();
  }, 60_000);

  it('holds both leases for the whole daemon lifetime, not just boot', async () => {
    const fixture = makeOwnerFixture();
    const gateway = await buildRealGateway(fixture);
    const services = new InstallationService(new DirectoryLease());
    const { startDaemon } = await import('../../src/index');

    const daemon = await startDaemon({
      services,
      configPath: fixture.configPath,
      homeDir: tmpDir,
      createGateway: () => gateway,
    });

    // A real owner turn runs to completion while the daemon holds ownership.
    await gateway.handleTestMessage('chat-1', 'a short note about today');
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(true);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);

    await daemon.shutdown();
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
  }, 60_000);
});
