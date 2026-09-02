import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

import { LedgerStore, NarrativeStore, renderLedgerFile } from '../../src/memcore';
import { fixedClock } from '../helpers/memcore-fixtures';
import type { Provenance } from '../../src/memcore/types';

const fsReal = jest.requireActual<typeof import('fs')>('fs');

const DAY = '2026-08-18T14:30:00.000Z';
const provenance: Provenance = {
  source: 'user',
  confidence: 1,
  anchor: 'memory/2026-08-18.md#L3',
  capturedAt: DAY,
};

describe('RR-9b source-format write amplification', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9b-core-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends narrative content after existing ledger anchors without reading or rewriting history', async () => {
    const store = new NarrativeStore(tmpDir, fixedClock(DAY));
    await store.append({ text: 'first private note' });
    const ledgerAnchor = await store.appendLedgerAnchor('2026-08-18', 'metformin', 'metformin@v1');
    const dayPath = path.join(tmpDir, 'memory', '2026-08-18.md');
    const historyBytes = fs.readFileSync(dayPath);
    const ledgerLine = Number(ledgerAnchor.match(/#L(\d+)$/)?.[1]);

    const readSpy = jest.spyOn(fsReal, 'readFileSync');
    const appendSpy = jest.spyOn(fsReal, 'appendFileSync');
    const renameSpy = jest.spyOn(fsReal, 'renameSync');
    try {
      const appended = await store.append({ text: 'second private note' });

      expect(readSpy).not.toHaveBeenCalled();
      expect(renameSpy).not.toHaveBeenCalled();
      expect(appendSpy).toHaveBeenCalledTimes(1);
      const appendedBytes = Buffer.byteLength(String(appendSpy.mock.calls[0]?.[1] ?? ''), 'utf8');
      expect(appendedBytes).toBeLessThan(historyBytes.byteLength);
      expect(appended.lineStart).toBeGreaterThan(ledgerLine);
    } finally {
      readSpy.mockRestore();
      appendSpy.mockRestore();
      renameSpy.mockRestore();
    }

    const content = await fs.promises.readFile(dayPath, 'utf8');
    const lines = content.split('\n');
    expect(lines[ledgerLine - 1]).toBe('- metformin → metformin@v1');
    expect(lines[Number(ledgerAnchor.match(/#L(\d+)$/)?.[1]) - 1]).toBe('- metformin → metformin@v1');
    expect(content).toContain('second private note');
  });

  it('keeps the accumulated narrative delta hash equal to the source bytes', async () => {
    const store = new NarrativeStore(tmpDir, fixedClock(DAY));
    await store.append({ text: 'first private note' });
    await store.appendLedgerAnchor('2026-08-18', 'metformin', 'metformin@v1');
    await store.append({ text: 'second private note', verbatim: 'exact quote', language: 'hi' });

    const filePath = path.join(tmpDir, 'memory', '2026-08-18.md');
    const delta = store.takeIndexDelta('2026-08-18');
    expect(delta).toBeDefined();
    expect(delta!.hash).toBe(createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'));
    expect(delta!.chunks.some(chunk => chunk.content.includes('second private note'))).toBe(true);
    expect(delta!.chunks.some(chunk => chunk.content.includes('(lang: hi)'))).toBe(true);
  });

  it('reuses parsed ledger facts for warm reads instead of reparsing the type file', async () => {
    const store = new LedgerStore(tmpDir, fixedClock(DAY));
    await store.recordFact({
      entity: 'metformin',
      type: 'medication',
      fields: { dose: '500mg' },
      provenance,
    });

    const readSpy = jest.spyOn(fs.promises, 'readFile');
    try {
      await expect(store.getActive('metformin', 'medication')).resolves.toMatchObject({ version: 1 });
      await expect(store.getChain('metformin', 'medication')).resolves.toHaveLength(1);
      await expect(store.listByType('medication')).resolves.toHaveLength(1);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  it('starts a new Log section at EOF when an external section is the current tail', async () => {
    const store = new NarrativeStore(tmpDir, fixedClock(DAY));
    await store.append({ text: 'first private note' });
    const dayPath = path.join(tmpDir, 'memory', '2026-08-18.md');
    fs.appendFileSync(dayPath, '## Notes\n- external section\n');

    const result = await store.append({ text: 'tail private note' });
    const content = await fs.promises.readFile(dayPath, 'utf8');
    const lines = content.split('\n');
    expect(lines[result.lineStart - 2]).toBe('## Log');
    expect(lines[result.lineStart - 1]).toContain('tail private note');
  });

  it('preserves the canonical header when first touching an existing empty day file', async () => {
    const store = new NarrativeStore(tmpDir, fixedClock(DAY));
    const dayPath = path.join(tmpDir, 'memory', '2026-08-18.md');
    fs.mkdirSync(path.dirname(dayPath), { recursive: true });
    fs.writeFileSync(dayPath, '');

    const result = await store.append({ text: 'first note in an empty file' });
    const lines = (await fs.promises.readFile(dayPath, 'utf8')).split('\n');
    expect(lines.slice(0, 3)).toEqual(['# 2026-08-18', '## Log', '- 14:30 — first note in an empty file']);
    expect(result.lineStart).toBe(3);
  });

  it('emits a final rendered-file hash and delta blocks for a ledger mutation', async () => {
    const store = new LedgerStore(tmpDir, fixedClock(DAY));
    const result = await store.recordFact({
      entity: 'metformin',
      type: 'medication',
      fields: { dose: '500mg' },
      provenance,
    });
    expect(result.kind).toBe('applied');

    const filePath = path.join(tmpDir, 'ledger', 'medications.md');
    const rendered = fs.readFileSync(filePath, 'utf8');
    const delta = store.takeIndexDelta('medication');

    expect(delta).toBeDefined();
    expect(delta!.hash).toBe(createHash('sha256').update(rendered).digest('hex'));
    expect(delta!.entities).toEqual(['metformin']);
    expect(delta!.chunks).toHaveLength(1);
    expect(delta!.chunks[0].content).toContain('metformin');
    expect(store.takeIndexDelta('medication')).toBeUndefined();
  });

  it('keeps cached ledger state byte-equivalent to a fresh parser across lifecycle and link mutations', async () => {
    const clock = fixedClock(DAY);
    const store = new LedgerStore(tmpDir, clock);
    const prov = (entity: string): Provenance => ({
      source: 'user',
      confidence: 1,
      anchor: `memory/${entity}.md#L1`,
      capturedAt: DAY,
    });

    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: prov('medication') });
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { frequency: 'daily' }, provenance: prov('medication') });
    const discontinued = await store.discontinue('metformin', 'medication', prov('medication'));
    if (discontinued.kind === 'needs-confirmation') await store.confirm(discontinued.token.uuid);
    const restarted = await store.restart('metformin', 'medication', prov('medication'), { dose: '500mg' });
    if (restarted.kind === 'needs-confirmation') await store.confirm(restarted.token.uuid);

    await store.recordFact({ entity: 'headache', type: 'symptom', fields: { severity: 'mild' }, provenance: prov('headache') });
    const dispute = await store.recordFact({ entity: 'headache', type: 'symptom', fields: { severity: 'severe' }, provenance: prov('headache') });
    if (dispute.kind === 'disputed') {
      await store.confirm(dispute.disputeToken.uuid, { winningVersion: dispute.versions[0].version });
    }
    await store.recordFact({
      entity: 'migraine',
      type: 'symptom',
      fields: { severity: 'mild' },
      provenance: prov('migraine'),
      corrects: 'headache@v1',
    });

    const filePath = path.join(tmpDir, 'ledger', 'symptoms.md');
    const onDisk = fs.readFileSync(filePath, 'utf8');
    const cachedFacts = await store.listAllOfType('symptom');
    const freshFacts = await new LedgerStore(tmpDir, clock).listAllOfType('symptom');

    expect(renderLedgerFile(cachedFacts)).toBe(onDisk);
    expect(renderLedgerFile(freshFacts)).toBe(onDisk);
    expect(cachedFacts).toEqual(freshFacts);
  });
});
