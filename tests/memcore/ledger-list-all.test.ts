import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LedgerStore } from '../../src/memcore/ledger-store';
import { Provenance } from '../../src/memcore/types';

let tmpDir: string;
let store: LedgerStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-ledger-all-'));
  store = new LedgerStore(tmpDir);
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const userProv: Provenance = { source: 'user', confidence: 1, anchor: 'memory/u.md#L1', capturedAt: '2026-08-12T00:00:00.000Z' };
const docProv: Provenance = { source: 'doctor', confidence: 0.95, anchor: 'memory/v.md#L1', capturedAt: '2026-08-12T00:00:00.000Z' };

// listAllOfType is the FactMirror re-derivation source: it must return EVERY fact of a type
// (all entities, all versions incl. non-active) so the mirror can flip a superseded head off
// `active`. listByType (active-only) cannot do that.
describe('LedgerStore.listAllOfType (mirror re-derivation source, P2 A1.4)', () => {
  it('returns all versions across entities, including superseded heads', async () => {
    // knee: user v1 (mild) then doctor supersedes with a conflicting severity (higher authority applies).
    await store.recordFact({ entity: 'knee', type: 'condition', fields: { severity: 'mild' }, provenance: userProv });
    const sup = await store.recordFact({ entity: 'knee', type: 'condition', fields: { severity: 'severe' }, provenance: docProv });
    expect(sup.kind).toBe('applied'); // higher authority auto-applies for a non-med conflict
    // diabetes: a separate active entity in the same type file.
    await store.recordFact({ entity: 'diabetes', type: 'condition', fields: { status: 'managed' }, provenance: docProv });

    const all = await store.listAllOfType('condition');
    const byId = new Map(all.map(f => [`${f.entity}@v${f.version}`, f.status]));
    expect(all.length).toBe(3);
    expect(byId.get('knee@v1')).toBe('superseded');
    expect(byId.get('knee@v2')).toBe('active');
    expect(byId.get('diabetes@v1')).toBe('active');
  });

  it('returns an empty array for a type with no facts', async () => {
    expect(await store.listAllOfType('allergy')).toEqual([]);
  });
});
