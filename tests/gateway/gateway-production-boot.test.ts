
import * as fs from 'fs';
import * as path from 'path';

import { startDaemon } from '../../src/index';
import { InstallationService } from '../../src/runtime/installation';
import { DirectoryLease } from '../../src/runtime/adapters/directory-lease';
import { composeOwnerAuthority } from '../../src/runtime/owner-authority';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';
import type { ConfigFixture } from '../helpers/config-fixture';

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
    root = makeTestTemp('production-boot');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  it('refuses a stranger DM on a real startDaemon boot, without building the owner runtime', async () => {
    const fixture = writeConfigFixture(root, { telegramEnabled: false });

    const issuedPlaintext = await seedUnpairedOwner(fixture);

    const handle = await startDaemon({
      services: new InstallationService(new DirectoryLease()),
      homeDir: root,
      configPath: fixture.configPath,
    });

    try {
      const gateway = handle.gateway;

      expect(handle.ownership.ownerId).toBe(fixture.ownerId);

      expect(gateway.servesPairingOnly).toBe(true);
      expect(gateway.runtimeInstance).toBeUndefined();
      expect(gateway.runtimeManager).toBeUndefined();

      expect(fs.readdirSync(fixture.workspace)).toEqual(['.state']);
      expect(fs.readdirSync(path.join(fixture.workspace, '.state')).sort()).toEqual([
        'installation.lease',
        'owner-access.json',
      ]);

      const reply = await gateway.handleTestMessage('stranger-chat', 'What is my blood pressure?', 's1');
      expect(reply).toMatch(/pairing code/i);
      expect(reply).not.toMatch(/blood pressure/i);

      const paired = await gateway.handleTestMessage('stranger-chat', issuedPlaintext, 's2');
      expect(paired).toMatch(/pairing complete/i);

      expect(gateway.runtimeInstance).toBeUndefined();
      expect(gateway.runtimeManager).toBeUndefined();
      expect(fs.readdirSync(path.join(fixture.workspace, '.state')).sort()).toEqual([
        'installation.lease',
        'owner-access.json',
      ]);

      expect(fs.existsSync(path.join(fixture.workspace, '.state', 'sessions'))).toBe(false);
    } finally {
      await handle.shutdown();
    }
  }, 120_000);

  it('default output reports pairing and stop without raw incoming identities', async () => {
    const fixture = writeConfigFixture(root, { telegramEnabled: false });
    const code = await seedUnpairedOwner(fixture);
    const captured: unknown[][] = [];
    const logs = ['log', 'info', 'warn', 'error'] as const;
    const spies = logs.map(method => jest.spyOn(console, method).mockImplementation((...args: unknown[]) => { captured.push(args); }));
    try {
      const handle = await startDaemon({ homeDir: root, configPath: fixture.configPath });
      try {
        expect(await handle.gateway.handleTestMessage('raw_identity', code, 'event')).toMatch(/pairing complete/i);
        expect(JSON.parse(fs.readFileSync(fixture.ownerRecord, 'utf8')).phase).toBe('bound');
        expect(handle.gateway.runtimeInstance).toBeUndefined();
      } finally { await handle.shutdown(); }
      expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
      const output = JSON.stringify(captured);
      expect(output).not.toContain('raw_identity');
      expect(output).not.toContain(code);
      expect(output).not.toContain(fixture.ownerRecord);
      expect(output).toContain('[diagnostic] stage=owner-admission outcome=pairing-only');
      expect(output).toContain('[diagnostic] stage=pairing outcome=paired');
      expect(output).toContain('[diagnostic] stage=start-stop operation=stop outcome=stopped');
    } finally { spies.forEach(spy => spy.mockRestore()); }
  }, 120_000);

  it('refuses to start at all when the owner record is missing, naming local setup guidance', async () => {
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
