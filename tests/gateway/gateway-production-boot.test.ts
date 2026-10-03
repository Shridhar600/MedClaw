// tests/gateway/gateway-production-boot.test.ts
//
// The production boot, through `startDaemon()` and nothing else.
//
// THE INVARIANT: `startDaemon()` with no injected collaborators must produce a Gateway that already
// holds owner admission. This suite exists because T1–T4 proved the S1 policy only at layers the
// production launcher never uses — `new GatewayMessageRouter({admission})`, `new Gateway(cfg,{admission})`
// and `deps.createGateway` injection. Meanwhile `src/index.ts` built `new Gateway(c)` with an empty deps
// object, so `if (this.admission)` skipped the entire refusal policy on every real boot and a stranger's
// first DM still auto-paired into the owner's runtime (router.ts `getOrCreateForChat`). A green T3/T4
// suite proved the policy was correct, not that the daemon applied it.
//
// So this suite boots exactly the way `npm start` does and then drives a real inbound stranger message
// through the real Router and the real admission service. It asserts the owner is unreachable, not that a
// helper returns the right shape. Telegram is disabled: no network, no live provider, no Bot API.

import * as fs from 'fs';
import * as path from 'path';

import { startDaemon } from '../../src/index';
import { InstallationService } from '../../src/runtime/installation';
import { DirectoryLease } from '../../src/runtime/adapters/directory-lease';
import { composeOwnerAuthority } from '../../src/runtime/owner-authority';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';
import type { ConfigFixture } from '../helpers/config-fixture';

/**
 * Seed an owner record through the SAME production composition the daemon uses, so a code issued here
 * is on the same clock the daemon will judge it against. Using a separate fixed-clock service would
 * only prove the two disagree about expiry.
 */
async function seedUnpairedOwner(fixture: ConfigFixture): Promise<string> {
  const authority = composeOwnerAuthority({
    ownerId: fixture.ownerId as never,
    ownerPaths: { ownerRecord: fixture.ownerRecord },
  });
  if ((await authority.admission.initialize()) !== 'created') {
    throw new Error('owner record already exists');
  }
  const issued = await authority.admission.issueChallenge();
  if (issued.kind !== 'issued') throw new Error(`seed issue failed: ${issued.kind}`);
  return issued.plaintext;
}

describe('production boot composes owner authority', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-production-boot');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  it('refuses a stranger DM on a real startDaemon boot, without building the owner runtime', async () => {
    const fixture = writeConfigFixture(root, { telegramEnabled: false });

    // Commit an unpaired owner record the way setup does, then read a code through the real service so
    // the stranger's reply can be a genuine well-formed submission rather than a malformed string.
    const issuedPlaintext = await seedUnpairedOwner(fixture);

    // Production entry point. No `createGateway`: the Gateway that runs is the one `src/index.ts` builds.
    const handle = await startDaemon({
      services: new InstallationService(new DirectoryLease()),
      homeDir: root,
      configPath: fixture.configPath,
    });

    try {
      const gateway = handle.gateway;

      // The owner identity comes from ownership acquisition, never from a literal default.
      expect(handle.ownership.ownerId).toBe(fixture.ownerId);

      // Unpaired means pairing-only. If this is false, the boot silently built a clinical runtime and
      // the whole S1 promise is void.
      expect(gateway.servesPairingOnly).toBe(true);
      expect(gateway.runtimeInstance).toBeUndefined();
      expect(gateway.runtimeManager).toBeUndefined();

      // Nothing clinical exists on disk. `.state` holds exactly the two legitimate artifacts: the
      // owner RECORD setup committed, and the workspace LEASE this boot holds. No store, no sessions,
      // no search index, no audit log.
      expect(fs.readdirSync(fixture.workspace)).toEqual(['.state']);
      expect(fs.readdirSync(path.join(fixture.workspace, '.state')).sort()).toEqual([
        'installation.lease',
        'owner-access.json',
      ]);

      // THE behaviour under test: an unbound stranger's ordinary message must be refused by admission,
      // not auto-paired and answered from the owner's clinical runtime.
      const reply = await gateway.handleTestMessage('stranger-chat', 'What is my blood pressure?', 's1');
      expect(reply).toMatch(/pairing code/i);
      expect(reply).not.toMatch(/blood pressure/i);

      // And a stranger's well-formed code is a pairing attempt, never a clinical turn.
      const paired = await gateway.handleTestMessage('stranger-chat', issuedPlaintext, 's2');
      expect(paired).toMatch(/pairing complete/i);

      // Binding a stranger's chat must still not conjure the owner runtime on this boot.
      expect(gateway.runtimeInstance).toBeUndefined();
      expect(gateway.runtimeManager).toBeUndefined();
      expect(fs.readdirSync(path.join(fixture.workspace, '.state')).sort()).toEqual([
        'installation.lease',
        'owner-access.json',
      ]);

      // No session, no transcript, no capture: a stranger leaves no clinical trace.
      expect(fs.existsSync(path.join(fixture.workspace, '.state', 'sessions'))).toBe(false);
    } finally {
      await handle.shutdown();
    }
  }, 120_000);

  it('refuses to start at all when the owner record is missing, naming local setup guidance', async () => {
    // Config selects an owner; no record was ever committed. This is an interrupted setup, and the
    // daemon must refuse rather than serve as if it were a fresh install.
    const fixture = writeConfigFixture(root, { telegramEnabled: false });

    await expect(
      startDaemon({
        services: new InstallationService(new DirectoryLease()),
        homeDir: root,
        configPath: fixture.configPath,
      }),
    ).rejects.toThrow(/Refusing to serve.*unavailable.*Re-run setup/is);
  }, 120_000);

  it('refuses to start when the record on disk belongs to a different owner', async () => {
    const fixture = writeConfigFixture(root, { telegramEnabled: false, ownerId: 'alpha' });
    fs.mkdirSync(path.dirname(fixture.ownerRecord), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      fixture.ownerRecord,
      `${JSON.stringify({
        version: 1,
        ownerId: 'beta',
        createdAt: new Date('2026-06-01T12:00:00.000Z').toISOString(),
        phase: 'unpaired',
        attempts: { day: '2026-06-01', chats: [] },
      }, null, 2)}\n`,
      { mode: 0o600 },
    );

    await expect(
      startDaemon({
        services: new InstallationService(new DirectoryLease()),
        homeDir: root,
        configPath: fixture.configPath,
      }),
    ).rejects.toThrow(/Refusing to serve.*owner-mismatch/is);
  }, 120_000);

  it('refuses a second daemon while the first still holds ownership', async () => {
    const fixture = writeConfigFixture(root, { telegramEnabled: false });
    await seedUnpairedOwner(fixture);

    const first = await startDaemon({
      services: new InstallationService(new DirectoryLease()),
      homeDir: root,
      configPath: fixture.configPath,
    });

    try {
      await expect(
        startDaemon({
          services: new InstallationService(new DirectoryLease()),
          homeDir: root,
          configPath: fixture.configPath,
        }),
      ).rejects.toThrow(/another local process|already holds|busy/i);
    } finally {
      await first.shutdown();
    }
  }, 120_000);
});
