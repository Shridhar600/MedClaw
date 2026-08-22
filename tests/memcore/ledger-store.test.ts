import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LedgerStore } from '../../src/memcore/ledger-store';
import { Provenance } from '../../src/memcore/types';

let tmpDir: string;
let store: LedgerStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-ledger-'));
  store = new LedgerStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const docProv: Provenance = { source: 'doctor', confidence: 0.95, anchor: 'memory/visit.md#L1', capturedAt: '', note: 'Dr. visit' };
const userProv: Provenance = { source: 'user', confidence: 1, anchor: 'memory/user.md#L1', capturedAt: '', note: 'Self-reported' };
const sensorProv: Provenance = { source: 'sensor', confidence: 0.8, anchor: 'memory/sensor.md#L1', capturedAt: '', note: 'Device reading' };
const labProv: Provenance = { source: 'lab', confidence: 0.9, anchor: 'memory/lab.md#L1', capturedAt: '', note: 'Lab result' };
describe('LedgerStore', () => {
  describe('v1 create', () => {
    it('creates v1 when no prior version exists', async () => {
      const result = await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '850mg 1x/day' }, provenance: docProv,
      });
      expect(result.kind).toBe('applied');
      if (result.kind === 'applied') {
        expect(result.fact.version).toBe(1);
        expect(result.fact.status).toBe('active');
        expect(result.fact.entity).toBe('metformin');
      }
    });

    it('persists v1 to disk', async () => {
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '850mg 1x/day' }, provenance: docProv,
      });
      const active = await store.getActive('metformin', 'medication');
      expect(active).not.toBeNull();
      expect(active!.version).toBe(1);
    });
  });

  describe('non-conflicting merge-update', () => {
    it('creates new version when fields dont conflict (same values plus new field)', async () => {
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '850mg 1x/day' }, provenance: docProv,
      });
      const result = await store.recordFact({
        entity: 'metformin', type: 'medication',
        fields: { dose: '850mg 1x/day', frequency: '2x/day' },
        provenance: docProv,
      });
      expect(result.kind).toBe('applied');
      if (result.kind === 'applied') {
        expect(result.fact.version).toBe(2);
        expect(result.fact.status).toBe('active');
        expect(result.fact.fields.frequency).toBe('2x/day');
      }
    });

    it('marks previous version superseded on merge-update', async () => {
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '850mg 1x/day' }, provenance: docProv,
      });
      await store.recordFact({
        entity: 'metformin', type: 'medication',
        fields: { dose: '850mg 1x/day', frequency: '2x/day' },
        provenance: docProv,
      });
      const active = await store.getActive('metformin', 'medication');
      expect(active!.version).toBe(2);
    });
  });

  describe('higher-authority supersede', () => {
    // W-C/D fix pass (AR / C2): a conflicting MED change needs user confirmation
    // regardless of authority rank — the old assertion here enshrined the
    // authority-rank bypass the hostile panel flagged as CRITICAL.
    it('doctor conflicting med change needs confirmation; confirm applies v2', async () => {
      await store.recordFact({
        entity: 'lisinopril', type: 'medication', fields: { dose: '10mg' }, provenance: userProv,
      });
      const result = await store.recordFact({
        entity: 'lisinopril', type: 'medication', fields: { dose: '20mg' }, provenance: docProv,
      });
      expect(result.kind).toBe('needs-confirmation');
      if (result.kind === 'needs-confirmation') {
        const fact = await store.confirm(result.token.uuid);
        expect(fact.version).toBe(2);
        expect(fact.status).toBe('active');
        expect(fact.fields.dose).toBe('20mg');
      }
    });

    it('lab supersedes sensor', async () => {
      await store.recordFact({
        entity: 'vitamin-d', type: 'metric', fields: { level: '30', unit: 'ng/mL' }, provenance: sensorProv,
      });
      const result = await store.recordFact({
        entity: 'vitamin-d', type: 'metric', fields: { level: '45', unit: 'ng/mL' }, provenance: labProv,
      });
      expect(result.kind).toBe('applied');
    });
  });

  describe('NEEDS_CONFIRM', () => {
    it('lower authority contradiction returns needs-confirmation', async () => {
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: docProv,
      });
      const result = await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: userProv,
      });
      expect(result.kind).toBe('needs-confirmation');
      if (result.kind === 'needs-confirmation') {
        expect(result.token).toBeDefined();
        expect(result.token.singleUse).toBe(true);
        expect(result.current.version).toBe(1);
        expect(result.proposed.fields.dose).toBe('500mg');
      }
    });

    it('med/allergy with same rank returns needs-confirmation', async () => {
      await store.recordFact({
        entity: 'penicillin', type: 'allergy', fields: { reaction: 'rash' }, provenance: docProv,
      });
      const result = await store.recordFact({
        entity: 'penicillin', type: 'allergy', fields: { reaction: 'anaphylaxis' }, provenance: docProv,
      });
      expect(result.kind).toBe('needs-confirmation');
    });
  });

  describe('disputed', () => {
    it('same-rank conflict on non-medical returns both disputed', async () => {
      await store.recordFact({
        entity: 'knee-pain', type: 'symptom', fields: { severity: 'mild' }, provenance: userProv,
      });
      const result = await store.recordFact({
        entity: 'knee-pain', type: 'symptom', fields: { severity: 'severe' }, provenance: userProv,
      });
      expect(result.kind).toBe('disputed');
      if (result.kind === 'disputed') {
        expect(result.versions).toHaveLength(2);
        expect(result.versions[0].status).toBe('disputed');
        expect(result.versions[1].status).toBe('disputed');
      }
    });

    it('disputed versions excluded from getActive', async () => {
      await store.recordFact({
        entity: 'knee-pain', type: 'symptom', fields: { severity: 'mild' }, provenance: userProv,
      });
      await store.recordFact({
        entity: 'knee-pain', type: 'symptom', fields: { severity: 'severe' }, provenance: userProv,
      });
      const active = await store.getActive('knee-pain', 'symptom');
      expect(active).toBeNull();
    });
  });

  describe('confirm — dispute resolution', () => {
    it('confirm with winningVersion resolves dispute', async () => {
      await store.recordFact({
        entity: 'knee-pain', type: 'symptom', fields: { severity: 'mild' }, provenance: userProv,
      });
      const result = await store.recordFact({
        entity: 'knee-pain', type: 'symptom', fields: { severity: 'severe' }, provenance: userProv,
      });
      expect(result.kind).toBe('disputed');
      if (result.kind === 'disputed') {
        await store.confirm(result.disputeToken.uuid, { winningVersion: result.versions[0].version });
        const active = await store.getActive('knee-pain', 'symptom');
        expect(active).not.toBeNull();
        expect(active!.status).toBe('active');
      }
    });
  });

  describe('confirm — NEEDS_CONFIRM token acceptance', () => {
    it('confirm applies the pending write', async () => {
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: docProv,
      });
      const result = await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: userProv,
      });
      expect(result.kind).toBe('needs-confirmation');
      if (result.kind === 'needs-confirmation') {
        await store.confirm(result.token.uuid);
        const active = await store.getActive('metformin', 'medication');
        expect(active!.fields.dose).toBe('500mg');
      }
    });
  });

  describe('confirm — token validation (A3)', () => {
    it('rejects nonexistent token', async () => {
      await expect(store.confirm('nonexistent-token')).rejects.toThrow(/not found/);
    });

    it('rejects used token', async () => {
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: docProv,
      });
      const result = await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: userProv,
      });
      expect(result.kind).toBe('needs-confirmation');
      if (result.kind === 'needs-confirmation') {
        await store.confirm(result.token.uuid);
        await expect(store.confirm(result.token.uuid)).rejects.toThrow(/already used/);
      }
    });
  });

  describe('retract', () => {
    it('direct retract when not safetyRelevant', async () => {
      await store.recordFact({
        entity: 'knee-pain', type: 'symptom', fields: { severity: 'mild' }, provenance: userProv,
      });
      const result = await store.retract({ entity: 'knee-pain', type: 'symptom', provenance: userProv });
      expect(result.kind).toBe('applied');
      const active = await store.getActive('knee-pain', 'symptom');
      expect(active).toBeNull();
    });

    it('safetyRelevant retract returns needs-confirmation', async () => {
      await store.recordFact({
        entity: 'penicillin', type: 'allergy', fields: { reaction: 'rash' },
        provenance: docProv, safetyRelevant: true,
      });
      const result = await store.retract({ entity: 'penicillin', type: 'allergy', provenance: docProv });
      expect(result.kind).toBe('needs-confirmation');
      if (result.kind !== 'needs-confirmation') return;
      expect(result.token).toBeDefined();
    });

    it('confirm safety-relevant retract applies retraction', async () => {
      await store.recordFact({
        entity: 'penicillin', type: 'allergy', fields: { reaction: 'rash' },
        provenance: docProv, safetyRelevant: true,
      });
      const result = await store.retract({ entity: 'penicillin', type: 'allergy', provenance: docProv });
      expect(result.kind).toBe('needs-confirmation');
      if (result.kind !== 'needs-confirmation') return;
      await store.confirm(result.token!.uuid);
      const active = await store.getActive('penicillin', 'allergy');
      expect(active).toBeNull();
    });
  });

  describe('getActive', () => {
    it('returns null for unknown entity', async () => {
      const active = await store.getActive('nonexistent', 'medication');
      expect(active).toBeNull();
    });

    it('never returns superseded/retracted/disputed versions', async () => {
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: docProv,
      });
      await store.recordFact({
        entity: 'metformin', type: 'medication',
        fields: { dose: '500mg', frequency: '2x/day' },
        provenance: docProv,
      });
      const active = await store.getActive('metformin', 'medication');
      expect(active!.version).toBe(2);
    });
  });

  describe('getChain', () => {
    it('returns full history newest-first', async () => {
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: docProv,
      });
      await store.recordFact({
        entity: 'metformin', type: 'medication',
        fields: { dose: '500mg', frequency: '2x/day' },
        provenance: docProv,
      });
      await store.recordFact({
        entity: 'metformin', type: 'medication',
        fields: { dose: '500mg', frequency: '2x/day', reason: 'maintenance' },
        provenance: docProv,
      });
      const chain = await store.getChain('metformin', 'medication');
      expect(chain).toHaveLength(3);
      expect(chain[0].version).toBe(3);
      expect(chain[1].version).toBe(2);
      expect(chain[2].version).toBe(1);
    });
  });

  describe('listByType', () => {
    it('returns only active facts of the type', async () => {
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '850mg' }, provenance: docProv,
      });
      await store.recordFact({
        entity: 'lisinopril', type: 'medication', fields: { dose: '10mg' }, provenance: docProv,
      });
      await store.recordFact({
        entity: 'knee-pain', type: 'symptom', fields: { severity: 'mild' }, provenance: userProv,
      });
      const meds = await store.listByType('medication');
      expect(meds).toHaveLength(2);
      const symptoms = await store.listByType('symptom');
      expect(symptoms).toHaveLength(1);
    });
  });

  describe('A2 — paused entity supersession', () => {
    it('paused entity superseded carries pre_pause_summary + paused status', async () => {
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: docProv,
      });
      // Build the paused state through the PUBLIC pause() API (no private-member hacking).
      await store.pause('metformin', 'medication', docProv, { prePauseSummary: 'Held for surgery' });

      const result = await store.recordFact({
        entity: 'metformin', type: 'medication',
        fields: { dose: '500mg' },
        provenance: docProv,
      });
      expect(result.kind).toBe('needs-confirmation');
      if (result.kind === 'needs-confirmation') {
        expect(result.proposed.status).toBe('paused');
        expect(result.proposed.fields.pre_pause_summary).toBe('Held for surgery');
      }
    });

    it('resume=true on a paused MEDICATION requires confirmation, then produces active (H-1)', async () => {
      // H-1 (medical-safety): resuming a paused med/allergy must NOT bypass the confirmation gate.
      // This test previously asserted an INSTANT `applied` — that was the bypass bug the P1-gate
      // audit flagged. The intent (resume yields an active fact) is preserved via the confirm path.
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: docProv,
      });
      await store.pause('metformin', 'medication', docProv, { prePauseSummary: 'Held for surgery' });

      const result = await store.recordFact({
        entity: 'metformin', type: 'medication',
        fields: { dose: '500mg' },
        provenance: docProv, resume: true,
      });
      expect(result.kind).toBe('needs-confirmation');
      if (result.kind !== 'needs-confirmation') return;
      const fact = await store.confirm(result.token.uuid);
      expect(fact.status).toBe('active');
      const activeNow = await store.getActive('metformin', 'medication');
      expect(activeNow?.id).toBe(fact.id);
      // no version remains paused after the resume is confirmed
      const chain = await store.getChain('metformin', 'medication');
      expect(chain.filter(f => f.status === 'paused')).toHaveLength(0);
    });
  });

  describe('A6 — discontinued restart', () => {
    it('restart of a discontinued med creates a new active version carrying restartOf', async () => {
      await store.recordFact({
        entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: docProv,
      });
      // Actually discontinue (med-class → confirm), then actually restart() — the real contract.
      const disc = await store.discontinue('metformin', 'medication', docProv);
      expect(disc.kind).toBe('needs-confirmation');
      if (disc.kind === 'needs-confirmation') await store.confirm(disc.token.uuid);
      const discontinued = (await store.getChain('metformin', 'medication')).find(f => f.status === 'discontinued')!;

      const res = await store.restart('metformin', 'medication', docProv, { dose: '850mg' });
      expect(res.kind).toBe('needs-confirmation');
      if (res.kind !== 'needs-confirmation') return;
      const fact = await store.confirm(res.token.uuid);
      expect(fact.status).toBe('active');
      expect(fact.fields.restartOf).toBe(discontinued.id);
    });
  });
});
