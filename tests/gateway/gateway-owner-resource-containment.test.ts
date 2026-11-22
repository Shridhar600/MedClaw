
import * as fs from 'fs';
import * as path from 'path';

import { startDaemon } from '../../src/index';
import { InstallationService } from '../../src/runtime/installation';
import { DirectoryLease } from '../../src/runtime/adapters/directory-lease';
import { bindOwnerFixture } from '../helpers/owner-authority-fixture';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';

async function bootBoundOwnerAndSend(root: string, text: string): Promise<{ fixture: ReturnType<typeof writeConfigFixture> }> {
  const fixture = writeConfigFixture(root, { telegramEnabled: false });

  await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId, 'local', { channel: 'local', userId: 'local' });

  const handle = await startDaemon({
    services: new InstallationService(new DirectoryLease()),
    homeDir: root,
    configPath: fixture.configPath,
  });

  try {
    await handle.gateway.handleTestMessage('local', text, 'containment');
  } finally {
    await handle.shutdown();
  }

  return { fixture };
}

describe('a bound owner serves only from inside its leased workspace', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('owner-containment');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  it('keeps the search database, sessions, heartbeat store and audit log inside the owner .state directory', async () => {
    const { fixture } = await bootBoundOwnerAndSend(root, 'My knee has been sore since Tuesday.');

    expect(fs.existsSync(fixture.searchDb)).toBe(true);
    expect(fixture.searchDb.startsWith(`${fixture.workspace}${path.sep}`)).toBe(true);

    expect(fs.existsSync(fixture.sessions)).toBe(true);
    expect(fixture.sessions.startsWith(`${fixture.workspace}${path.sep}`)).toBe(true);

    expect(fixture.storePath.startsWith(`${fixture.workspace}${path.sep}`)).toBe(true);
    expect(fixture.auditLogPath.startsWith(`${fixture.workspace}${path.sep}`)).toBe(true);

    const beside = fs.readdirSync(path.join(fixture.baseDir, 'profiles')).sort();
    expect(beside).toEqual([fixture.ownerId]);
  }, 120_000);

  it('writes no legacy search.db or sessions directory beside the owner workspace after a restart', async () => {
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

    const beside = fs.readdirSync(path.join(fixture.baseDir, 'profiles')).sort();
    expect(beside).toEqual([fixture.ownerId]);
  }, 180_000);
});

describe('the derived owner bundle holds for any valid owner id', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('owner-derivation');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  it('serves a NON-default owner id entirely inside its own workspace', async () => {
    const fixture = writeConfigFixture(root, { telegramEnabled: false, ownerId: 'arjun' });

    await bindOwnerFixture(fixture.ownerRecord, fixture.ownerId, 'local', { channel: 'local', userId: 'local' });

    const handle = await startDaemon({
      services: new InstallationService(new DirectoryLease()),
      homeDir: root,
      configPath: fixture.configPath,
    });
    try {
      await handle.gateway.handleTestMessage('local', 'My knee has been sore since Tuesday.', 'nondefault');
    } finally {
      await handle.shutdown();
    }

    expect(handle.ownership.ownerId).toBe('arjun');

    expect(fs.existsSync(fixture.searchDb)).toBe(true);
    expect(fs.existsSync(fixture.sessions)).toBe(true);
    expect(fs.existsSync(path.join(fixture.workspace, '.state', 'owner-access.json'))).toBe(true);

    expect(fs.existsSync(path.join(fixture.baseDir, 'profiles', 'default'))).toBe(false);

    const beside = fs.readdirSync(path.join(fixture.baseDir, 'profiles')).sort();
    expect(beside).toEqual(['arjun']);
  }, 120_000);
});

describe('a control command never becomes a clinical turn', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('control-command');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

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
