import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LedgerStore } from '../../src/memcore';
import type { Provenance } from '../../src/memcore/types';
import { mutableClock } from '../helpers/memcore-fixtures';

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

  it('freezes a bare-name reverse link to the version alive when declared; a later version + unrelated write does not migrate it (H-2)', async () => {
    const clock = mutableClock('2026-01-01T00:00:00.000Z');
    const s = new LedgerStore(tmp, clock);
    // ibuprofen v1 active, then naproxen replaces it (bare name) → reverse stamped on v1.
    await s.recordFact({ entity: 'ibuprofen', type: 'medication', fields: { dose: '400mg' }, provenance: prov('doctor') });
    const v1 = (await s.getActive('ibuprofen', 'medication'))!;
    clock.advance(86_400_000);
    await s.recordFact({ entity: 'naproxen', type: 'medication', fields: { dose: '500mg' }, provenance: prov('doctor'), replaces: 'ibuprofen' });
    expect((await s.getCrossLinks('ibuprofen', 'medication')).replacedBy).toContain('naproxen@v1');

    // Months later ibuprofen gets a NEWER version (createdAt after naproxen's).
    clock.advance(120 * 86_400_000);
    await s.recordFact({ entity: 'ibuprofen', type: 'medication', fields: { note: 'reordered' }, provenance: prov('doctor') });
    const v2 = (await s.getActive('ibuprofen', 'medication'))!;
    expect(v2.id).not.toBe(v1.id);

    // An UNRELATED later write re-runs reconcileReverseLinks over the whole file.
    clock.advance(86_400_000);
    await s.recordFact({ entity: 'vitamin-d', type: 'medication', fields: { dose: '1000IU' }, provenance: prov('user') });

    // The reverse link must stay on v1 (alive when naproxen declared it) and NOT migrate to the newer head.
    const chain = await s.getChain('ibuprofen', 'medication');
    expect(chain.find(f => f.id === v1.id)!.replacedBy).toBe('naproxen@v1');
    expect(chain.find(f => f.id === v2.id)!.replacedBy).toBeUndefined();
  });

  it('M-1: the reverse link is single-valued (last replacer wins); both forward links persist', async () => {
    // Conscious, documented choice: `replacedBy`/`correctedBy` hold ONE id. When two facts replace the
    // same target the last (array-order) source wins the reverse slot; the forward links preserve the
    // full graph, so nothing is truly lost — getCrossLinks still shows both replacers' forward links.
    await store.recordFact({ entity: 'aspirin', type: 'medication', fields: { dose: '81mg' }, provenance: prov('doctor') });
    await store.recordFact({ entity: 'clopidogrel', type: 'medication', fields: { dose: '75mg' }, provenance: prov('doctor'), replaces: 'aspirin' });
    await store.recordFact({ entity: 'brilinta', type: 'medication', fields: { dose: '90mg' }, provenance: prov('doctor'), replaces: 'aspirin' });

    expect((await store.getCrossLinks('aspirin', 'medication')).replacedBy).toEqual(['brilinta@v1']);
    expect((await store.getCrossLinks('clopidogrel', 'medication')).replaces).toContain('aspirin');
    expect((await store.getCrossLinks('brilinta', 'medication')).replaces).toContain('aspirin');
  });

  it('is idempotent — an unrelated later write preserves the stamped reverse link', async () => {
    await store.recordFact({ entity: 'ibuprofen', type: 'medication', fields: { dose: '400mg' }, provenance: prov('doctor') });
    const ibu = (await store.getActive('ibuprofen', 'medication'))!;
    await store.recordFact({ entity: 'naproxen', type: 'medication', fields: { dose: '500mg' }, provenance: prov('doctor'), replaces: ibu.id });
    await store.recordFact({ entity: 'celecoxib', type: 'medication', fields: { dose: '200mg' }, provenance: prov('doctor') });

    expect((await store.getCrossLinks('ibuprofen', 'medication')).replacedBy).toContain('naproxen@v1');
  });

  it('resolves a bare-name link to the latest target createdAt as of the source', async () => {
    const clock = mutableClock('2026-03-01T00:00:00.000Z');
    const s = new LedgerStore(tmp, clock);
    await s.recordFact({ entity: 'ibuprofen', type: 'medication', fields: { dose: '400mg' }, provenance: prov('doctor') });

    // The higher version is a backfill with an older clinical timestamp.
    clock.set('2026-01-01T00:00:00.000Z');
    await s.recordFact({ entity: 'ibuprofen', type: 'medication', fields: { note: 'backfilled' }, provenance: prov('doctor') });

    clock.set('2026-06-01T00:00:00.000Z');
    await s.recordFact({ entity: 'naproxen', type: 'medication', fields: { dose: '500mg' }, provenance: prov('doctor'), replaces: 'ibuprofen' });

    const chain = await s.getChain('ibuprofen', 'medication');
    expect(chain.find((f) => f.version === 1)!.replacedBy).toBe('naproxen@v1');
    expect(chain.find((f) => f.version === 2)!.replacedBy).toBeUndefined();
  });

  it('rejects a dangling cross-link instead of persisting it as verified', async () => {
    await expect(store.recordFact({
      entity: 'naproxen',
      type: 'medication',
      fields: { dose: '500mg' },
      provenance: prov('doctor'),
      replaces: 'does-not-exist',
    })).rejects.toThrow('unresolved-cross-link');

    expect(await store.getCrossLinks('naproxen', 'medication')).toEqual({
      replaces: [],
      replacedBy: [],
      corrects: [],
      correctedBy: [],
    });
  });

  it('stamps supersededBy on the prior version when a new version supersedes it', async () => {
    await store.recordFact({ entity: 'migraine', type: 'condition', fields: { severity: 'mild' }, provenance: prov('user') });
    await store.recordFact({ entity: 'migraine', type: 'condition', fields: { frequency: 'weekly' }, provenance: prov('user') });

    const chain = await store.getChain('migraine', 'condition');
    expect(chain.find((f) => f.version === 1)!.supersededBy).toBe('migraine@v2');
  });
});
