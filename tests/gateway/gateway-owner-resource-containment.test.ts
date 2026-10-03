// tests/gateway/gateway-owner-resource-containment.test.ts
//
// Every durable resource a BOUND owner serves from must live inside the one leased owner workspace.
//
// THE INVARIANT: after a real `startDaemon()` boot that binds the owner and then serves a real inbound
// message, the search database, the session transcripts, the heartbeat store, the audit log, the owner
// record and the media staging lane are ALL inside `<baseDir>/profiles/<ownerId>/.state/`. Nothing the
// owner's clinical flow touches may be written beside that directory.
//
// This suite exists because the legacy profile-registry migration branch made the opposite guarantee.
// `Gateway.buildRuntimeFor` resolved its paths through `migrateAndResolveWorkspace`, which called
// `ProfileRegistry.hasBeenMigrated` and, when that sentinel was absent, took a "legacy fallback":
//
//   dbPath  = path.join(config.memory.workspace, '..', 'search.db')   // one level ABOVE the workspace
//   sessions= path.join(path.dirname(config.memory.workspace), 'sessions')
//
// Since T1, `config.memory.workspace` IS `<baseDir>/profiles/<ownerId>` — derived by `resolveOwnerPaths`,
// not read from a document. So that fallback put `search.db` in `<baseDir>/profiles/`, OUTSIDE the
// directory this process leased and outside the owner record, and did so *silently*, on every boot where
// the sentinel was missing. The migration branch could also re-copy the owner's whole PHI tree on every
// boot forever, because the sentinel it wrote never matched the one it read.
//
// None of that was visible: every existing assertion either named the legacy path as expected, or never
// looked at disk after a bound owner was served. The suite below boots the real daemon, sends a real
// message through the real Router to the real runtime, and then asks where the bytes landed.
//
// It asserts on the FILESYSTEM after the flow, not on a helper's return value — deleting the migration
// branch must not be able to keep this green by moving a string.

import * as fs from 'fs';
import * as path from 'path';

import { startDaemon } from '../../src/index';
import { InstallationService } from '../../src/runtime/installation';
import { DirectoryLease } from '../../src/runtime/adapters/directory-lease';
import { bindOwnerFixture } from '../helpers/owner-authority-fixture';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';

/**
 * Drive the REAL enrollment state machine through production composition, then boot the real daemon
 * and send a real message as the bound owner.
 *
 * The owner chat is `local:local`, because the transport identity is what admission judges and the
 * owner record is seeded unbound.
 */
async function bootBoundOwnerAndSend(root: string, text: string): Promise<{ fixture: ReturnType<typeof writeConfigFixture> }> {
  const fixture = writeConfigFixture(root, { telegramEnabled: false });

  // Bind through the REAL enrollment state machine, with the identity `handleTestMessage` presents
  // (`channel: 'local'`), so admission genuinely authorizes the turn below rather than the fixture
  // agreeing with itself.
  await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId, 'local', { channel: 'local', userId: 'local' });

  const handle = await startDaemon({
    services: new InstallationService(new DirectoryLease()),
    homeDir: root,
    configPath: fixture.configPath,
  });

  try {
    // A real inbound message through the real Router to the real runtime. The reply is irrelevant; the
    // point is that the owner's clinical flow actually ran and actually wrote.
    await handle.gateway.handleTestMessage('local', text, 's1-containment');
  } finally {
    await handle.shutdown();
  }

  return { fixture };
}

describe('a bound owner serves only from inside its leased workspace', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-owner-containment');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  it('keeps the search database, sessions, heartbeat store and audit log inside the owner .state directory', async () => {
    const { fixture } = await bootBoundOwnerAndSend(root, 'My knee has been sore since Tuesday.');

    // The search database is the resource the legacy fallback moved OUTSIDE the workspace. It must be
    // inside `.state`, next to every other owner resource.
    expect(fs.existsSync(fixture.searchDb)).toBe(true);
    expect(fixture.searchDb.startsWith(`${fixture.workspace}${path.sep}`)).toBe(true);

    // The one the fallback put in `<baseDir>/profiles/sessions`.
    expect(fs.existsSync(fixture.sessions)).toBe(true);
    expect(fixture.sessions.startsWith(`${fixture.workspace}${path.sep}`)).toBe(true);

    // Scheduler paths, for the same reason.
    expect(fixture.storePath.startsWith(`${fixture.workspace}${path.sep}`)).toBe(true);
    expect(fixture.auditLogPath.startsWith(`${fixture.workspace}${path.sep}`)).toBe(true);

    // THE assertion that fails on the migration branch: nothing was written BESIDE the owner's
    // workspace directory. `<baseDir>/profiles/` may hold the owner directory and nothing else.
    const beside = fs.readdirSync(path.join(fixture.baseDir, 'profiles')).sort();
    expect(beside).toEqual([fixture.ownerId]);
  }, 120_000);

  it('writes no legacy search.db or sessions directory beside the owner workspace after a restart', async () => {
    // The migration branch re-ran on EVERY boot, so a first boot could pass while a restart re-copied
    // the PHI tree. A second boot on the same workspace is what exposes it.
    await bootBoundOwnerAndSend(root, 'First turn about my knee.');

    const fixture = writeConfigFixture(root, { telegramEnabled: false });

    const handle = await startDaemon({
      services: new InstallationService(new DirectoryLease()),
      homeDir: root,
      configPath: fixture.configPath,
    });
    try {
      await handle.gateway.handleTestMessage('local', 'Second turn after a restart.', 's2-restart');
    } finally {
      await handle.shutdown();
    }

    // Still exactly one directory under `profiles/`, and it is the owner's.
    const beside = fs.readdirSync(path.join(fixture.baseDir, 'profiles')).sort();
    expect(beside).toEqual([fixture.ownerId]);
  }, 180_000);
});

