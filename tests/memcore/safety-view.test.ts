// tests/memcore/safety-view.test.ts
//
// SafetyView — SAFETY.md rendered VIEW (plan Task 4). Acceptance: CONTRA-03, CONTRA-04,
// DAD-11, C6a (no dates anywhere in the file).
//
// Imports the store DIRECTLY (not via the memcore barrel) — the orchestrator owns the
// barrel consolidation pass after Wave B.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SafetyView, SafetyRemovalRefusedError } from '../../src/memcore/safety-view';
import { fact } from '../helpers/memcore-fixtures';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-safety-view-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const safetyFile = () => path.join(tmpDir, 'SAFETY.md');

describe('SafetyView.render', () => {
  it('renders only safetyRelevant active/resolved facts and persists the file 0600 / dir 0700', async () => {
    const sv = new SafetyView(tmpDir);
    const md = await sv.render([
      fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true }),
      fact('diabetes', 'condition', { status: 'resolved', safetyRelevant: true }),
      fact('ibuprofen', 'medication', { status: 'active', safetyRelevant: false }), // not safety-relevant
      fact('metformin', 'medication', { status: 'retracted', safetyRelevant: true }), // not active/resolved
      fact('old-knee', 'condition', { status: 'superseded', safetyRelevant: true }), // not active/resolved
    ]);

    expect(md).toContain('penicillin');
    expect(md).toContain('diabetes');
    expect(md).not.toContain('ibuprofen');
    expect(md).not.toContain('metformin');
    expect(md).not.toContain('old-knee');

    expect(fs.statSync(safetyFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(safetyFile())).mode & 0o777).toBe(0o700);
  });

  it('emits NO date token anywhere in the file (C6a/G3) even when facts carry dates', async () => {
    const sv = new SafetyView(tmpDir);
    const md = await sv.render([
      fact('penicillin', 'allergy', {
        status: 'active',
        safetyRelevant: true,
        createdAt: '2026-08-18T09:12:00.000Z',
        provenance: { source: 'user', confidence: 1, anchor: 'memory/2026-08-12.md#L5', capturedAt: '2026-08-18T09:12:00.000Z' },
      }),
      fact('metformin', 'medication', {
        status: 'active',
        safetyRelevant: true,
        fields: { dose: '850mg 1x/day' },
        createdAt: '2026-03-02T00:00:00.000Z',
      }),
    ]);

    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('renders a medication with its dose as a one-liner', async () => {
    const sv = new SafetyView(tmpDir);
    const md = await sv.render([
      fact('metformin', 'medication', { status: 'active', safetyRelevant: true, fields: { dose: '850mg 1x/day' } }),
    ]);
    expect(md).toMatch(/^## Medications$/m);
    expect(md).toMatch(/^- metformin — 850mg 1x\/day$/m);
  });

  it('is stable across repeated renders — no duplicated sections or entries', async () => {
    const sv = new SafetyView(tmpDir);
    const facts = [fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true })];
    const first = await sv.render(facts);
    const second = await sv.render(facts);
    expect(second).toBe(first);
  });
});

describe('SafetyView Critical Events', () => {
  it('preserves an agent-added Critical Event across re-render, with no date in the file', async () => {
    const sv = new SafetyView(tmpDir);
    await sv.render([fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true })]);
    await sv.addCriticalEvent({ date: '2026-08-12', summary: 'chest pain episode', action: 'advised ER' });
    const md = await sv.render([fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true })]);

    expect(md).toContain('chest pain episode'); // summary rendered
    expect(md).toContain('advised ER'); // action rendered
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}/); // C6a: no date token anywhere in SAFETY.md
    expect(fs.statSync(safetyFile()).mode & 0o777).toBe(0o600);
  });

  it('is add-only — render never drops events and no API removes them', async () => {
    const sv = new SafetyView(tmpDir);
    await sv.addCriticalEvent({ date: '2026-08-01', summary: 'first event' });
    await sv.addCriticalEvent({ date: '2026-08-02', summary: 'second event', action: 'monitored' });

    const md = await sv.render([]);
    expect(md).toContain('first event');
    expect(md).toContain('second event');
    expect(md).toContain('monitored');

    // removeEntry only targets machine-section entries; a Critical Event is not one.
    const after = await sv.removeEntry('first event', { userConfirmed: true });
    expect(after).toContain('first event');
  });

  it('creates the ## Critical Events section on first add even when no file exists yet', async () => {
    const sv = new SafetyView(tmpDir);
    const md = await sv.addCriticalEvent({ date: '2026-08-12', summary: 'chest pain episode', action: 'advised ER' });
    expect(md).toMatch(/^## Critical Events$/m);
    expect(md).toContain('chest pain episode');
  });
});

describe('SafetyView ## Notes (user) preservation', () => {
  it('preserves the user Notes section verbatim across re-render', async () => {
    const sv = new SafetyView(tmpDir);
    await sv.render([fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true })]);
    await fs.promises.appendFile(
      safetyFile(),
      '\n## Notes (user)\n- Shridhar prefers Hindi for health talk.\n- Keep answers short.\n',
    );

    const md = await sv.render([fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true })]);
    expect(md).toContain('## Notes (user)');
    expect(md).toContain('- Shridhar prefers Hindi for health talk.');
    expect(md).toContain('- Keep answers short.');
    expect(md).toContain('penicillin'); // machine section still regenerated alongside
  });

  it('preserves unknown hand-written sections (e.g. emergency contact) on re-render', async () => {
    const sv = new SafetyView(tmpDir);
    await sv.render([]);
    await fs.promises.appendFile(safetyFile(), '\n## Emergency contact\n- wife: (phone)\n');

    const md = await sv.render([fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true })]);
    expect(md).toContain('## Emergency contact');
    expect(md).toContain('- wife: (phone)');
    expect(md).toContain('penicillin');
  });
});

