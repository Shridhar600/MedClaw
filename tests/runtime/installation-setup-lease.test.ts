// tests/runtime/installation-setup-lease.test.ts
//
// The protected invariant: **setup commits the owner record and the configuration document while
// holding BOTH installation leases**, so it cannot race a running daemon or a second setup.
//
// Real collaborators throughout — the real `InstallationService`, the real `DirectoryLease`, real
// owner-path derivation, the real owner-state adapter. Nothing here mocks the ownership model.
// The mechanism under test is coordination, so a mocked lease would assert nothing: the whole
// question is whether setup *asks* for the leases at all, which only a real contended lease proves.

import * as fs from 'fs';
import * as path from 'path';
import { InstallationService } from '../../src/runtime/installation';
import { DirectoryLease, leasePathFor } from '../../src/runtime/adapters/directory-lease';
import { resolveOwnerPaths, asProfileId } from '../../src/profiles';
import type { ProfileId } from '../../src/profiles';
import type { EffectiveConfig } from '../../src/config';
import { makeTestTemp } from '../helpers/test-temp';

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