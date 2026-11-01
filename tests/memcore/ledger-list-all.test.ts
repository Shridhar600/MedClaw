import * as fs from 'fs';
import { LedgerStore } from '../../src/memcore/ledger-store';
import { Provenance } from '../../src/memcore/types';
import { makeTestTemp } from '../helpers/test-temp';

let tmpDir: string;
let store: LedgerStore;

beforeEach(() => {
  tmpDir = makeTestTemp('redacted-ledger-all-');
  store = new LedgerStore(tmpDir);
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const userProv: Provenance = { source: 'user', confidence: 1, anchor: 'memory/u.md#L1', capturedAt: '2026-08-12T00:00:00.000Z' };
const docProv: Provenance = { source: 'doctor', confidence: 0.95, anchor: 'memory/v.md#L1', capturedAt: '2026-08-12T00:00:00.000Z' };

describe('LedgerStore.listAllOfType (mirror re-derivation source)', () => {
  it('returns all versions across entities, including superseded heads', async () => {
    await store.recordFact({ entity: 'knee', type: 'condition', fields: { severity: 'mild' }, provenance: userProv });
    const sup = await store.recordFact({ entity: 'knee', type: 'condition', fields: { severity: 'severe' }, provenance: docProv });
    expect(sup.kind).toBe('applied'); // higher authority auto-applies for a non-med conflict
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
