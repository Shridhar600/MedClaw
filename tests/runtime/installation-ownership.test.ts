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
import * as path from 'path';
import { InstallationService, describeOwnershipRefusal } from '../../src/runtime/installation';
import { DirectoryLease, leasePathFor, readHolder } from '../../src/runtime/adapters/directory-lease';
import { setConfigValue } from '../../src/cli/admin';
import type { LedgerFact } from '../../src/memcore';
import { writeConfigFixture } from '../helpers/config-fixture';
import { fixtureOwner } from '../helpers/test-config';
import { makeTestTemp } from '../helpers/test-temp';

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
    tmpDir = makeTestTemp('socs-s1-ownership-');
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

    // C02/R10 ASSERTION MIGRATION. This line used to demand `reason === 'held'` from every refusal.
    // That was not a product contract; it encoded one implementation artifact. The old adapter built
    // its lease in a staging directory and renamed it into place, so the holder record was already
    // readable at the instant the claim became visible and a loser could never observe it missing.
    // R10's repair removes that artifact, because a rename over an existing EMPTY directory is
    // precisely the replacement that had to stop. A nonrecursive `mkdir` is the only no-replace
    // directory claim Node exposes, so the claim is visible for one syscall before the holder record
    // lands, and a loser inside that window truthfully reports `malformed-holder`: ownership cannot be
    // verified, so it is refused and never taken. Both reasons are immediate `busy`.
    expect(busy.every((r) => r.reason === 'held' || r.reason === 'malformed-holder')).toBe(true);

    // The stronger contract that replaces the removed artifact. Nothing a losing process did left
    // anything behind: no staged lease directory, no second claim, no rewritten document. Every
    // contender released, so the config directory holds exactly the one document it started with.
    expect(fs.readdirSync(tmpDir).sort()).toEqual(['config.json', 'go', 'release', 'state']);
    const stored = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8')) as {
      profiles: { defaultProfileId: string };
    };
    expect(stored.profiles.defaultProfileId).toBe(fixture.ownerId);
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

    // Inspection must agree with acquisition about an occupied claim path. A dangling symlink is one:
    // `existsSync` follows it and reports the claim absent, which would tell an operator the
    // installation is free while the daemon refuses it as busy. Present-but-unreadable is the honest
    // answer, and the guidance that goes with it is the manual-inspection one.
    const { DirectoryLease: RealLease } = await import('../../src/runtime/adapters/directory-lease');
    fs.symlinkSync(path.join(tmpDir, 'no-such-target'), leasePathFor(fixture.configPath));
    expect(describeLeaseForLocalInspection(fixture.configPath)).toEqual({
      present: true,
      readable: false,
    });
    const refused = await new RealLease().tryAcquire({
      kind: 'config',
      canonicalPath: fixture.configPath,
    });
    expect(refused.kind).toBe('busy');
    fs.unlinkSync(leasePathFor(fixture.configPath));

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
    tmpDir = makeTestTemp('socs-s1-quiescence-');
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
  async function buildRealGateway(
    fixture: ReturnType<typeof writeConfigFixture>,
    diagnostics?: import('../../src/ports').DiagnosticSink,
    onBuildProvider?: () => void,
  ): Promise<import('../../src/gateway/gateway').Gateway> {
    const { Gateway } = await import('../../src/gateway/gateway');
    const { effectiveConfigFor, readConfigDocument } = await import('../../src/runtime/installation');
    const { createProvider } = await import('../../src/providers/factory');
    const config = effectiveConfigFor(readConfigDocument(fixture.configPath, tmpDir).stored);
    // S1: admission is REQUIRED. This suite drives real boots, so it binds the owner for real rather than
    // stubbing the authority that decides who may serve.
    const { bindGatewayOwner } = await import('../helpers/gateway-owner-deps');
    const deps = await bindGatewayOwner(config, 'owner-chat');
    // A counting wrapper, not a stub: provider CONSTRUCTION is what "a refusal builds nothing" is
    // measured against, and the real factory keeps every other behaviour of the suite unchanged.
    const withCount = onBuildProvider
      ? { createProvider: (cfg: Parameters<typeof createProvider>[0]): ReturnType<typeof createProvider> => {
          onBuildProvider();
          return createProvider(cfg);
        } }
      : {};
    return new Gateway(config, diagnostics ? { ...deps, ...withCount, diagnostics } : { ...deps, ...withCount });
  }

  async function bootRealGateway(fixture: ReturnType<typeof writeConfigFixture>): Promise<import('../../src/gateway/gateway').Gateway> {
    const gateway = await buildRealGateway(fixture);
    await gateway.start();
    return gateway;
  }

  /**
   * Hold ONE real transcript sweep past the runtime's drain budget, through real collaborators only.
   *
   * Real prior-day day-file on disk with an unlogged medication (so a sweep that completes genuinely
   * persists a curiosity item), and a real `LedgerStore.listAllOfType` read parked on an explicit
   * barrier and then delegated to the original implementation — so the sweep that eventually finishes
   * is the real sweep over real data. The single substitution is where that one read blocks.
   *
   * Shared by every R01 sweep case so the held-sweep preconditions are defined exactly once; each case
   * still asserts its own outcomes.
   */
  function holdRealTranscriptSweep(
    fixture: ReturnType<typeof writeConfigFixture>,
    runtime: import('../../src/gateway/runtime').ProfileRuntime,
  ): {
    sweep: Promise<unknown>;
    whenHeld: Promise<void>;
    curiosityPath: string;
    curiosityBefore: string;
    release: () => void;
    restoreLedger: () => void;
  } {
    const yesterdayKey = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const chatLane = path.join(fixture.sessions, 'owner-chat');
    fs.mkdirSync(chatLane, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(chatLane, `${yesterdayKey}.jsonl`),
      `${JSON.stringify({
        timestamp: `${yesterdayKey}T10:00:00.000Z`,
        role: 'user',
        origin: 'chat',
        content: 'synthetic note: took naproxen yesterday',
        chatId: 'owner-chat',
      })}\n`,
      { mode: 0o600 },
    );

    const ledger = runtime.ledgerStore!;
    const originalListAllOfType = ledger.listAllOfType.bind(ledger);
    let releaseLedgerRead!: () => void;
    const ledgerBarrier = new Promise<void>((resolve) => { releaseLedgerRead = resolve; });
    let enteredLedgerRead!: () => void;
    const ledgerReadEntered = new Promise<void>((resolve) => { enteredLedgerRead = resolve; });
    ledger.listAllOfType = async (type): Promise<LedgerFact[]> => {
      enteredLedgerRead();
      await ledgerBarrier;
      return originalListAllOfType(type);
    };

    const curiosityPath = path.join(fixture.workspace, 'curiosity.md');
    const curiosityBefore = fs.existsSync(curiosityPath) ? fs.readFileSync(curiosityPath, 'utf8') : '';

    // Launch through the SAME entry the installed cron callback uses.
    runtime.launchBackgroundSweep();
    const sweep = runtime.sweepInFlight!;
    expect(sweep).toBeDefined();

    return {
      sweep,
      whenHeld: ledgerReadEntered,
      curiosityPath,
      curiosityBefore,
      release: releaseLedgerRead,
      restoreLedger: (): void => { ledger.listAllOfType = originalListAllOfType; },
    };
  }

  /**
   * Drive `daemon.shutdown()` across the runtime's shared 10,000ms drain budget deterministically:
   * fake timers pinned with `jest.setSystemTime()` so the sweep's own `new Date()` cannot drift while
   * the clock is advanced, then advanced in bulk. Never a wall-clock sleep, never a forced exit.
   */
  async function shutdownAcrossDrainBudget(shutdown: () => Promise<void>): Promise<void> {
    jest.useFakeTimers();
    jest.setSystemTime(new Date());
    let settled = false;
    const running = shutdown().then(
      () => { settled = true; },
      () => { settled = true; },
    );
    try {
      await jest.advanceTimersByTimeAsync(60_000);
      for (let i = 0; i < 50 && !settled; i += 1) {
        await jest.advanceTimersByTimeAsync(1_000);
      }
    } finally {
      jest.useRealTimers();
    }
    await running;
  }

  it('reports quiescent when nothing is in flight', async () => {
    const fixture = makeOwnerFixture();
    const gateway = await bootRealGateway(fixture);

    expect(gateway.getShutdownDisposition()).toBe('quiescent');
    // C01 strengthened this assertion rather than replacing it: the same "nothing in flight" claim,
    // now also covering the runtime-continuation count the pending warning reports.
    expect(gateway.shutdownWorkInFlight()).toEqual({ turns: 0, builds: 0, runtimes: 0, stopping: false });

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

  /**
   * C01 / R01: the nightly transcript sweep is real production work that keeps touching owner
   * files AFTER `drainAndClose()` has closed the stores and set the runtime to `closed`.
   *
   * Everything here is real: the real `startDaemon`, the real `Gateway`, the real `ProfileRuntime`,
   * the real session day-file on disk, the real `LedgerStore` and the real `CuriosityQueue`. The
   * only substitutions are (a) one real ledger read held behind an explicit barrier and then
   * delegated to the original implementation, and (b) real child OS processes for the contenders.
   * The clock is controlled with fake timers so the 10s shared drain budget is exceeded
   * deterministically instead of by a 10s wall-clock sleep.
   */
  it('retains both installation leases while a real transcript sweep outlives the drain budget', async () => {
    const fixture = makeOwnerFixture();
    const gateway = await buildRealGateway(fixture);
    const services = new InstallationService(new DirectoryLease());
    const { startDaemon } = await import('../../src/index');

    // A second configuration document pointing at the SAME owner workspace: the workspace lease,
    // not the config lease, must be what protects this installation.
    const aliasDir = path.join(tmpDir, 'alias');
    fs.mkdirSync(aliasDir, { recursive: true });
    const aliasConfigPath = path.join(aliasDir, 'other-config.json');
    fs.copyFileSync(fixture.configPath, aliasConfigPath);

    const daemon = await startDaemon({
      services,
      configPath: fixture.configPath,
      homeDir: tmpDir,
      createGateway: () => gateway,
    });
    expect(daemon.kind).toBe('owned');

    const runtime = gateway.runtimeInstance!;
    expect(runtime.sessions).toBeDefined();
    expect(runtime.ledgerStore).toBeDefined();
    expect(runtime.curiosity).toBeDefined();

    // Real prior-day transcript plus a held real ledger read — see `holdRealTranscriptSweep`.
    const held = holdRealTranscriptSweep(fixture, runtime);
    const { sweep, curiosityPath, curiosityBefore, release: releaseLedgerRead, restoreLedger } = held;
    await held.whenHeld;

    // Controlled clock: cross the runtime's shared drain budget deterministically, with no
    // wall-clock wait — see `shutdownAcrossDrainBudget`.
    const budgetWarnings: string[] = [];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      budgetWarnings.push(args.map((a) => String(a)).join(' '));
    });
    await shutdownAcrossDrainBudget(() => daemon.shutdown());
    warnSpy.mockRestore();

    // The drain really did abandon a phase at the shared budget — the sanitized warning names the
    // budget and the phase label, and pins the 10,000ms constant outcome 6 requires preserved.
    const budgetWarning = budgetWarnings.find((line) => /drain budget/i.test(line));
    expect(budgetWarning).toMatch(/Shutdown drain budget \(10000ms\) exceeded/);
    expect(budgetWarning).toContain('transcript-sweep');
    // Sanitized: phase labels and the constant only. No owner/chat id, path, or transcript text.
    expect(budgetWarning).not.toContain('owner-chat');
    expect(budgetWarning).not.toContain(tmpDir);
    expect(budgetWarning).not.toContain('naproxen');

    // Stop returned: it did NOT wait for the stuck sweep. The bound is the real one — the sweep is
    // demonstrably still running at the moment shutdown resolves.
    expect(runtime.isClosed()).toBe(true);
    let sweepSettled = false;
    void sweep.then(() => { sweepSettled = true; }, () => { sweepSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sweepSettled).toBe(false);

    // `closed` is not quiescence. Asserted in the order the harm would happen: the leases must still
    // be held, and only then does the disposition explain why.
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(true);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);
    expect(daemon.gateway.getShutdownDisposition()).toBe('pending');

    // Real contender OS processes must be refused: the same config, and a different config that
    // resolves to the same owner workspace.
    const barrierFile = path.join(tmpDir, 'go');
    const releaseMarker = path.join(tmpDir, 'release');
    fs.writeFileSync(barrierFile, 'go');
    const same = await spawnContender('same-config', fixture.configPath, barrierFile, releaseMarker);
    const alias = await spawnContender('alias-config', aliasConfigPath, barrierFile, releaseMarker);
    expect(same.outcome).toBe('busy');
    expect(alias.outcome).toBe('busy');
    expect(alias.resource).toBe('owner');
    // The lease directory on disk is still ours, not a contender's.
    expect(readHolder(fixture.workspaceLease)?.pid).toBe(process.pid);

    // Release the barrier and observe the ACTUAL late outcome: the still-running sweep finishes and
    // persists its item — while ownership is still held, which is exactly why it must be.
    releaseLedgerRead();
    restoreLedger();
    const sweepResult = await sweep;
    expect(sweepResult).toMatchObject({ scanned: true });
    const curiosityAfter = fs.readFileSync(curiosityPath, 'utf8');
    expect(curiosityAfter).not.toBe(curiosityBefore);
    expect(curiosityAfter).toContain('naproxen');
    // The late write happened under retained ownership, not under a second installation.
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);
    expect(readHolder(fixture.workspaceLease)?.pid).toBe(process.pid);

    // Only once the continuation has really settled may a repeated root shutdown release. This is
    // the real release path — no lease is deleted by hand anywhere in this test.
    await daemon.shutdown();
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(false);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);

    // …and a contender now genuinely succeeds.
    fs.writeFileSync(barrierFile, 'go');
    fs.writeFileSync(releaseMarker, 'go');
    const next = await spawnContender('after-release', fixture.configPath, barrierFile, releaseMarker);
    expect(next.outcome).toBe('owned');
  }, 120_000);

  /**
   * C01 follow-up / R01: the SAME defect, reached through a runtime REPLACEMENT instead of through
   * stop(). `gateway-transcript-sweep.test.ts` already proves `start()/stop()/start()` is a supported
   * contract, so this is the common boundary, not an exotic path.
   *
   * Mechanism: `stop()` correctly retains both leases (asserted above and in the sibling case), but a
   * subsequent `start()` drains the previous manager and then OVERWRITES it. `getShutdownDisposition()`
   * reads only the replacement manager, so the still-`pending` old runtime — holding a live sweep that
   * will write owner files — becomes invisible. A repeated root shutdown then sees false quiescence,
   * releases both leases, a contender acquires, and the old sweep writes under the contender.
   *
   * Real collaborators throughout: real `startDaemon`, real `Gateway`, real runtime, real day file,
   * real ledger read behind a barrier, real child-process contenders. No private manager assignment, no
   * fake pending getter, no manual lease deletion.
   */
  it('refuses a runtime replacement while the previous runtime still has unsettled work, then recovers after settlement', async () => {
    const fixture = makeOwnerFixture();
    // Real diagnostic sink, so the refusal is asserted as an emitted outcome rather than trusted from
    // a comment: one truthful `refused`, and no `started` / `build-failed` for a start that built nothing.
    const events: import('../../src/ports').DiagnosticEvent[] = [];
    let providerBuilds = 0;
    const gateway = await buildRealGateway(
      fixture,
      { emit: (event) => { events.push(event); } },
      () => { providerBuilds += 1; },
    );
    const services = new InstallationService(new DirectoryLease());
    const { startDaemon } = await import('../../src/index');

    const daemon = await startDaemon({
      services,
      configPath: fixture.configPath,
      homeDir: tmpDir,
      createGateway: () => gateway,
    });
    expect(daemon.kind).toBe('owned');

    const runtime = gateway.runtimeInstance!;
    expect(runtime.ledgerStore).toBeDefined();
    expect(runtime.curiosity).toBeDefined();

    const held = holdRealTranscriptSweep(fixture, runtime);
    const { sweep, curiosityPath, curiosityBefore, release: releaseLedgerRead, restoreLedger } = held;
    await held.whenHeld;

    await shutdownAcrossDrainBudget(() => daemon.shutdown());

    // The stop half of R01 still holds: bounded return, both leases retained, work still running.
    expect(runtime.isClosed()).toBe(true);
    let sweepSettled = false;
    void sweep.then(() => { sweepSettled = true; }, () => { sweepSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sweepSettled).toBe(false);
    expect(gateway.getShutdownDisposition()).toBe('pending');
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(true);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);

    // ── The replacement half. The old runtime is still `pending`, so this process may not truthfully
    // start serving again: replacing it would hide a live continuation from root.
    events.length = 0;
    const buildsBeforeRefusal = providerBuilds;
    await expect(gateway.start()).rejects.toThrow(/previous runtime/i);

    // A refusal builds NOTHING. This is what the FIRST of the two guard checks is for, and it is why
    // the check runs before any provider, semaphore or workspace bootstrap is touched: the refusal is
    // refused at the boundary rather than after constructing a serving generation to throw it away.
    expect(providerBuilds).toBe(buildsBeforeRefusal);

    // Truthful, and only truthful: exactly one start-stop event, it says refused, and its duration is
    // a real measured span — never a false `started`, never `build-failed` for a start that built
    // nothing, never a fabricated `0`.
    const startStop = events.filter((e) => e.stage === 'start-stop');
    expect(startStop).toHaveLength(1);
    expect(startStop[0]).toMatchObject({ outcome: 'refused', reason: 'previous-work-unsettled' });
    expect(Number.isFinite(startStop[0].durationMs)).toBe(true);
    expect(startStop[0].durationMs).toBeGreaterThanOrEqual(0);

    // A refusal must be non-destructive AND must not hide anything: the old generation is still the
    // one this Gateway owns, still reports pending, and is still counted by the diagnostic root reads.
    expect(gateway.runtimeInstance).toBe(runtime);
    expect(gateway.getShutdownDisposition()).toBe('pending');
    expect(gateway.shutdownWorkInFlight().runtimes).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(true);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);
    expect(readHolder(fixture.workspaceLease)?.pid).toBe(process.pid);

    // Repeated root shutdown during the refusal must NOT release. This is the step the inherited C01
    // repair already protects, and a refusal must not reopen it.
    await daemon.shutdown();
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(true);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);
    expect(readHolder(fixture.workspaceLease)?.pid).toBe(process.pid);

    const barrierFile = path.join(tmpDir, 'go');
    const releaseMarker = path.join(tmpDir, 'release');
    fs.writeFileSync(barrierFile, 'go');
    const same = await spawnContender('during-refusal', fixture.configPath, barrierFile, releaseMarker);
    expect(same.outcome).toBe('busy');
    expect(readHolder(fixture.workspaceLease)?.pid).toBe(process.pid);

    // Release the barrier: the old sweep really persists — while THIS installation still owns the
    // workspace. That is the whole point of retaining ownership across the replacement.
    releaseLedgerRead();
    restoreLedger();
    await expect(sweep).resolves.toMatchObject({ scanned: true });
    const curiosityAfter = fs.readFileSync(curiosityPath, 'utf8');
    expect(curiosityAfter).not.toBe(curiosityBefore);
    expect(curiosityAfter).toContain('naproxen');
    expect(readHolder(fixture.workspaceLease)?.pid).toBe(process.pid);

    // ── Settlement, then a genuinely safe retry. Refusal preserved the later retry rather than
    // bricking the daemon.
    for (let i = 0; i < 200 && gateway.getShutdownDisposition() !== 'quiescent'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(gateway.getShutdownDisposition()).toBe('quiescent');
    await gateway.start();
    expect(gateway.runtimeInstance).not.toBe(runtime);
    expect(gateway.getShutdownDisposition()).toBe('quiescent');
    // Ownership was retained throughout; a restart while serving does not hand it away.
    expect(readHolder(fixture.workspaceLease)?.pid).toBe(process.pid);

    // Safe shutdown of the settled replacement releases, and only then does a contender win.
    await daemon.shutdown();
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(false);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
    fs.writeFileSync(barrierFile, 'go');
    fs.writeFileSync(releaseMarker, 'go');
    const next = await spawnContender('after-release', fixture.configPath, barrierFile, releaseMarker);
    expect(next.outcome).toBe('owned');
  }, 180_000);

  /**
   * C01 follow-up / R01: the replacement guard has to run TWICE, and this case isolates the second,
   * load-bearing check.
   *
   * The first check only covers a generation that is ALREADY pending when `serveOwner()` is entered.
   * The drain it then performs can itself CREATE pendingness on the very generation it is draining:
   * `drainAndClose()` registers each phase in the runtime's `unsettledDrainWork`, and a phase
   * abandoned at the shared 10,000ms budget stays registered. A `session-compactions` phase awaiting a
   * compaction and a `scheduler-stop` phase awaiting a stalled heartbeat are both real shapes, and
   * neither is a source of `ProfileRuntime.getShutdownDisposition()` — only the abandoned-phase
   * registration is.
   *
   * So the schedule here is: a generation that is genuinely `quiescent` on entry, whose drain then
   * overruns the budget and leaves it `pending`, and which is then dropped by the overwrite. Without
   * the post-drain re-check, root sees `quiescent`, releases both leases, a contender enters, and the
   * abandoned write-queue continuation writes into a workspace it no longer owns.
   *
   * The held continuation is a REAL `WriteQueue` op — `WriteQueue` keeps its own queues and is not a
   * runtime pending source, which is exactly what makes this generation read `quiescent` beforehand.
   */
  it('refuses a runtime replacement when the drain itself leaves the previous generation pending', async () => {
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

    const runtime = gateway.runtimeInstance!;
    // Load-bearing precondition: this continuation is reached through a real write queue and is
    // visible to no runtime-owned pending set, so the generation reads quiescent on entry.
    expect(runtime.writeQueue).toBeDefined();
    const writeQueue = runtime.writeQueue!;

    let releaseWriteQueue!: () => void;
    const writeQueueBarrier = new Promise<void>((resolve) => { releaseWriteQueue = resolve; });
    const artifact = path.join(fixture.workspace, 'late-write-queue-after-drain.txt');
    const writeQueueOp = writeQueue.enqueue('background', {
      label: 'c01-followup-write-queue-continuation',
      run: async () => {
        await writeQueueBarrier;
        fs.writeFileSync(artifact, 'write-queue write after the drain budget', { mode: 0o600 });
        return 'written';
      },
    });

    // The precondition this case turns on: quiescent NOW, so the first guard cannot fire.
    expect(gateway.getShutdownDisposition()).toBe('quiescent');

    // A replacement attempt with NO prior stop, so the manager has never been drained and the drain
    // inside `serveOwner` is the first one. Controlled clock, advanced while the restart is in flight.
    jest.useFakeTimers();
    jest.setSystemTime(new Date());
    let restartSettled = false;
    const restarting = gateway.start().then(
      () => { restartSettled = true; return undefined; },
      (error: unknown) => { restartSettled = true; return error; },
    );
    try {
      await jest.advanceTimersByTimeAsync(60_000);
      for (let i = 0; i < 50 && !restartSettled; i += 1) {
        await jest.advanceTimersByTimeAsync(1_000);
      }
    } finally {
      jest.useRealTimers();
    }
    await expect(restarting).resolves.toBeInstanceOf(Error);
    await expect(restarting).resolves.toThrow(/previous runtime/i);

    // The drain overran the budget and left the OLD generation pending. That is the transition the
    // pre-check could not see and the post-drain re-check must.
    expect(runtime.isClosed()).toBe(true);
    expect(runtime.getShutdownDisposition()).toBe('pending');
    // …and it was not replaced: ownership is still visible and still held.
    expect(gateway.runtimeInstance).toBe(runtime);
    expect(gateway.getShutdownDisposition()).toBe('pending');
    expect(gateway.shutdownWorkInFlight().runtimes).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(true);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);
    expect(readHolder(fixture.workspaceLease)?.pid).toBe(process.pid);
    expect(fs.existsSync(artifact)).toBe(false);

    const barrierFile = path.join(tmpDir, 'go');
    const releaseMarker = path.join(tmpDir, 'release');
    fs.writeFileSync(barrierFile, 'go');
    const contender = await spawnContender('during-drain-created-pending', fixture.configPath, barrierFile, releaseMarker);
    expect(contender.outcome).toBe('busy');

    // Repeated root shutdown during the refusal must not release either.
    await daemon.shutdown();
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);
    expect(readHolder(fixture.workspaceLease)?.pid).toBe(process.pid);

    // Settle the continuation: the real late owner-file write lands while THIS holder still owns it.
    releaseWriteQueue();
    await expect(writeQueueOp).resolves.toBe('written');
    expect(fs.readFileSync(artifact, 'utf8')).toBe('write-queue write after the drain budget');
    expect(readHolder(fixture.workspaceLease)?.pid).toBe(process.pid);

    for (let i = 0; i < 200 && gateway.getShutdownDisposition() !== 'quiescent'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(gateway.getShutdownDisposition()).toBe('quiescent');
    await gateway.start();
    expect(gateway.runtimeInstance).not.toBe(runtime);

    await daemon.shutdown();
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(false);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
    fs.writeFileSync(barrierFile, 'go');
    fs.writeFileSync(releaseMarker, 'go');
    const next = await spawnContender('after-release', fixture.configPath, barrierFile, releaseMarker);
    expect(next.outcome).toBe('owned');
  }, 180_000);

  /**
   * C01 / R01, non-sweep continuation — and the case that isolates the new mechanism.
   *
   * Two REAL drain continuations, held past the shared budget:
   *
   *  - a real background continuation (`ProfileRuntime.trackBackgroundOperation`, the same seam the
   *    Gateway uses for heartbeat reconciliation). It is visible to the PRE-EXISTING
   *    `backgroundOperations` set, and it is what consumes the whole drain budget at the
   *    `background-operations` phase.
   *  - a real write-queue continuation. `WriteQueue` keeps its own internal queues, so this
   *    continuation is visible to NOTHING except the phase that awaits it. Because the budget is
   *    already spent when `write-queue` starts, that phase takes the *fast-forward* branch — the one
   *    that fires the phase and returns immediately — and only the new drain-work tracking can see
   *    it.
   *
   * That is what makes this case fail if the drain-work tracking is reverted: once the background
   * continuation settles and `backgroundOperations` empties, the write-queue continuation is still
   * running and ownership must STILL be retained.
   *
   * The write-queue continuation then settles by REJECTING, so rejection and its cleanup are
   * covered too: a rejected op is still a settled op, and settlement must be reported as such.
   */
  it('retains ownership for a fast-forwarded non-sweep drain continuation that settles by rejecting', async () => {
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
    const runtime = gateway.runtimeInstance!;
    // The load-bearing precondition: the continuation this case isolates is reached through a REAL
    // write queue. Without it the case would silently stop testing anything.
    expect(runtime.writeQueue).toBeDefined();

    let releaseBackground!: () => void;
    const backgroundBarrier = new Promise<void>((resolve) => { releaseBackground = resolve; });
    let releaseWriteQueue!: () => void;
    const writeQueueBarrier = new Promise<void>((resolve) => { releaseWriteQueue = resolve; });
    // Distinct artifacts per continuation, so each assertion below is attributed to the right one.
    const backgroundArtifact = path.join(fixture.workspace, 'late-background-write.txt');
    const writeQueueArtifact = path.join(fixture.workspace, 'late-write-queue-write.txt');

    // Real background continuation: visible to the pre-existing `backgroundOperations` set, and it
    // blocks the `background-operations` drain phase until the shared budget runs out.
    runtime.trackBackgroundOperation('c01-background-continuation', async () => {
      await backgroundBarrier;
      fs.writeFileSync(backgroundArtifact, 'background write after the drain budget', { mode: 0o600 });
    });

    // Real write-queue continuation. Not present in any runtime-owned set: only the phase that
    // awaits it can see it. Its outcome is a real owner-file write followed by a real rejection.
    const writeQueueOp = runtime.writeQueue!.enqueue('background', {
      label: 'c01-write-queue-continuation',
      run: async () => {
        await writeQueueBarrier;
        fs.writeFileSync(writeQueueArtifact, 'write-queue write after the drain budget', { mode: 0o600 });
        throw new Error('synthetic write-queue continuation failure');
      },
    });
    // The op's own rejection belongs to its caller; observe it rather than leaking an unhandled one.
    let writeQueueRejected = false;
    void writeQueueOp.catch(() => { writeQueueRejected = true; });

    // Controlled clock, pinned, plus the sanitized drain-budget warning captured so the fast-forward
    // is asserted rather than assumed.
    jest.useFakeTimers();
    jest.setSystemTime(new Date());
    const budgetWarnings: string[] = [];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      budgetWarnings.push(args.map((a) => String(a)).join(' '));
    });
    let shutdownSettled = false;
    const firstShutdown = daemon.shutdown().then(
      () => { shutdownSettled = true; },
      () => { shutdownSettled = true; },
    );
    try {
      await jest.advanceTimersByTimeAsync(60_000);
      for (let i = 0; i < 50 && !shutdownSettled; i += 1) {
        await jest.advanceTimersByTimeAsync(1_000);
      }
    } finally {
      jest.useRealTimers();
    }
    await firstShutdown;
    warnSpy.mockRestore();

    // The budget really ran out, and the phases after it really took the fast-forward path. This is
    // what makes the isolation below meaningful: the write-queue phase was fired, not awaited.
    const budgetWarning = budgetWarnings.find((line) => /drain budget/i.test(line));
    expect(budgetWarning).toMatch(/Shutdown drain budget \(10000ms\) exceeded/);
    expect(budgetWarning).toContain('background-operations');
    expect(budgetWarning).toContain('write-queue');
    expect(budgetWarning).not.toContain(tmpDir);

    expect(runtime.isClosed()).toBe(true);
    expect(daemon.gateway.getShutdownDisposition()).toBe('pending');
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(true);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);
    // Neither continuation has produced its outcome yet.
    expect(fs.existsSync(backgroundArtifact)).toBe(false);
    expect(fs.existsSync(writeQueueArtifact)).toBe(false);

    const barrierFile = path.join(tmpDir, 'go');
    const releaseMarker = path.join(tmpDir, 'release');
    fs.writeFileSync(barrierFile, 'go');
    const contender = await spawnContender('during-drain', fixture.configPath, barrierFile, releaseMarker);
    expect(contender.outcome).toBe('busy');

    // Settle the background continuation. It empties the pre-existing tracked set, so afterwards the
    // ONLY remaining evidence of live work is the fast-forwarded write-queue phase — which is exactly
    // the continuation the new tracking exists to see. Its artifact is written; the write-queue
    // artifact is not, so this attribution cannot come from ordering luck.
    releaseBackground();
    for (let i = 0; i < 200 && runtime.backgroundOperations.size > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runtime.backgroundOperations.size).toBe(0);
    expect(fs.readFileSync(backgroundArtifact, 'utf8')).toBe('background write after the drain budget');
    expect(fs.existsSync(writeQueueArtifact)).toBe(false);
    expect(daemon.gateway.getShutdownDisposition()).toBe('pending');
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(true);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(true);

    // Now settle the write-queue continuation — by rejecting. Rejection is settlement: it must not
    // hold ownership open forever, and its cleanup must not be mistaken for pending.
    releaseWriteQueue();
    for (let i = 0; i < 200; i += 1) {
      if (daemon.gateway.getShutdownDisposition() === 'quiescent') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(writeQueueRejected).toBe(true);
    // The rejected continuation still completed its real owner-file write before failing.
    expect(fs.readFileSync(writeQueueArtifact, 'utf8')).toBe('write-queue write after the drain budget');
    expect(daemon.gateway.getShutdownDisposition()).toBe('quiescent');

    // Only now may a repeated root shutdown release.
    await daemon.shutdown();
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(false);
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);

    fs.writeFileSync(barrierFile, 'go');
    fs.writeFileSync(releaseMarker, 'go');
    const next = await spawnContender('after-release', fixture.configPath, barrierFile, releaseMarker);
    expect(next.outcome).toBe('owned');
  }, 120_000);

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