describe('the derived owner bundle holds for any valid owner id', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-owner-derivation');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  // The bug the migration branch hid: `migrateLegacyWorkspace` sealed its sentinel under
  // `getOrCreateDefaultProfile()` — the literal id `default` — while the CONFIG selects whatever
  // `defaultProfileId` names. For every owner that is not literally `default` the two could never
  // agree, so the whole tree was re-copied on every boot, forever. A non-default owner id is the
  // exact case that broke, so it is the case worth pinning.
  it('serves a NON-default owner id entirely inside its own workspace', async () => {
    const fixture = writeConfigFixture(root, { telegramEnabled: false, ownerId: 'arjun' });

    await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId, 'local', { channel: 'local', userId: 'local' });

    const handle = await startDaemon({
      services: new InstallationService(new DirectoryLease()),
      homeDir: root,
      configPath: fixture.configPath,
    });
    try {
      await handle.gateway.handleTestMessage('local', 'My knee has been sore since Tuesday.', 's1-nondefault');
    } finally {
      await handle.shutdown();
    }

    expect(handle.ownership.ownerId).toBe('arjun');

    // Resources are inside `profiles/arjun/.state/`.
    expect(fs.existsSync(fixture.searchDb)).toBe(true);
    expect(fs.existsSync(fixture.sessions)).toBe(true);
    expect(fs.existsSync(path.join(fixture.workspace, '.state', 'owner-access.json'))).toBe(true);

    // And NOTHING named `default` was conjured anywhere. This is the phantom directory the
    // registry's `getOrCreateDefaultProfile()` created on every boot.
    expect(fs.existsSync(path.join(fixture.baseDir, 'profiles', 'default'))).toBe(false);

    // Exactly the owner directory beside it — no `search.db`, no `sessions`, no `default`.
    const beside = fs.readdirSync(path.join(fixture.baseDir, 'profiles')).sort();
    expect(beside).toEqual(['arjun']);
  }, 120_000);
});

describe('a control command never becomes a clinical turn', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-control-command');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  /**
   * OLD -> NEW. OLD (`profile-gateway.test.ts`, retired with the auto-pair suite): `/new` reached the
   * command handler only because the fixture had paired the chat through `ProfileRegistry`. NEW: the
   * same chat is admitted by the REAL owner record, so this proves the command path for a chat that
   * genuinely IS the owner rather than for one the legacy registry happened to grant.
   *
   * The invariant is unchanged and distinct: a control command resets the session window and must not
   * consume a provider call, because "starting a fresh session" is not a health question.
   */
  it('/new resets the bound owner session and does not run the agent', async () => {
    const fixture = writeConfigFixture(root, { telegramEnabled: false });
    await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId, 'local', { channel: 'local', userId: 'local' });

    const handle = await startDaemon({
      services: new InstallationService(new DirectoryLease()),
      homeDir: root,
      configPath: fixture.configPath,
    });

    try {
      const gateway = handle.gateway;
      const runtime = gateway.runtimeInstance;
      if (!runtime?.sessions || !runtime.agentLoop) throw new Error('bound owner built no complete runtime');
      const resetSpy = jest.spyOn(runtime.sessions, 'resetSession').mockResolvedValue(undefined);
      const runSpy = jest.spyOn(runtime.agentLoop, 'run').mockResolvedValue({
        text: 'should never be reached',
        trace: [],
        usedTools: [],
        healthResponse: false,
      });

      const reply = await gateway.handleTestMessage('local', '/new');

      expect(reply).toBe('Starting fresh session. Your health memory is preserved.');
      expect(resetSpy).toHaveBeenCalledWith('local');
      expect(runSpy).not.toHaveBeenCalled();
    } finally {
      await handle.shutdown();
    }
  }, 120_000);
});
