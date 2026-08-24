import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LedgerStore } from '../../src/memcore';
import type { Provenance } from '../../src/memcore/types';

// E1.2 (M-6) — reverse-link stamping. When a fact declares `replaces`/`corrects: <ref>`, the store
// stamps the reciprocal `replacedBy`/`correctedBy` on the TARGET fact (same-type file; ref resolved
// by fact id OR by entity name → current head). P1 only wrote the forward link.

const prov = (source: Provenance['source']): Provenance =>
  ({ source, confidence: 0.95, anchor: 'memory/visit.md#L1', capturedAt: '', note: '' });

describe('LedgerStore reverse-link stamping (M-6 / E1.2)', () => {
  let tmp: string;
  let store: LedgerStore;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-revlink-')); store = new LedgerStore(tmp); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('stamps replacedBy on the target resolved by fact id (applied path)', async () => {
    await store.recordFact({ entity: 'ibuprofen', type: 'medication', fields: { dose: '400mg' }, provenance: prov('doctor') });
    const ibu = (await store.getActive('ibuprofen', 'medication'))!;
    await store.recordFact({ entity: 'naproxen', type: 'medication', fields: { dose: '500mg' }, provenance: prov('doctor'), replaces: ibu.id });

    expect((await store.getCrossLinks('ibuprofen', 'medication')).replacedBy).toContain('naproxen@v1');
    const reread = (await store.getChain('ibuprofen', 'medication')).find(f => f.id === ibu.id)!;
    expect(reread.replacedBy).toBe('naproxen@v1');
  });

  it('resolves a bare entity name to its current head (the natural agent input)', async () => {
    await store.recordFact({ entity: 'aspirin', type: 'medication', fields: { dose: '81mg' }, provenance: prov('doctor') });
    await store.recordFact({ entity: 'clopidogrel', type: 'medication', fields: { dose: '75mg' }, provenance: prov('doctor'), replaces: 'aspirin' });

    expect((await store.getCrossLinks('aspirin', 'medication')).replacedBy).toContain('clopidogrel@v1');
  });

  it('stamps correctedBy for a corrects link', async () => {
    await store.recordFact({ entity: 'flu', type: 'condition', fields: {}, provenance: prov('user') });
    await store.recordFact({ entity: 'influenza', type: 'condition', fields: {}, provenance: prov('doctor'), corrects: 'flu' });

    expect((await store.getCrossLinks('flu', 'condition')).correctedBy).toContain('influenza@v1');
  });

  it('stamps the reverse link on the confirm path (med conflict + replaces)', async () => {
    await store.recordFact({ entity: 'atenolol', type: 'medication', fields: { dose: '50mg' }, provenance: prov('doctor') });
    await store.recordFact({ entity: 'metoprolol', type: 'medication', fields: { dose: '25mg' }, provenance: prov('doctor') });
    // A dose change is a med conflict → needs confirmation; it also declares it replaces atenolol.
    const res = await store.recordFact({ entity: 'metoprolol', type: 'medication', fields: { dose: '50mg' }, provenance: prov('doctor'), replaces: 'atenolol' });
    expect(res.kind).toBe('needs-confirmation');
    if (res.kind !== 'needs-confirmation') return;
    await store.confirm(res.token.uuid);

    expect((await store.getCrossLinks('atenolol', 'medication')).replacedBy).toContain('metoprolol@v2');
  });

  it('is idempotent — an unrelated later write preserves the stamped reverse link', async () => {
    await store.recordFact({ entity: 'ibuprofen', type: 'medication', fields: { dose: '400mg' }, provenance: prov('doctor') });
    const ibu = (await store.getActive('ibuprofen', 'medication'))!;
    await store.recordFact({ entity: 'naproxen', type: 'medication', fields: { dose: '500mg' }, provenance: prov('doctor'), replaces: ibu.id });
    await store.recordFact({ entity: 'celecoxib', type: 'medication', fields: { dose: '200mg' }, provenance: prov('doctor') });

    expect((await store.getCrossLinks('ibuprofen', 'medication')).replacedBy).toContain('naproxen@v1');
  });
});
