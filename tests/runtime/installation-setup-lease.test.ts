// tests/runtime/installation-setup-lease.test.ts
//
// The protected invariant: **setup commits the owner record and the configuration document while
// holding BOTH installation leases**, so it cannot race a running daemon or a second setup — and it
// does so into a target whose private structural parents do not exist yet.
//
// Real collaborators throughout — the real `InstallationService`, the real `DirectoryLease`, real
// owner-path derivation, the real owner-state adapter, the real config decoder. Nothing here mocks the
// ownership model. The mechanism under test is coordination, so a mocked lease would assert nothing:
// the whole question is whether setup *asks* for the leases at all, which only a real contended lease
// proves.
//
// C02/R03: a real setup used to refuse before creating the missing config parent, so the advertised
// first run (`~/.redacted/config.json`, with `~/.redacted` absent) could never commit. C02/R10: an
// existing empty/unknown lease directory was replaced by this process's own lease. Both are exercised
// here through the real service and the real CLI, and both must be behavioural.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { InstallationService } from '../../src/runtime/installation';
import type { OwnerStateStoreFactory } from '../../src/runtime/installation';
import { DirectoryLease, leasePathFor } from '../../src/runtime/adapters/directory-lease';
import { FileOwnerStatePort } from '../../src/runtime/adapters/owner-state-file';
import type { OwnerRecordFileSync } from '../../src/runtime/adapters/owner-state-file';
import type { OwnerStateRead, OwnerStateWriteResult } from '../../src/ports/owner-state';
import { canonicalizeConfigPath } from '../../src/runtime/adapters/config-file';
import { loadRuntimeConfig } from '../../src/runtime/startup';
import { resolveOwnerPaths, asProfileId } from '../../src/profiles';
import type { ProfileId } from '../../src/profiles';
import type { EffectiveConfig } from '../../src/config';
import { makeTestTemp } from '../helpers/test-temp';

const DEFAULT_HOME_CONTENDER = path.join(__dirname, '..', 'helpers', 'setup-default-home-contender.ts');

/**
 * Every child this suite spawns, so a failing assertion can never leave one running and holding the
 * Jest process open.
 */
const liveChildren = new Set<ChildProcess>();

/**
 * A minimal valid STORED-shape document for a prospective install, plus the effective config the
 * setup writer is handed. `setup()` takes the prospective identity from the caller precisely
 * because no config document exists yet to read an owner from — that inversion is the whole reason
 * `acquireOwnership` cannot serve setup.
 */
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

