// tests/runtime/installation-holder-write-fault.test.ts
//
// The protected invariant: **a lease whose holder record cannot be written is never reported as
// acquired, and the failed attempt removes only the artifact it created itself** — never another
// installation's lease, and never so little that the target is stranded.
//
// Why this case has its own file. The fault can only be injected into the `fs` module the ADAPTER
// imports, and `import * as fs from 'fs'` compiles to a `__importStar` copy whose properties are
// non-configurable, so `jest.spyOn(fs, 'writeFileSync')` from a shared suite both throws
// ("Cannot redefine property") and would not reach the adapter's copy anyway. A module-scoped mock
// confined to this file is the honest way to wrap real IO for this one branch. Everything else is
// real: the real `InstallationService`, the real `DirectoryLease`, the real exclusive claim, the
// real config decoder, the real owner-path derivation and real files on disk.
//
// What is mocked: exactly one operation, the holder-record write, and only while the fault is armed.

import * as path from 'path';

/**
 * Armed by the test. `mock`-prefixed so the hoisted factory below may legally close over it; the
 * factory itself never reads it, only the function it returns does, long after initialization.
 */
const mockHolderFault = { armed: false };

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return new Proxy(actual, {
    get(target, property, receiver) {
      if (property === 'writeFileSync') {
        return (...args: unknown[]): unknown => {
          const file = args[0];
          if (mockHolderFault.armed && typeof file === 'string' && file.endsWith('holder.json')) {
            throw Object.assign(new Error('synthetic holder write failure'), { code: 'EIO' });
          }
          return (target.writeFileSync as (...call: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
});

// Imported AFTER the mock is registered, so the adapter and the service both see the wrapped module.
import * as fs from 'fs';
import { InstallationService } from '../../src/runtime/installation';
import { DirectoryLease, leasePathFor, readHolder } from '../../src/runtime/adapters/directory-lease';
import { writeConfigFixture } from '../helpers/config-fixture';
import { makeTestTemp } from '../helpers/test-temp';

describe('a lease claim that cannot publish its holder record', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('socs-s1-holder-fault-');
    mockHolderFault.armed = false;
  });

  afterEach(() => {
    mockHolderFault.armed = false;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses, cleans only its own claim, leaves another holder alone, and stays retryable', async () => {
    const fixture = writeConfigFixture(tmpDir, {});
    const leasePath = leasePathFor(fixture.configPath);

    // An unrelated installation really holds its own lease throughout. It is acquired BEFORE the
    // fault is armed, so only this attempt's holder write can fail.
    const otherDir = path.join(tmpDir, 'other');
    fs.mkdirSync(otherDir, { mode: 0o700 });
    const otherConfig = path.join(otherDir, 'config.json');
    fs.writeFileSync(otherConfig, fs.readFileSync(fixture.configPath), { mode: 0o600 });
    const otherLease = await new DirectoryLease().tryAcquire({ kind: 'config', canonicalPath: otherConfig });
    expect(otherLease.kind).toBe('acquired');
    if (otherLease.kind !== 'acquired') return;

    mockHolderFault.armed = true;
    let result;
    try {
      result = await new InstallationService(new DirectoryLease()).acquireOwnership(
        fixture.configPath,
        tmpDir,
      );
    } finally {
      mockHolderFault.armed = false;
    }

    // Never reported as owned: this caller does not hold the resource it failed to publish.
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.resource).toBe('config');
    expect(result.reason).toBe('permission');
    expect(result.guidance).toContain('could not record its holder');

    // The half-built claim this attempt created is gone. Plan 15 §2.2 forbids automatic recovery, so
    // leaving it behind would strand the target behind a lease no operator can explain.
    expect(fs.existsSync(leasePath)).toBe(false);

    // And the other installation's lease is untouched: cleanup is scoped to this attempt's artifact.
    expect(fs.existsSync(leasePathFor(otherConfig))).toBe(true);
    expect(readHolder(leasePathFor(otherConfig))?.token).toBe(otherLease.token);

    // "No stranded artifact" has to mean the target is genuinely usable again, not merely tidy.
    const retry = await new InstallationService(new DirectoryLease()).acquireOwnership(
      fixture.configPath,
      tmpDir,
    );
    expect(retry.kind).toBe('owned');
    if (retry.kind === 'owned') await retry.ownership.release();
    expect(fs.existsSync(leasePathFor(otherConfig))).toBe(true);

    await otherLease.release();
  });
});