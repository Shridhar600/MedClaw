
import * as fs from 'fs';
import * as path from 'path';

import { runCli } from '../../src/cli';
import { issuePairingCode } from '../../src/cli/admin';
import { CryptoPairingCodePort, DirectoryLease, FileOwnerStatePort, readHolder } from '../../src/runtime/adapters';
import type { OwnerRecordFileSync } from '../../src/runtime/adapters';
import type { OwnerStateStoreFactory } from '../../src/runtime';
import { OwnerAdmissionService } from '../../src/profiles';
import { systemClock } from '../../src/ports/defaults';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { writeConfigFixture } from '../helpers/config-fixture';

interface Capture {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(argv: string[]): Promise<Capture> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text: string) => { stdout += text; },
    stderr: (text: string) => { stderr += text; },
  });
  return { stdout, stderr, code };
}

describe('medclaw pairing issue', () => {
  let root: string;

  beforeEach(() => {
    root = makeTestTemp('pairing-cli');
  });

  afterEach(() => {
    removeTestTemp(root);
  });

  /** Seed a valid unpaired record for the fixture owner, as setup would. */
  async function seedUnpaired(fixture: ReturnType<typeof writeConfigFixture>): Promise<void> {
    const service = new OwnerAdmissionService({
      store: new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId),
      codes: new CryptoPairingCodePort(),
      clock: systemClock,
      expectedOwnerId: fixture.ownerId,
    });
    await service.initialize();
  }

  it('prints a one-time code and stores only a verifier', async () => {
    const fixture = writeConfigFixture(root);
    await seedUnpaired(fixture);

    const result = await run(['--config', fixture.configPath, 'pairing', 'issue']);

    expect(result.code).toBe(0);
    const record = fs.readFileSync(fixture.ownerRecord, 'utf8');
    const codeLine = result.stdout.match(/\n\s{4}([A-Z2-9]{8})\s/);
    expect(codeLine).not.toBeNull();
    const plaintext = codeLine![1];

    expect(result.stdout).toContain('issued');
    expect(record).not.toContain(plaintext);
    expect(record).toMatch(/"verifier": "v1:[0-9a-f]{32}:[0-9a-f]{64}"/);
    const status = await run(['--config', fixture.configPath, 'status']);
    expect(status.stdout).not.toContain(plaintext);
    expect(status.stdout).toMatch(/pairing: pending/);
  });

  it('replaces the previous code and the old one stops working', async () => {
    const fixture = writeConfigFixture(root);
    await seedUnpaired(fixture);

    const first = await run(['--config', fixture.configPath, 'pairing', 'issue']);
    const stale = first.stdout.match(/\n\s{4}([A-Z2-9]{8})\s/)![1];
    const second = await run(['--config', fixture.configPath, 'pairing', 'issue']);
    const fresh = second.stdout.match(/\n\s{4}([A-Z2-9]{8})\s/)![1];

    expect(fresh).not.toBe(stale);

    const store = new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId);
    const admission = new OwnerAdmissionService({
      store,
      codes: new CryptoPairingCodePort(),
      clock: systemClock,
      expectedOwnerId: fixture.ownerId,
    });
    expect(await admission.handlePairing({
      channel: 'telegram', chatId: 'c', userId: 'u', chatType: 'private', eventId: 'e1',
    }, stale)).toEqual({ kind: 'invalid' });
    expect(await admission.handlePairing({
      channel: 'telegram', chatId: 'c', userId: 'u', chatType: 'private', eventId: 'e2',
    }, fresh)).toMatchObject({ kind: 'paired' });
  });

  it('refuses while another local holder owns the installation, and leaves the record alone', async () => {
    const fixture = writeConfigFixture(root);
    await seedUnpaired(fixture);
    const before = fs.readFileSync(fixture.ownerRecord);

    const held = new DirectoryLease();
    const lease = await held.tryAcquire({
      kind: 'owner',
      canonicalPath: fixture.workspace,
      leasePath: fixture.workspaceLease,
    });
    expect(lease.kind).toBe('acquired');
    if (lease.kind !== 'acquired') throw new Error('unreachable');

    try {
      const result = await run(['--config', fixture.configPath, 'pairing', 'issue']);

      expect(result.stdout).toMatch(/already holds|Stop the daemon/i);
      expect(result.stdout).not.toMatch(/\n\s{4}[A-Z2-9]{8}\s/);
      expect(fs.readFileSync(fixture.ownerRecord)).toEqual(before);
      expect(readHolder(fixture.workspaceLease)?.pid).toBe(process.pid);
    } finally {
      await lease.release();
    }
  });

  it('refuses once the owner is bound, and does not release a live holder\'s lease', async () => {
    const fixture = writeConfigFixture(root);
    await seedUnpaired(fixture);

    const issued = await run(['--config', fixture.configPath, 'pairing', 'issue']);
    const plaintext = issued.stdout.match(/\n\s{4}([A-Z2-9]{8})\s/)![1];

    const store = new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId);
    const admission = new OwnerAdmissionService({
      store,
      codes: new CryptoPairingCodePort(),
      clock: systemClock,
      expectedOwnerId: fixture.ownerId,
    });
    await admission.handlePairing({
      channel: 'telegram', chatId: 'c', userId: 'u', chatType: 'private', eventId: 'e1',
    }, plaintext);

    const result = await run(['--config', fixture.configPath, 'pairing', 'issue']);

    expect(result.stdout).toMatch(/already paired/i);
    expect(result.stdout).not.toMatch(/\n\s{4}[A-Z2-9]{8}\s/);
    const after = store.read();
    expect(after.kind === 'available' && after.state.phase).toBe('bound');
  });

  it('releases both leases when it finishes, so the daemon can start afterwards', async () => {
    const fixture = writeConfigFixture(root);
    await seedUnpaired(fixture);

    await run(['--config', fixture.configPath, 'pairing', 'issue']);

    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
    expect(fs.existsSync(`${path.dirname(fixture.configPath)}/.redacted-config.lease`)).toBe(false);
  });

  function storeWith(sync: OwnerRecordFileSync): OwnerStateStoreFactory {
    return (ownerRecordPath, ownerId) =>
      new FileOwnerStatePort(ownerRecordPath, ownerId, undefined, sync);
  }

  const failingDirectoryFlush: OwnerRecordFileSync = {
    syncFile: (fd: number): void => fs.fsyncSync(fd),
    syncDir: (): void => {
      const error: NodeJS.ErrnoException = new Error('injected directory flush failure');
      error.code = 'EIO';
      throw error;
    },
  };

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

  it('never claims the record is unchanged when the replacement could not be confirmed', async () => {
    const fixture = writeConfigFixture(root);
    await seedUnpaired(fixture);
    const before = fs.readFileSync(fixture.ownerRecord);

    const output = await issuePairingCode({
      configPath: fixture.configPath,
      ownerStore: storeWith(failingDirectoryFlush),
    });

    expect(output).toMatch(/could not be confirmed as written/i);
    expect(output).not.toMatch(/previous record is unchanged/i);
    expect(output).not.toMatch(/was replaced/i);
    expect(output).not.toMatch(/\n\s{4}[A-Z2-9]{8}\s/);
    expect(output).toMatch(/run .* again/i);

    expect(fs.readFileSync(fixture.ownerRecord)).not.toEqual(before);
    expect(new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId).read().kind).toBe('available');
    expect(fs.readdirSync(path.dirname(fixture.ownerRecord))).toEqual(['owner-access.json']);

    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
    expect(fs.existsSync(`${path.dirname(fixture.configPath)}/.redacted-config.lease`)).toBe(false);
  });

  it('asserts nothing about the record when the outcome is genuinely unknown', async () => {
    const fixture = writeConfigFixture(root);
    await seedUnpaired(fixture);
    const before = fs.readFileSync(fixture.ownerRecord);

    const output = await issuePairingCode({
      configPath: fixture.configPath,
      ownerStore: (_recordPath, ownerId) => {
        const real = new FileOwnerStatePort(
          path.join(fixture.workspace, '.state', 'owner-access.json'),
          ownerId,
        );
        return {
          read: () => real.read(),
          replace: async (): Promise<never> => {
            throw new Error('synthetic lost acknowledgement');
          },
        };
      },
    });

    expect(output).toMatch(/could not be confirmed as written/i);
    expect(output).not.toMatch(/was replaced/i);
    expect(output).not.toMatch(/previous record is unchanged/i);
    expect(output).not.toMatch(/\n\s{4}[A-Z2-9]{8}\s/);
    expect(fs.readFileSync(fixture.ownerRecord)).toEqual(before);
  });

  it('reports a definite pre-publication refusal as unchanged, because it is', async (): Promise<void> => {
    const fixture = writeConfigFixture(root);
    await seedUnpaired(fixture);
    const before = fs.readFileSync(fixture.ownerRecord);

    const output = await issuePairingCode({
      configPath: fixture.configPath,
      ownerStore: storeWith(failingFileFlush),
    });

    expect(output).toMatch(/previous record is unchanged/i);
    expect(output).not.toMatch(/\n\s{4}[A-Z2-9]{8}\s/);
    expect(output).toMatch(/Reason: flush-failed/);
    expect(output).not.toMatch(/Reason: unavailable/);
    expect(fs.readFileSync(fixture.ownerRecord)).toEqual(before);
  });

  it('reports an unknown pairing subcommand instead of guessing', async () => {
    const fixture = writeConfigFixture(root);

    const result = await run(['--config', fixture.configPath, 'pairing', 'rotate']);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unknown pairing command/);
  });
});
