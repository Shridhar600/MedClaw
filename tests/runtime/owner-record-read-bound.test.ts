// tests/runtime/owner-record-read-bound.test.ts
//
// The protected invariant: **the owner-record reader is bounded on the bytes it READS, not on the size
// a metadata call reported.** Plan 15 line 101 and brief §8 R11 both require exactly this and both
// reject a stat-only precheck, because a record can grow between the metadata check and the read.
//
// Why this has its own file, and why it mocks `fs`. The property is a race: the file must be LARGER
// than the budget while the metadata the reader consults says it is SMALLER. No combination of real
// files and real timing produces that deterministically, and the metadata itself has to be controlled.
// It also cannot be reached with `jest.spyOn`: `import * as fs from 'fs'` compiles to a `__importStar`
// copy whose properties are non-configurable, so a spy both throws and would not reach the adapter's
// copy. `tests/runtime/installation-holder-write-fault.test.ts` documents the same constraint and the
// same remedy for the same reason.
//
// Exactly one thing is controlled here: `statSync` and `fstatSync` UNDER-REPORT the size of one real
// file on disk, in both the path form the original reader used and the descriptor form the current one
// uses, and only while armed. Every byte is real, the file really is larger than the budget, the read
// really happens, and the refusal really comes from the bytes read.
//
// This file exists because the previous test for this invariant asserted nothing about it: with a
// `maxBytes` of `size - 1` the record was refused by the metadata precheck before a single byte was
// read, so deleting the read-side bound — or restoring the original unbounded whole-file read — left
// the entire suite green.

import * as path from 'path';

/**
 * Armed by the test. `mock`-prefixed so the hoisted factory below may legally close over it; the
 * factory itself never reads it, only the functions it returns do, long after initialization.
 */
const mockUnderReport = { armed: false, target: '' };

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  const smallStats = (stats: import('fs').Stats): import('fs').Stats => {
    // A real `Stats` object that claims a tiny file. Built from the OS-reported object so every other
    // field stays exactly what the filesystem said.
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { size: 8 });
  };
  return new Proxy(actual, {
    get(target: typeof actual, property: string | symbol, receiver: unknown): unknown {
      if (property === 'statSync' || property === 'fstatSync') {
        return (file: unknown, ...rest: unknown[]): import('fs').Stats => {
          const stats = (target[property as 'statSync'] as (...a: unknown[]) => import('fs').Stats)(
            file,
            ...rest,
          );
          // The descriptor form is the one the current reader uses; the path form is the one the
          // original reader used. Covering both is what makes the original mechanism detectable.
          if (!mockUnderReport.armed) return stats;
          const applies = typeof file === 'number' || file === mockUnderReport.target;
          return applies ? smallStats(stats) : stats;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
});

// Imported AFTER the mock is registered, so the adapter sees the wrapped module.
import * as fs from 'fs';
import { FileOwnerStatePort, OWNER_RECORD_MAX_BYTES } from '../../src/runtime/adapters/owner-state-file';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

const OWNER_ID = 'default';

/** A structurally valid owner document. Repeated so the file is genuinely over a small budget. */
function recordDocument(): string {
  return `${JSON.stringify(
    {
      version: 1,
      ownerId: OWNER_ID,
      createdAt: '2026-03-01T10:00:00.000Z',
      phase: 'unpaired',
    },
    null,
    2,
  )}\n`;
}

/**
 * A file that is genuinely larger than a small budget. Deliberately NOT valid JSON: what matters here
 * is the size, and a document that would refuse on `invalid-document` if a reader ever got that far is
 * strictly better evidence — it can only reach `available` by reading past the budget.
 */
function oversizedBytes(repeats: number): string {
  return recordDocument().repeat(repeats);
}

describe('owner record read bound: the bytes read decide, not the metadata', () => {
  let root: string;
  let recordPath: string;

  beforeEach(() => {
    root = makeTestTemp('socs-s1-read-bound');
    recordPath = path.join(root, 'owner-access.json');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    mockUnderReport.armed = false;
  });

  afterEach(() => {
    mockUnderReport.armed = false;
    removeTestTemp(root);
  });

  function withUnderReportedMetadata<T>(run: () => T): T {
    mockUnderReport.armed = true;
    mockUnderReport.target = recordPath;
    try {
      return run();
    } finally {
      mockUnderReport.armed = false;
    }
  }

  it('refuses a record whose metadata under-reports its size, instead of reading past the budget', () => {
    // A real file on disk that is genuinely larger than the reader's budget below.
    const bytes = oversizedBytes(40);
    fs.writeFileSync(recordPath, bytes, { mode: 0o600 });
    const realSize = Buffer.byteLength(bytes, 'utf8');
    expect(realSize).toBeGreaterThan(1024);
    expect(fs.statSync(recordPath).size).toBe(realSize);

    // Unarmed control: honest metadata refuses it on size alone, exactly as it always did.
    expect(new FileOwnerStatePort(recordPath, OWNER_ID, 1024).read()).toEqual({
      kind: 'unavailable',
      reason: 'too-large',
    });

    // Armed: the metadata now claims 8 bytes. A stat-only precheck waves this through and reads the
    // whole file; only a bound on the bytes actually read refuses it.
    expect(withUnderReportedMetadata(
      () => new FileOwnerStatePort(recordPath, OWNER_ID, 1024).read(),
    )).toEqual({ kind: 'unavailable', reason: 'too-large' });

    // The production budget is the one the reader holds in normal operation, and this file is
    // comfortably inside it — the everyday case must not be refused.
    expect(realSize).toBeLessThan(OWNER_RECORD_MAX_BYTES);

    // Control that the refusal is a BOUND and not a blanket one. A real, structurally valid record is
    // read normally while the metadata is still lying about its size — so the under-reporting itself
    // causes no refusal, and the two cases above are about SIZE alone.
    const controlPath = path.join(root, 'control-access.json');
    const control = recordDocument();
    fs.writeFileSync(controlPath, control, { mode: 0o600 });
    expect(withUnderReportedMetadata(
      () => new FileOwnerStatePort(controlPath, OWNER_ID).read().kind,
    )).toBe('available');
    expect(control.length).toBeLessThan(1024);
  });

  it('never allocates or reads beyond the budget, whatever the metadata claims', () => {
    // The bound is on the READ, so an over-budget record must not be turned into a string at all.
    //
    // CORRECTED COMMENT. This used to say a reader that parsed past the budget "would return
    // `available` or `invalid-document` here". `available` is impossible for THIS fixture and never
    // was: the bytes are deliberately not valid JSON, so any reader that gets far enough to parse them
    // can only report `invalid-document`. That is still the meaningful signal, and it is the one these
    // assertions actually detect — a reader without the bytes-read bound reports `invalid-document`
    // where this expects `too-large`, which is exactly how both broken readers were caught.
    fs.writeFileSync(recordPath, oversizedBytes(400), { mode: 0o600 });
    const realSize = fs.statSync(recordPath).size;
    expect(realSize).toBeGreaterThan(16 * 1024);

    for (const armed of [false, true]) {
      const read = armed
        ? withUnderReportedMetadata(() => new FileOwnerStatePort(recordPath, OWNER_ID, 1024).read())
        : new FileOwnerStatePort(recordPath, OWNER_ID, 1024).read();
      expect(read).toEqual({ kind: 'unavailable', reason: 'too-large' });
    }
  });
});