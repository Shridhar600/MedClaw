import { sweep } from '../../src/memcore/transcript-sweep';
import type { SweepLexicon } from '../../src/memcore/transcript-sweep';

// A controlled lexicon so the goldens don't couple to the default term set.
const LEX: SweepLexicon = {
  med: ['naproxen', 'metformin', 'insulin', 'lisinopril'],
  symptom: ['headache', 'nausea', 'dizziness'],
  appointment: ['appointment', 'checkup'],
};

const userLine = (content: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ timestamp: '2026-08-30T10:00:00.000Z', role: 'user', content, chatId: 'c1', ...extra });
const asstLine = (content: string) =>
  JSON.stringify({ timestamp: '2026-08-30T10:00:01.000Z', role: 'assistant', content, chatId: 'c1' });

describe('transcript sweep — golden', () => {
  it('files exactly 2 items for 2 planted misses (med critical, symptom not); skips an already-logged mention', () => {
    const lines = [
      userLine('my knee hurts, took naproxen this morning'), // med miss -> critical
      userLine('bad headache all afternoon'),                // symptom miss -> non-critical
      userLine('also started metformin again'),              // metformin WAS logged -> no item
      asstLine('noted, take care of your knee'),             // assistant turn: never mined (would match naproxen? no)
    ];

    const { items } = sweep({
      dayFileLines: lines,
      ledgerEntitiesForDay: new Set(['metformin']),
      existingCuriosity: [],
      lexicon: LEX,
    });

    expect(items).toHaveLength(2);
    const med = items.find(i => i.relatedEntity === 'naproxen');
    const sym = items.find(i => i.relatedEntity === 'headache');
    expect(med).toBeDefined();
    expect(med!.kind).toBe('missing-data');
    expect(med!.critical).toBe(true);
    expect(med!.description).toContain('naproxen');
    expect(med!.description).toContain('yesterday');
    expect(sym).toBeDefined();
    expect(sym!.critical).toBeFalsy();
    // A-L3: med-critical items are selected/ordered first.
    expect(items[0].relatedEntity).toBe('naproxen');
  });
});

describe('transcript sweep — only real user chat turns are mined (A-H1)', () => {
  it('ignores assistant and tool turns', () => {
    const lines = [
      asstLine('you should consider naproxen'),
      JSON.stringify({ timestamp: '2026-08-30T10:00:02.000Z', role: 'tool', content: 'naproxen 500mg', chatId: 'c1', tool_call_id: 't1' }),
    ];
    const { items } = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [], lexicon: LEX });
    expect(items).toEqual([]);
  });

  it('skips a heartbeat-formatted user turn (belt-and-braces marker skip)', () => {
    const lines = [
      userLine('[Heartbeat Trigger]\nJob id: hb-1\nJob title: meds\nPrompt: remind about naproxen and metformin'),
    ];
    const { items } = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [], lexicon: LEX });
    expect(items).toEqual([]);
  });

  it('skips a user turn tagged origin:heartbeat (honors the field when present)', () => {
    const lines = [userLine('took naproxen', { origin: 'heartbeat' })];
    const { items } = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [], lexicon: LEX });
    expect(items).toEqual([]);
  });

  it('mines a user turn with origin:chat (default when absent)', () => {
    const lines = [userLine('took naproxen', { origin: 'chat' })];
    const { items } = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [], lexicon: LEX });
    expect(items.map(i => i.relatedEntity)).toEqual(['naproxen']);
  });
});

describe('transcript sweep — dedup and bounds', () => {
  it('dedups the same entity mentioned across multiple turns to one item', () => {
    const lines = [userLine('took naproxen at 8am'), userLine('naproxen again at noon')];
    const { items } = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [], lexicon: LEX });
    expect(items).toHaveLength(1);
    expect(items[0].relatedEntity).toBe('naproxen');
  });

  it('normalizes case/whitespace for dedup and ledger matching', () => {
    const lines = [userLine('Naproxen and  naproxen  again')];
    const { items } = sweep({
      dayFileLines: lines,
      ledgerEntitiesForDay: new Set(['  METFORMIN ']), // irrelevant here; proves normalize does not crash
      existingCuriosity: [],
      lexicon: LEX,
    });
    expect(items).toHaveLength(1);
    expect(items[0].relatedEntity).toBe('naproxen');
  });

  it('skips an entity already present as an unresolved missing-data curiosity item (kind, relatedEntity)', () => {
    const lines = [userLine('took naproxen'), userLine('bad headache')];
    const { items } = sweep({
      dayFileLines: lines,
      ledgerEntitiesForDay: new Set(),
      existingCuriosity: [
        { id: 'x', profileId: 'p1', kind: 'missing-data', description: 'Did I miss logging naproxen yesterday?', relatedEntity: 'Naproxen', createdAt: '2026-08-29T00:00:00.000Z' },
      ],
      lexicon: LEX,
    });
    expect(items.map(i => i.relatedEntity)).toEqual(['headache']);
  });

  it('caps at 5 items per night, selecting med-critical first', () => {
    const lines = [
      userLine('headache'), userLine('nausea'), userLine('dizziness'), // 3 symptoms (non-critical)
      userLine('naproxen'), userLine('metformin'), userLine('insulin'), userLine('lisinopril'), // 4 meds (critical)
    ];
    const { items } = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [], lexicon: LEX });
    expect(items).toHaveLength(5);
    // all 4 meds selected first, then one symptom
    expect(items.filter(i => i.critical)).toHaveLength(4);
    expect(items.slice(0, 4).every(i => i.critical)).toBe(true);
  });
});

describe('transcript sweep — ledger-events-for-day seam (D4.3)', () => {
  it('files no item for a mention that HAS a same-day ledger event', () => {
    const lines = [userLine('took naproxen today')];
    const { items } = sweep({
      dayFileLines: lines,
      ledgerEntitiesForDay: new Set(['naproxen']),
      existingCuriosity: [],
      lexicon: LEX,
    });
    expect(items).toEqual([]);
  });
});

describe('transcript sweep — number+unit dose patterns', () => {
  it('files a critical dose item when a dose appears with no med keyword in the turn', () => {
    const lines = [userLine('took 500 mg this morning and felt fine')];
    const { items } = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [], lexicon: LEX });
    expect(items).toHaveLength(1);
    expect(items[0].critical).toBe(true);
    expect(items[0].relatedEntity).toBe('500mg');
  });

  it('does not double-count a dose that accompanies a med keyword', () => {
    const lines = [userLine('took naproxen 500mg')];
    const { items } = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [], lexicon: LEX });
    expect(items.map(i => i.relatedEntity)).toEqual(['naproxen']);
  });
});

describe('transcript sweep — resilience', () => {
  it('skips malformed JSONL lines and still mines the valid ones', () => {
    const lines = ['{not json', '', userLine('took naproxen'), 'garbage'];
    const { items } = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [], lexicon: LEX });
    expect(items.map(i => i.relatedEntity)).toEqual(['naproxen']);
  });

  it('uses a sane default lexicon when none is provided', () => {
    const lines = [userLine('took ibuprofen for a headache')];
    const { items } = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [] });
    // default lexicon should recognize at least a common OTC med + a common symptom
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some(i => i.critical)).toBe(true);
  });
});
