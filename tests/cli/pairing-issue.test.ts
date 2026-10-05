// tests/cli/pairing-issue.test.ts
//
// `medclaw pairing issue` through the real CLI entry point (`runCli`), against a real config
// document, a real owner record and the real directory leases.
//
// The invariants this protects, in order of how badly they would hurt the owner:
//   1. a code is printed ONLY after the record committed — a failed write must never show a code
//      that was never stored;
//   2. the command is offline: a daemon already holding the installation refuses it rather than
//      racing the record;
//   3. a bound installation refuses, because rebinding is not supported in S1;
//   4. the plaintext never reaches the record, the diagnostics or `status`.

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
    root = makeTestTemp('socs-s1-pairing-cli');
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

    // Printed, stored as a verifier, and never echoed anywhere else.
    expect(result.stdout).toContain('issued');
    expect(record).not.toContain(plaintext);
    expect(record).toMatch(/"verifier": "v1:[0-9a-f]{32}:[0-9a-f]{64}"/);
    // The code never appears in status output either.
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

    // The stale code is genuinely rejected by the same policy the chat path uses.
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

    // Take the owner workspace lease, exactly as a running daemon does.
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
      // The live holder's lease is untouched by the refused command.
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

    // Nothing left behind: no lease directories at all.
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
    expect(fs.existsSync(`${path.dirname(fixture.configPath)}/.redacted-config.lease`)).toBe(false);
  });

  // ── C03/R20 — the operator-facing text must match what actually happened ─────────────────────
  //
  // The one thing this command must never do is describe a record it cannot describe accurately. It
  // used to answer every non-success refusal with "the previous record is unchanged", including the
  // case where the replacement HAD landed and only its durability was unconfirmed — sending the owner
  // to inspect a record that had changed, and away from a code that no longer matches.
  //
  // The record on disk is real in both cases; the only controlled input is one filesystem durability
  // step of the real file adapter, injected through the command's own store seam.

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


    // Distinct from BOTH failure shapes it used to share one message with, and — per the cold
    // review's F1 — it asserts neither direction: `uncertain` also covers an acknowledgement lost
    // before anything is known, so "was replaced" would be false there and "unchanged" false here.
    expect(output).toMatch(/could not be confirmed as written/i);
    expect(output).not.toMatch(/previous record is unchanged/i);
    expect(output).not.toMatch(/was replaced/i);
    // No code is shown: the plaintext is unrecoverable by design, so showing one would be a lie.
    expect(output).not.toMatch(/\n\s{4}[A-Z2-9]{8}\s/);
    expect(output).toMatch(/run .* again/i);

    // The replacement was RETAINED and is readable; it was neither restored nor deleted.
    expect(fs.readFileSync(fixture.ownerRecord)).not.toEqual(before);
    expect(new FileOwnerStatePort(fixture.ownerRecord, fixture.ownerId).read().kind).toBe('available');
    expect(fs.readdirSync(path.dirname(fixture.ownerRecord))).toEqual(['owner-access.json']);

    // Both leases are still released, so the daemon can start and a reissue can run.
    expect(fs.existsSync(fixture.workspaceLease)).toBe(false);
    expect(fs.existsSync(`${path.dirname(fixture.configPath)}/.redacted-config.lease`)).toBe(false);
  });

  it('asserts nothing about the record when the outcome is genuinely unknown', async () => {
    // F1, from the cold review. `uncertain` is also what a LOST acknowledgement produces: the port
    // call never reported back and nothing is known about whether the record moved. The previous text
    // said "was replaced", which is a definite claim about a record that never changed.
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

    // Says it could not be confirmed, and claims neither that it was replaced nor that it was not.
    expect(output).toMatch(/could not be confirmed as written/i);
    expect(output).not.toMatch(/was replaced/i);
    expect(output).not.toMatch(/previous record is unchanged/i);
    expect(output).not.toMatch(/\n\s{4}[A-Z2-9]{8}\s/);
    // And the record on disk really is untouched, which is exactly what the old text denied.
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
    // The closed write cause is reported, and it is NOT the read-failure word: "unavailable" is what
    // an unreadable record looks like, and conflating the two sends the operator to the wrong place.
    expect(output).toMatch(/Reason: flush-failed/);
    expect(output).not.toMatch(/Reason: unavailable/);
    // Byte-for-byte: this is the case where that sentence is actually true.
    expect(fs.readFileSync(fixture.ownerRecord)).toEqual(before);
  });

  it('reports an unknown pairing subcommand instead of guessing', async () => {
    const fixture = writeConfigFixture(root);

    const result = await run(['--config', fixture.configPath, 'pairing', 'rotate']);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unknown pairing command/);
  });
});