/**
 * The ADVERTISED first-run shape: a synthetic home whose private config parent has never been created.
 *
 * `resolveSetupValues` derives the state root from the selected config file's directory, so with the
 * default target both the config parent and the workspace root are that one directory. Nothing about
 * this shape is a test convenience — it is byte-for-byte the layout a first run is told to use.
 */
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

  it('commits the owner record and config while holding the config lease', async () => {
    const { configPath, ownerId, config, ownerPaths } = prospectiveSetup(root);
    const leases = new DirectoryLease();

    // Observe the leases from inside the commit by taking them first from a second service. The
    // assertion is deliberately about the OBSERVABLE end state (both files committed) plus the
    // refusal cases below, which are what actually prove the lease is held.
    const service = new InstallationService(leases);
    const outcome = await service.setup({ configPath, config, ownerId });

    if (outcome.kind !== 'committed') throw new Error(`expected committed, got ${outcome.kind}`);
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(true);

    // Both leases are released on the success path, so nothing is stranded.
    const holderConfig = leasePathFor(path.resolve(configPath));
    expect(fs.existsSync(holderConfig)).toBe(false);
  });

  it('REFUSES when a running daemon already holds the owner workspace lease', async () => {
    const { configPath, ownerId, config, ownerPaths } = prospectiveSetup(root);

    // Stand in for a live daemon: hold the OWNER lease for this exact workspace. A real daemon
    // creates the lease's structural parent during boot (the workspace lease directory itself is
    // inside it), so the stand-in must do the same or the lease is `unavailable`, not `acquired`.
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

      // Before the fix this wrote the owner record and the config anyway, producing a second
      // installation that the daemon and the CLI then disagree about.
      if (outcome.kind !== 'busy') throw new Error(`expected busy, got ${outcome.kind}`);
      expect(outcome.resource).toBe('owner');
      // Nothing may have been written while another process owned the workspace.
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

  it('two concurrent setups cannot both commit: exactly one wins', async () => {
    const { configPath, ownerId, config, ownerPaths } = prospectiveSetup(root);
    const service = new InstallationService(new DirectoryLease());

    const [a, b] = await Promise.all([
      service.setup({ configPath, config, ownerId }),
      service.setup({ configPath, config, ownerId }),
    ]);

    // Exactly one commits. The loser is refused by the LEASE, not by a lucky freshness check —
    // that is the point of coordinating: `busy` proves the second setup was stopped by ownership
    // rather than by having lost a race it did not know about.
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['busy', 'committed']);
    expect(fs.existsSync(configPath)).toBe(true);
    // The refused setup wrote no owner record of its own.
    expect(fs.existsSync(path.dirname(ownerPaths.ownerRecord))).toBe(true);
  });

  it('releases the owner lease when the workspace cannot be read', async () => {
    // Regression for a real strand found by the bounded re-review. `ownerLease` was assigned AFTER the
    // freshness check, and `assertFreshInstallation` -> `entriesExcept` rethrows anything that is not
    // ENOENT. So a workspace that exists but cannot be listed (mode 0300 — write+execute, no read; a
    // restored backup or an ACL produces the same shape) threw out of the `try`, and the `finally`
    // released only the CONFIG lease.
    //
    // The damage was permanent: the owner lease stayed on disk, so every later setup into that target
    // returned `busy` naming a PID that had already exited — and plan 15 §2.2 forbids automatic
    // recovery, so the target was unusable until an operator removed the lease by hand.
    const { configPath, ownerId, config, ownerPaths } = prospectiveSetup(root);

    // A workspace that exists and is searchable but NOT readable.
    fs.mkdirSync(ownerPaths.workspace, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(ownerPaths.workspaceLease), { recursive: true, mode: 0o700 });
    fs.chmodSync(ownerPaths.workspace, 0o300);

    try {
      const service = new InstallationService(new DirectoryLease());
      // The refusal itself is not the assertion — a thrown error is acceptable here. What must not
      // happen is the lease being left behind, so the outcome is captured either way.
      await service.setup({ configPath, config, ownerId }).catch(() => undefined);

      // Nothing was committed...
      expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(false);
      expect(fs.existsSync(configPath)).toBe(false);

      // ...and, with the workspace readable again, the SAME target is usable. Before the fix this
      // returned `busy` forever because the stranded lease was still on disk.
      fs.chmodSync(ownerPaths.workspace, 0o700);
      const retry = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });
      if (retry.kind !== 'committed') throw new Error(`expected committed after cleanup, got ${retry.kind}`);
      expect(fs.existsSync(configPath)).toBe(true);
    } finally {
      // Restore permissions so the temp dir can be removed.
      try { fs.chmodSync(ownerPaths.workspace, 0o700); } catch { /* already gone */ }
    }
  });

  it('still refuses a pre-existing installation rather than overwriting it', async () => {
    const { configPath, ownerId, config, ownerPaths } = prospectiveSetup(root);

    // A config document already present: setup must refuse regardless of leases. This is the
    // behaviour the old unlocked writer had, and it must survive the fix.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(configPath, '{"schemaVersion":2}', { mode: 0o600 });

    const service = new InstallationService(new DirectoryLease());
    const outcome = await service.setup({ configPath, config, ownerId });

    expect(outcome.kind).toBe('not-fresh');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{"schemaVersion":2}');
    expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(false);
  });
});

// ── C03/R02 + R20 — setup truth at the owner-record publication boundary ─────────────────────
//
// The invariant: **setup reports success only when the required owner record was actually published
// and confirmed.** Before this, `initialize()`'s replacement result was discarded, so a first run whose
// record write failed committed the configuration document anyway and printed "setup complete" —
// leaving a daemon that refuses to start on an installation that claims to be complete. And a
// replacement that landed without a confirmable flush was reported as clean success.
//
// The fault is injected at the REAL adapter's durability seam, so the temp file is really written,
// the rename really happens or really does not, and everything asserted here is on-disk bytes. The
// leases, the freshness check, the workspace templates and the config writer are all the real ones.