// ── C02/R10 — an existing lease is never replaced ──────────────────────────────────────────
//
// Acquisition published its lease by renaming a fully built directory into place. POSIX `rename`
// REPLACES an existing destination that is an empty directory, so an unknown lease left at a claim
// path — the exact shape a crash between claim and publication leaves behind — was silently deleted
// and this process reported ownership of a resource it had never been given.
//
// Real collaborators throughout. The empty entry is created by the test and then asserted byte-,
// inode- and type-identical after the refusal.

describe('acquisition refuses every pre-existing lease entry without replacing it', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('socs-s1-unknown-lease-');
  });

  afterEach(() => {
    killAllChildren();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses an existing empty config lease and leaves the directory untouched', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const leasePath = leasePathFor(fixture.configPath);
    fs.mkdirSync(leasePath, { mode: 0o700 });
    const before = fs.lstatSync(leasePath);

    const services = new InstallationService(new DirectoryLease());
    const result = await services.acquireOwnership(fixture.configPath, tmpDir);

    expect(result.kind).toBe('busy');
    if (result.kind !== 'busy') return;
    expect(result.resource).toBe('config');
    expect(result.lease.reason).toBe('malformed-holder');
    expect(result.lease.holderState).toBe('malformed');
    // Nothing was claimed, nothing was published, nothing was repaired.
    expect(result.lease.guidance).toContain('never taken automatically');

    const after = fs.lstatSync(leasePath);
    expect(after.isDirectory()).toBe(true);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(fs.readdirSync(leasePath)).toEqual([]);
    expect(fs.existsSync(path.join(leasePath, 'holder.json'))).toBe(false);
    // The owner workspace lease was never reached, so nothing else was created either.
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
  });

  it('refuses an existing empty owner lease and releases only the config lease it took', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    fs.mkdirSync(fixture.workspaceLease, { recursive: true, mode: 0o700 });
    const before = fs.lstatSync(fixture.workspaceLease);

    const services = new InstallationService(new DirectoryLease());
    const result = await services.acquireOwnership(fixture.configPath, tmpDir);

    expect(result.kind).toBe('busy');
    if (result.kind !== 'busy') return;
    expect(result.resource).toBe('owner');
    expect(result.lease.reason).toBe('malformed-holder');

    const after = fs.lstatSync(fixture.workspaceLease);
    expect(after.isDirectory()).toBe(true);
    expect(after.ino).toBe(before.ino);
    expect(fs.readdirSync(fixture.workspaceLease)).toEqual([]);
    // The config lease this caller did acquire is given back; the unknown one is left in place.
    expect(fs.existsSync(leasePathFor(fixture.configPath))).toBe(false);
  });

  it('claims and releases cleanly under a umask that strips owner bits', async () => {
    // Cold-review M1. `mkdir`'s mode is umask-affected. An earlier ordering established the owner-only
    // mode AFTER the holder write, so under a umask like 0700 the claim was created at 0000, the
    // holder write failed EACCES, and the failed-attempt cleanup could not list the directory it had
    // to remove. The claim survived as an artifact this process created, and every later acquisition
    // returned `busy/malformed-holder` forever over a directory no operator could even read. Plan 15
    // §2.2 forbids clearing it automatically. A crash leftover may legitimately stay busy; an artifact
    // this attempt made and failed to clean may not.
    //
    // Scoped to the lease claim itself, which is the mechanism that regressed. The full
    // `acquireOwnership` path cannot be used as the vehicle here: its PRE-EXISTING recursive
    // `secureMkdir` for the owner workspace also fails EACCES under this umask, so that would measure
    // an unrelated baseline limitation instead of the claim's mode handling. Reported separately.
    const leaseDir = path.join(tmpDir, 'umask-claim');
    fs.mkdirSync(path.dirname(leaseDir), { recursive: true, mode: 0o700 });

    const previousUmask = process.umask(0o700);
    let held;
    try {
      // Real adapter, real filesystem, no injected fault — only the process umask.
      held = await new DirectoryLease().tryAcquire({ kind: 'config', canonicalPath: leaseDir });
    } finally {
      process.umask(previousUmask);
    }

    expect(held.kind).toBe('acquired');
    if (held.kind !== 'acquired') return;

    const claim = leasePathFor(leaseDir);
    // Both modes are umask-affected at creation and must be established explicitly. The HOLDER RECORD
    // is the load-bearing one: release is token-checked by reading it, so an unreadable record makes
    // the caller's own lease impossible to release even after a successful acquisition.
    expect(fs.statSync(claim).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(claim, 'holder.json')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(claim)).toEqual(['holder.json']);
    expect(readHolder(claim)?.pid).toBe(process.pid);

    // Release really works under this umask: it must read the record and remove the claim.
    await held.release();
    expect(fs.existsSync(claim)).toBe(false);
  });

  it('treats a dangling symlink at the claim path as occupied, because the entry exists', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const leasePath = leasePathFor(fixture.configPath);
    const missingTarget = path.join(tmpDir, 'no-such-target');
    fs.symlinkSync(missingTarget, leasePath);
    // The link is dangling, so a stat-based existence check reports the claim path as free.
    expect(fs.existsSync(leasePath)).toBe(false);

    const services = new InstallationService(new DirectoryLease());
    const result = await services.acquireOwnership(fixture.configPath, tmpDir);

    // The entry EXISTS, so this is an occupied claim path that cannot be verified, not a local
    // permission problem. (Before C02 the rename publication refused it too, but reported it as
    // `unavailable/permission`, which sends the operator to check a permission that is not the
    // issue.) It is never taken, cleared or repaired.
    expect(result.kind).toBe('busy');
    if (result.kind !== 'busy') return;
    expect(result.resource).toBe('config');
    expect(result.lease.reason).toBe('malformed-holder');
    // The unsupported entry is still there for the operator; it was not replaced or followed.
    expect(fs.lstatSync(leasePath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(leasePath)).toBe(missingTarget);
    expect(fs.existsSync(missingTarget)).toBe(false);
  });
});