describe('SafetyView.removeEntry', () => {
  it('REFUSES removal of a base allergy entry without user confirmation (CONTRA-03/04)', async () => {
    const sv = new SafetyView(tmpDir);
    await sv.render([fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true })]);

    await expect(sv.removeEntry('penicillin', { userConfirmed: false })).rejects.toThrow(
      SafetyRemovalRefusedError,
    );
    await expect(sv.removeEntry('penicillin', { userConfirmed: false })).rejects.toThrow(
      'Removal of allergy/medication entries from SAFETY.md requires user confirmation',
    );
    // SAFETY.md unchanged
    expect((await sv.read())!).toContain('penicillin');
  });

  it('REFUSES removal of a base medication entry without user confirmation (CONTRA-04 med-class)', async () => {
    const sv = new SafetyView(tmpDir);
    await sv.render([fact('metformin', 'medication', { status: 'active', safetyRelevant: true, fields: { dose: '850mg 1x/day' } })]);

    await expect(sv.removeEntry('metformin', { userConfirmed: false })).rejects.toThrow(
      SafetyRemovalRefusedError,
    );
  });

  it('REFUSES removal of any machine-section entry without user confirmation (stricter-than-spec guard)', async () => {
    const sv = new SafetyView(tmpDir);
    await sv.render([fact('diabetes', 'condition', { status: 'active', safetyRelevant: true })]);
    await expect(sv.removeEntry('diabetes', { userConfirmed: false })).rejects.toThrow(SafetyRemovalRefusedError);
  });

  it('removes an entry from the machine section once the user has confirmed', async () => {
    const sv = new SafetyView(tmpDir);
    await sv.render([
      fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true }),
      fact('diabetes', 'condition', { status: 'active', safetyRelevant: true }),
    ]);
    await fs.promises.appendFile(safetyFile(), '\n## Notes (user)\n- keep this note\n');

    const md = await sv.removeEntry('penicillin', { userConfirmed: true });
    expect(md).not.toContain('penicillin');
    expect(md).toContain('diabetes'); // other machine entries intact
    expect(md).toContain('- keep this note'); // preserved sections intact
  });

  it('is a no-op for an entity not present in the machine sections', async () => {
    const sv = new SafetyView(tmpDir);
    await sv.render([fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true })]);
    const md = await sv.removeEntry('naproxen', { userConfirmed: false });
    expect(md).toContain('penicillin');
  });
});

describe('SafetyView corrupt-file degradation', () => {
  it('degrades to a regenerated file, warns sanitized, and preserves corrupt bytes in a quarantine note', async () => {
    const corrupt = Buffer.from([0x00, 0xff, 0xfe, 0x81, 0x00]).toString('latin1') + '\n## Allergies\n- rotten bytes';
    await fs.promises.writeFile(safetyFile(), corrupt, 'latin1');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const sv = new SafetyView(tmpDir);
      const md = await sv.render([fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true })]);
      expect(md).toContain('penicillin'); // machine sections still regenerated
      expect(md).toContain('PARSE-ERROR'); // constant pointer present
      expect(md).not.toContain('rotten bytes'); // raw bytes NOT inline — side-filed
      expect(warnSpy).toHaveBeenCalled();
      expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      // corrupt bytes preserved in a sidecar, never destroyed
      const sidecar = fs.readdirSync(tmpDir).find(n => n.includes('SAFETY.md.quarantine'));
      expect(sidecar).toBeDefined();
      expect(fs.readFileSync(path.join(tmpDir, sidecar!), 'utf-8')).toContain('rotten bytes');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps the quarantine note across a second render (no one-shot data loss)', async () => {
    const corrupt = Buffer.concat([
      Buffer.from([0xff, 0xfe, 0x81]),
      Buffer.from('\n## Allergies\n- oats'),
    ]);
    await fs.promises.writeFile(safetyFile(), corrupt);
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const sv = new SafetyView(tmpDir);
    const first = await sv.render([]);
    expect(first).toContain('PARSE-ERROR');

    const second = await sv.render([fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true })]);
    expect(second).toContain('PARSE-ERROR'); // pointer survives the re-render
    expect(second).not.toContain('- oats'); // bytes not inline
    expect(second).toContain('penicillin');
    // the bytes remain preserved in the sidecar across renders
    expect(fs.readdirSync(tmpDir).some(n => n.includes('SAFETY.md.quarantine'))).toBe(true);
    jest.restoreAllMocks();
  });
});

describe('SafetyView.read', () => {
  it('returns null when no SAFETY.md exists yet', async () => {
    const sv = new SafetyView(tmpDir);
    expect(await sv.read()).toBeNull();
  });

  it('returns the current on-disk content', async () => {
    const sv = new SafetyView(tmpDir);
    await sv.render([fact('penicillin', 'allergy', { status: 'active', safetyRelevant: true })]);
    const md = await sv.read();
    expect(md).toBe(await fs.promises.readFile(safetyFile(), 'utf-8'));
  });
});