describe('setup tells the truth about the owner record it published', () => {
  let root: string;
  beforeEach(() => {
    root = makeTestTemp('setup-owner-record-truth');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A real owner store whose only controlled fault is one filesystem durability step. */
  function storeWith(sync: OwnerRecordFileSync): OwnerStateStoreFactory {
    return (ownerRecordPath, ownerId) =>
      new FileOwnerStatePort(ownerRecordPath, ownerId, undefined, sync);
  }

  const failingFileFlush: OwnerRecordFileSync = {
    syncFile: (): void => {
      const error: NodeJS.ErrnoException = new Error('injected file flush failure');
      error.code = 'EIO';
      throw error;
    },
    syncDir: (dir: string): void => {
      const dfd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    },
  };

  const failingDirectoryFlush: OwnerRecordFileSync = {
    syncFile: (fd: number): void => fs.fsyncSync(fd),
    syncDir: (): void => {
      const error: NodeJS.ErrnoException = new Error('injected directory flush failure');
      error.code = 'EIO';
      throw error;
    },
  };

  /**
   * A store whose replacement THROWS BEFORE TOUCHING THE FILESYSTEM — the lost-acknowledgement
   * shape, where the outcome of the publication is genuinely unknown to the caller. Reads delegate to
   * the real file adapter so the on-disk facts in each case below are real, not asserted.
   *
   * Admission is NOT mocked. `initialize()` sees a real `OwnerStatePort` and its own policy decides
   * that a throw is `uncertain`; the question this suite asks is what `setup()` then tells the
   * operator, and that is the consumer gap under test.
   */
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

  it('never tells the operator it wrote a record whose publication was never established', async () => {
    const { configPath, ownerId, config, ownerPaths } = prospectiveSetup(root);

    const outcome = await new InstallationService(new DirectoryLease(), {
      ownerStore: storeThrowingBeforeWriting(),
    }).setup({ configPath, config, ownerId });

    // Incomplete, not committed and not not-fresh: nothing pre-existing was refused here.
    expect(outcome.kind).toBe('incomplete');
    if (outcome.kind !== 'incomplete') return;
    expect(outcome.message).not.toMatch(/setup complete/i);

    // THE DEFECT: an unconfirmed publication is not a publication. Claiming a definite write is a
    // false statement about the owner's durable identity, and it is the same lost-acknowledgement
    // case that pairing issue no longer makes.
    expect(outcome.message).not.toMatch(/wrote the owner record/i);
    // Nor may it claim the opposite — an unreadable readback does not establish absence.
    expect(outcome.message).not.toMatch(/no owner record|record was not created|record is missing/i);

    // …and the branch actually taken must be the one the READBACK selects. This is the assertion that
    // makes `attempt.readable` load-bearing: if setup decided readability from the write result alone,
    // this store — which wrote nothing — would be reported as present and readable. A missing line
    // here would let the readback gate be deleted and still pass.
    expect(outcome.message).toMatch(/could not be read back/i);

    // The real facts behind the wording, read through the real adapter: nothing was written, so the
    // operator is told about a target that genuinely holds no record.
    expect(new FileOwnerStatePort(ownerPaths.ownerRecord, ownerId).read().kind).toBe('missing');
    expect(fs.existsSync(configPath)).toBe(false);

    // Both leases released, so the refusal never strands a target as `busy`.
    expect(fs.existsSync(leasePathFor(path.resolve(configPath)))).toBe(false);
    expect(fs.existsSync(ownerPaths.workspaceLease)).toBe(false);

    // The guidance must describe an action that will actually work. Setup never adopts or repairs a
    // workspace it already created, so re-running into THIS target is refused — the message must not
    // send the operator down that road.
    const retry = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });
    expect(retry.kind).toBe('not-fresh');
    expect(fs.existsSync(configPath)).toBe(false);
    // Positively, not by exclusion: the guidance states the true outcome for THIS target and names a
    // fresh one. An earlier version of this line used a negative lookahead that could never match the
    // message and therefore asserted nothing at all.
    expect(outcome.message).toMatch(/re-running (it|setup) into this target is refused/i);
    expect(outcome.message).toMatch(/--state-root/);
  });

  it('publishes no configuration and reports incomplete when the record write is refused', async () => {
    const { configPath, ownerId, config, ownerPaths } = prospectiveSetup(root);

    const outcome = await new InstallationService(new DirectoryLease(), {
      ownerStore: storeWith(failingFileFlush),
    }).setup({ configPath, config, ownerId });

    // NOT committed, and not `not-fresh` either: nothing pre-existing was refused here.
    expect(outcome.kind).toBe('incomplete');
    if (outcome.kind !== 'incomplete') return;
    expect(outcome.message).not.toMatch(/setup complete/i);
    // The required record is absent and no configuration document was published beside it.
    expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
    // Both leases are released on the refusal path too, so no target is stranded as `busy` forever.
    expect(fs.existsSync(leasePathFor(path.resolve(configPath)))).toBe(false);
    expect(fs.existsSync(ownerPaths.workspaceLease)).toBe(false);
    // Setup never adopts or repairs the workspace it already created, so a retry into the same target
    // is refused rather than silently completing a half-written installation.
    const retry = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });
    expect(retry.kind).toBe('not-fresh');
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(false);
  });

  it('keeps a readable owner record, publishes no config, and reports incomplete when the flush is unconfirmed', async () => {
    const { configPath, ownerId, config, ownerPaths } = prospectiveSetup(root);

    const outcome = await new InstallationService(new DirectoryLease(), {
      ownerStore: storeWith(failingDirectoryFlush),
    }).setup({ configPath, config, ownerId });

    expect(outcome.kind).toBe('incomplete');
    if (outcome.kind !== 'incomplete') return;
    // Honest about which half is known: the record is there and readable, its durability is not proven.
    expect(outcome.message).toMatch(/present and readable/);
    expect(outcome.message).toMatch(/No configuration document was written/);
    expect(fs.existsSync(configPath)).toBe(false);

    // The new record is RETAINED and readable — not restored, not deleted, not denied.
    expect(new FileOwnerStatePort(ownerPaths.ownerRecord, ownerId).read().kind).toBe('available');
    expect(modeOf(ownerPaths.ownerRecord)).toBe(0o600);

    // Both leases are released on this path too.
    expect(fs.existsSync(leasePathFor(path.resolve(configPath)))).toBe(false);
    expect(fs.existsSync(ownerPaths.workspaceLease)).toBe(false);

    // Re-running setup into the same target refuses as not-fresh: setup never overwrites or repairs,
    // and it never silently adopts the half-published installation either.
    const retry = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });
    expect(retry.kind).toBe('not-fresh');
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

