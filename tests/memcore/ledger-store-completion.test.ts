import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LedgerStore } from '../../src/memcore/ledger-store';
import { Provenance } from '../../src/memcore/types';

let tmpDir: string;
let store: LedgerStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-ledger-completion-'));
  store = new LedgerStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const docProv: Provenance = { source: 'doctor', confidence: 0.95, anchor: 'memory/visit.md#L1', capturedAt: '', note: 'Dr. visit' };
const userProv: Provenance = { source: 'user', confidence: 1, anchor: 'memory/user.md#L1', capturedAt: '', note: 'Self-reported' };

describe('LedgerStore.discontinue', () => {
  it('med discontinue needs confirmation, then confirm writes a discontinued v(N+1)', async () => {
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: docProv });
    const res = await store.discontinue('metformin', 'medication', docProv, { reason: 'doctor-discontinued' });
    expect(res.kind).toBe('needs-confirmation');
    if (res.kind !== 'needs-confirmation') return;

    const fact = await store.confirm(res.token.uuid);
    expect(fact.status).toBe('discontinued');
    expect(fact.version).toBe(2);
    expect(fact.discontinuedReason).toBe('doctor-discontinued');

    expect(await store.getActive('metformin', 'medication')).toBeNull();
    const chain = await store.getChain('metformin', 'medication');
    expect(chain.map(f => f.version).sort()).toEqual([1, 2]);
    // discontinued survives the disk round-trip with its reason intact
    const reread = chain.find(f => f.status === 'discontinued')!;
    expect(reread.discontinuedReason).toBe('doctor-discontinued');
  });

  it('non-med discontinue applies directly', async () => {
    await store.recordFact({ entity: 'headache', type: 'symptom', fields: { severity: 'mild' }, provenance: userProv });
    const res = await store.discontinue('headache', 'symptom', userProv);
    expect(res.kind).toBe('applied');
    if (res.kind === 'applied') expect(res.fact.status).toBe('discontinued');
    expect(await store.getActive('headache', 'symptom')).toBeNull();
  });

  it('is a no-op when there is no active version', async () => {
    const res = await store.discontinue('ghost', 'medication', docProv);
    expect(res.kind).toBe('noop');
  });
});

describe('LedgerStore.restart', () => {
  it('restart of a discontinued med needs confirmation and carries restartOf', async () => {
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: docProv });
    const disc = await store.discontinue('metformin', 'medication', docProv, { reason: 'side effects' });
    if (disc.kind === 'needs-confirmation') await store.confirm(disc.token.uuid);
    const discontinuedFact = (await store.getChain('metformin', 'medication')).find(f => f.status === 'discontinued')!;

    const res = await store.restart('metformin', 'medication', docProv, { dose: '500mg' });
    expect(res.kind).toBe('needs-confirmation');
    if (res.kind !== 'needs-confirmation') return;

    const fact = await store.confirm(res.token.uuid);
    expect(fact.status).toBe('active');
    expect(fact.fields.restartOf).toBe(discontinuedFact.id);
    expect((await store.getActive('metformin', 'medication'))!.id).toBe(fact.id);
  });

  it('restart of a discontinued non-med applies directly', async () => {
    await store.recordFact({ entity: 'jogging', type: 'goal', fields: { target: '5k' }, provenance: userProv });
    const disc = await store.discontinue('jogging', 'goal', userProv);
    expect(disc.kind).toBe('applied');
    const res = await store.restart('jogging', 'goal', userProv, {});
    expect(res.kind).toBe('applied');
    if (res.kind === 'applied') expect(res.fact.status).toBe('active');
  });

  it('is a no-op when the entity is already active', async () => {
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: docProv });
    const res = await store.restart('metformin', 'medication', docProv, {});
    expect(res.kind).toBe('noop');
  });

  it('is a no-op when there is no discontinued version to restart', async () => {
    const res = await store.restart('ghost', 'medication', docProv, {});
    expect(res.kind).toBe('noop');
  });
});

describe('LedgerStore.pause', () => {
  it('produces a paused version carrying pre_pause_summary', async () => {
    await store.recordFact({ entity: 'weight-loss', type: 'goal', fields: { target: '-5kg' }, provenance: userProv });
    const res = await store.pause('weight-loss', 'goal', userProv, { prePauseSummary: 'paused during travel' });
    expect(res.kind).toBe('applied');
    if (res.kind !== 'applied') return;
    expect(res.fact.status).toBe('paused');
    expect(res.fact.fields.pre_pause_summary).toBe('paused during travel');
  });

  it('carries pre_pause_summary forward on a later non-resume write (A2)', async () => {
    await store.recordFact({ entity: 'weight-loss', type: 'goal', fields: { target: '-5kg' }, provenance: userProv });
    await store.pause('weight-loss', 'goal', userProv, { prePauseSummary: 'paused during travel' });
    const res = await store.recordFact({ entity: 'weight-loss', type: 'goal', fields: { target: '-3kg' }, provenance: userProv });
    expect(res.kind).toBe('needs-confirmation');
    if (res.kind === 'needs-confirmation') {
      expect(res.proposed.fields.pre_pause_summary).toBe('paused during travel');
    }
  });

  it('is a no-op when there is no active version', async () => {
    const res = await store.pause('ghost', 'goal', userProv, { prePauseSummary: 'x' });
    expect(res.kind).toBe('noop');
  });
});

describe('LedgerStore cross-entity links (KNEE-04)', () => {
  it('links a discontinued med to its replacement and surfaces the links', async () => {
    await store.recordFact({ entity: 'ibuprofen', type: 'medication', fields: { dose: '400mg' }, provenance: docProv, safetyRelevant: true });
    const ibuActive = (await store.getActive('ibuprofen', 'medication'))!;

    // naproxen v1 declares it replaces ibuprofen (outgoing link on the new med)
    await store.recordFact({ entity: 'naproxen', type: 'medication', fields: { dose: '250mg' }, provenance: docProv, replaces: ibuActive.id });

    // discontinue ibuprofen, pointing replacedBy at naproxen (incoming link on the old med)
    const disc = await store.discontinue('ibuprofen', 'medication', docProv, { reason: 'switched', replacedBy: 'naproxen@v1' });
    if (disc.kind === 'needs-confirmation') await store.confirm(disc.token.uuid);

    // both survive the disk round-trip
    const naproxen = (await store.getActive('naproxen', 'medication'))!;
    expect(naproxen.replaces).toBe(ibuActive.id);
    const discontinued = (await store.getChain('ibuprofen', 'medication')).find(f => f.status === 'discontinued')!;
    expect(discontinued.replacedBy).toBe('naproxen@v1');

    const ibuLinks = await store.getCrossLinks('ibuprofen', 'medication');
    expect(ibuLinks.replacedBy).toContain('naproxen@v1');
    const napLinks = await store.getCrossLinks('naproxen', 'medication');
    expect(napLinks.replaces).toContain(ibuActive.id);
  });
});
