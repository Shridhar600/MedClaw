import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LedgerStore } from '../../src/memcore';
import { mutableClock } from '../helpers/memcore-fixtures';

const prov = () => ({ source: 'user' as const, confidence: 0.9, anchor: 'memory/2026-08-12.md#L1', capturedAt: '2026-08-12T00:00:00.000Z' });

describe('LedgerStore.listSafetyRelevant (Task 13 SafetyRenderer source)', () => {
  let tmp: string;
  let ledger: LedgerStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-safelist-'));
    ledger = new LedgerStore(tmp, mutableClock('2026-08-20T10:00:00.000Z'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('collects safety-relevant active facts across all types', async () => {
    await ledger.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: prov() });
    await ledger.recordFact({ entity: 'penicillin', type: 'allergy', fields: {}, provenance: prov() });
    await ledger.recordFact({ entity: 'stubbed toe', type: 'symptom', fields: {}, provenance: prov() }); // not safety-relevant

    const list = await ledger.listSafetyRelevant();
    const entities = list.map(f => f.entity).sort();
    expect(entities).toEqual(['metformin', 'penicillin']);
    expect(list.every(f => f.safetyRelevant)).toBe(true);
  });

  it('excludes superseded/retracted versions', async () => {
    await ledger.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: prov() });
    await ledger.recordFact({ entity: 'metformin', type: 'medication', fields: { notes: 'with food' }, provenance: prov() }); // supersede v1
    const list = await ledger.listSafetyRelevant();
    expect(list.filter(f => f.entity === 'metformin')).toHaveLength(1); // only the active head
    expect(list[0].status).toBe('active');
  });
});