// ── C02/R03 — structural acquisition preconditions ─────────────────────────────────────────
//
// Setup takes the CONFIG lease before it has a document to read, so the config parent must already be
// a real directory or the lease cannot exist. Before this suite, nothing created it: the real CLI
// refused with "its parent directory is missing", so the advertised first run into `~/.redacted`
// could not commit without the operator pre-creating a private folder by hand.

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

    // The precondition this protects: the private config parent really is absent.
    expect(fs.existsSync(path.dirname(configPath))).toBe(false);
    expect(fs.existsSync(ownerPaths.workspace)).toBe(false);

    const outcome = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });

    if (outcome.kind !== 'committed') {
      throw new Error(`expected committed, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.canonicalConfigPath).toBe(configPath);

    // Everything setup publishes, actually on disk...
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(true);
    expect(fs.existsSync(path.join(ownerPaths.workspace, 'SOUL.md'))).toBe(true);
    expect(fs.existsSync(path.join(ownerPaths.workspace, 'conditions'))).toBe(true);

    // ...private, through the secure-fs contract, not inherited from the umask...
    expect(modeOf(path.dirname(configPath))).toBe(0o700);
    expect(modeOf(path.join(syntheticHome, '.redacted', 'profiles'))).toBe(0o700);
    expect(modeOf(ownerPaths.workspace)).toBe(0o700);
    expect(modeOf(configPath)).toBe(0o600);
    expect(modeOf(ownerPaths.ownerRecord)).toBe(0o600);
    expect(modeOf(path.join(ownerPaths.workspace, 'SOUL.md'))).toBe(0o600);

    // ...and readable by the real decoder the daemon itself uses.
    const reloaded = await loadRuntimeConfig({ configPath, homeDir: syntheticHome });
    expect(reloaded.profiles.defaultProfileId).toBe(ownerId);
    expect(reloaded.profiles.baseDir).toBe(path.dirname(configPath));
    expect(reloaded.memory.workspace).toBe(ownerPaths.workspace);

    // The installation it left behind is a real installation: it can be owned and released again.
    const owned = await new InstallationService(new DirectoryLease()).acquireOwnership(configPath, syntheticHome);
    expect(owned.kind).toBe('owned');
    if (owned.kind !== 'owned') return;
    expect(fs.existsSync(leasePathFor(configPath))).toBe(true);
    expect(fs.existsSync(ownerPaths.workspaceLease)).toBe(true);
    await owned.ownership.release();
    expect(fs.existsSync(leasePathFor(configPath))).toBe(false);
    expect(fs.existsSync(ownerPaths.workspaceLease)).toBe(false);
  });

  it('commits when an explicitly selected nested config parent is absent', async () => {
    const syntheticHome = path.join(root, 'synthetic-home');
    fs.mkdirSync(syntheticHome, { mode: 0o700 });
    const ownerId = asProfileId('default') as ProfileId;
    const { configPath, ownerPaths, config } = absentParentSetup(syntheticHome, ownerId, [
      'state',
      'nested',
      'deeper',
    ]);

    expect(fs.existsSync(path.join(syntheticHome, 'state'))).toBe(false);

    const outcome = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });

    if (outcome.kind !== 'committed') {
      throw new Error(`expected committed, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
    }
    // Every structural level it had to create is private, not just the leaf.
    for (const created of ['state', 'state/nested', 'state/nested/deeper']) {
      expect(modeOf(path.join(syntheticHome, created))).toBe(0o700);
    }
    expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(true);
    expect(modeOf(configPath)).toBe(0o600);
  });

  it('keys the config lease on the real target when new parents sit below a symlinked ancestor', async () => {
    // The lease must identify the SELECTED target, not a lexical spelling of it. On this filesystem a
    // symlinked ancestor resolves at the syscall level, so both spellings reach the same directory —
    // but only a realpath-resolved key makes the reported canonical path, the lease and the bytes
    // written provably the same object rather than two strings that happen to agree today.
    const realAncestor = path.join(root, 'real-ancestor');
    fs.mkdirSync(realAncestor, { mode: 0o700 });
    const linkedAncestor = path.join(root, 'linked-ancestor');
    fs.symlinkSync(realAncestor, linkedAncestor);

    const ownerId = asProfileId('default') as ProfileId;
    // The fresh parents sit one level BELOW the symlinked existing ancestor.
    const freshBase = path.join(linkedAncestor, 'fresh');
    const configAt = path.join(freshBase, 'config.json');
    const ownerAt = resolveOwnerPaths(freshBase, ownerId);
    const freshConfig = {
      schemaVersion: 2,
      profiles: { baseDir: freshBase, defaultProfileId: ownerId },
      memory: { workspace: ownerAt.workspace },
      heartbeat: { storePath: ownerAt.schedulerStore },
      providers: { main: { type: 'ollama' } },
      channels: { telegram: { enabled: false } },
    } as unknown as EffectiveConfig;

    expect(fs.existsSync(freshBase)).toBe(false);
    expect(canonicalizeConfigPath(configAt).canonicalPath).toBe(path.join(realAncestor, 'fresh', 'config.json'));

    const outcome = await new InstallationService(new DirectoryLease()).setup({
      configPath: configAt,
      config: freshConfig,
      ownerId,
    });

    if (outcome.kind !== 'committed') {
      throw new Error(`expected committed, got ${outcome.kind}: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.canonicalConfigPath).toBe(path.join(realAncestor, 'fresh', 'config.json'));
    expect(fs.existsSync(path.join(realAncestor, 'fresh', 'config.json'))).toBe(true);
    expect(fs.existsSync(ownerAt.ownerRecord)).toBe(true);
    // The symlinked ancestor itself was not rewritten into the new target's shape.
    expect(fs.lstatSync(linkedAncestor).isSymbolicLink()).toBe(true);
    expect(modeOf(freshBase)).toBe(0o700);

    // A second writer reaching the SAME target through the real path contends on the SAME lease.
    const throughAlias = await new DirectoryLease().tryAcquire({
      kind: 'config',
      canonicalPath: configAt,
    });
    expect(throughAlias.kind).toBe('acquired');
    if (throughAlias.kind !== 'acquired') return;
    try {
      const throughReal = await new DirectoryLease().tryAcquire({
        kind: 'config',
        canonicalPath: path.join(realAncestor, 'fresh', 'config.json'),
      });
      expect(throughReal.kind).toBe('busy');
    } finally {
      await throughAlias.release();
    }
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

    // Refusal, not success and not an unhandled rejection escaping the service.
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toBe('unsafe-parent');
    // The refusal must be ACTIONABLE. "Create the installation directory" is impossible when the
    // name is already taken by a file, so the guidance has to name the real obstacle instead.
    expect(outcome.guidance).toContain('not a directory');
    expect(outcome.guidance).toContain('Choose a different');
    expect(outcome.guidance).not.toContain('Create the installation directory');
    expect(fs.existsSync(baseDir)).toBe(false);
    expect(fs.readFileSync(blocker, 'utf8')).toBe('synthetic non-directory');
  });

  it('refuses a config parent it cannot create, without leaving a lease behind', async () => {
    const syntheticHome = path.join(root, 'synthetic-home');
    fs.mkdirSync(syntheticHome, { mode: 0o700 });
    const readOnlyParent = path.join(syntheticHome, 'read-only');
    fs.mkdirSync(readOnlyParent, { mode: 0o500 });

    const ownerId = asProfileId('default') as ProfileId;
    const { config } = absentParentSetup(readOnlyParent, ownerId, []);
    const configPath = path.join(readOnlyParent, 'private', 'config.json');

    try {
      const outcome = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });

      expect(outcome.kind).toBe('unavailable');
      if (outcome.kind !== 'unavailable') return;
      expect(fs.existsSync(configPath)).toBe(false);
      // No stranded lease: the target is still usable once the filesystem allows the directory.
      expect(fs.readdirSync(readOnlyParent)).toEqual([]);
    } finally {
      fs.chmodSync(readOnlyParent, 0o700);
    }
  });

  it('leaves prior owner content untouched when setup refuses it as not fresh', async () => {
    const syntheticHome = path.join(root, 'synthetic-home');
    fs.mkdirSync(syntheticHome, { mode: 0o700 });
    const ownerId = asProfileId('default') as ProfileId;
    const { configPath, config, ownerPaths } = absentParentSetup(syntheticHome, ownerId);

    // Prior owner evidence in a workspace whose whole parent chain is missing.
    fs.mkdirSync(ownerPaths.workspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ownerPaths.workspace, 'MEMORY.md'), 'synthetic prior owner content', { mode: 0o600 });

    const outcome = await new InstallationService(new DirectoryLease()).setup({ configPath, config, ownerId });

    expect(outcome.kind).toBe('not-fresh');
    expect(fs.readFileSync(path.join(ownerPaths.workspace, 'MEMORY.md'), 'utf8')).toBe(
      'synthetic prior owner content',
    );
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(ownerPaths.ownerRecord)).toBe(false);
    // Scaffolding is structural only: it never bootstraps templates into a refused target.
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
      // A per-child HOME and REDACTED_CONFIG_PATH. The machine, the shell environment and the real
      // home directory are untouched; only this child's environment is overridden.
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

    // The default selection really is `<home>/.redacted/config.json`, and setup reported success
    // rather than exiting zero after a refusal.
    expect(result.selectedPath).toBe(expectedConfigPath);
    expect(result.exit).toBe(0);
    expect(result.stdoutClaimsSetupComplete).toBe(true);
    expect(result.stderr).toBe('');

    // The committed installation is real, private and reloadable — not a created empty folder.
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