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

    // A loser may observe the claim before the holder record lands; both reasons are an immediate `busy`.
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
   * The nightly transcript sweep is real production work that keeps touching owner
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

  it('claims and releases cleanly under a umask that strips owner bits', async () => {
    // `mkdir`'s mode is umask-affected: a claim created unreadable could never be cleaned up by this attempt.
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

});
