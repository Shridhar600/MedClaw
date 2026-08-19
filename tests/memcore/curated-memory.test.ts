// tests/memcore/curated-memory.test.ts
//
// CuratedMemory — MEMORY.md budget engine (plan Task 6). Acceptance: CHAT-02 (60/20/20,
// fail-loud, no cross-category eviction), CHAT-05 (non-health never evicts health),
// CHAT-03 engine half (health bytes untouched on overflow, currentEntries surfaced).
// Merge-ordering is a P3 L1-manual model instruction (D6/F11) — NOT asserted here.
//
// Imports the store DIRECTLY (not via the memcore barrel) — the orchestrator owns the
// barrel consolidation pass after Wave B.
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CuratedMemory } from '../../src/memcore/curated-memory';
import { BudgetExceededError } from '../../src/shared/errors';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-curated-memory-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const memoryFile = () => path.join(tmpDir, 'MEMORY.md');

const readHealthSection = async (): Promise<string> => {
  const md = await fs.promises.readFile(memoryFile(), 'utf-8');
  const match = md.match(/^## Health <!--.*?-->\n([\s\S]*?)(?=\n## )/m);
  return match ? match[1] : '';
};

describe('CuratedMemory.write', () => {
  it('appends a bullet entry, writes the gauge line, and persists 0600 / dir 0700', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 1000 });
    const entries = await cm.write('health', 'metformin → ledger: metformin');

    expect(entries).toEqual(['metformin → ledger: metformin']);

    const md = await fs.promises.readFile(memoryFile(), 'utf-8');
    expect(md).toContain('- metformin → ledger: metformin');
    expect(md).toMatch(/^## Health <!-- \d+\/\d+ chars used \(\d+%\) -->$/m);
    expect(fs.statSync(memoryFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(memoryFile())).mode & 0o777).toBe(0o700);
  });

  it('builds the fixed section skeleton on first write (all three budgeted sections)', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 });
    await cm.write('health', 'a');

    const md = await fs.promises.readFile(memoryFile(), 'utf-8');
    expect(md).toMatch(/^# Memory <!-- budget: 2,200 chars · health 60% \/ life 20% \/ agent 20% -->$/m);
    expect(md).toMatch(/^## Health /m);
    expect(md).toMatch(/^## Life /m);
    expect(md).toMatch(/^## Agent notes /m);
  });

  it('enforces independent 60/20/20 budgets — life overflows against its own 200-char share', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 1000 }); // health 600 / life 200 / agent 200
    await cm.write('health', 'metformin 850mg');
    await cm.write('life', 'y'.repeat(197)); // fills life to exactly its 200-char budget
    const healthBefore = await readHealthSection();

    const err = await cm.write('life', 'z').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    const be = err as BudgetExceededError;
    expect(be.section).toBe('life');
    expect(be.message).toBe('Life budget exceeded (200/200 chars used). Merge required.');
    expect(be.currentEntries).toEqual(['y'.repeat(197)]);
    expect(await readHealthSection()).toBe(healthBefore); // health never touched
  });

  it('throws BudgetExceededError with the CHAT-02 message when a category is full', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 }); // health 1320
    await cm.write('health', 'x'.repeat(1317)); // fills health to exactly 1320

    await expect(cm.write('health', 'y')).rejects.toThrow(
      'Health budget exceeded (1,320/1,320 chars used). Merge required.',
    );
  });

  it('throws BudgetExceededError carrying section, gauge, and currentEntries; file untouched (CHAT-03 engine half)', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 });
    await cm.write('health', 'metformin 850mg daily');
    const before = await fs.promises.readFile(memoryFile(), 'utf-8');

    const err = await cm.write('health', 'x'.repeat(5000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    const be = err as BudgetExceededError;
    expect(be.section).toBe('health');
    expect(be.gauge).toBeGreaterThan(0);
    expect(be.gauge).toBeLessThanOrEqual(1);
    expect(be.currentEntries).toEqual(['metformin 850mg daily']);
    expect(be.currentEntries).toContain('metformin 850mg daily');

    // Health bytes untouched on overflow — nothing partial was written.
    const after = await fs.promises.readFile(memoryFile(), 'utf-8');
    expect(after).toBe(before);
  });

  it('never evicts a health entry to fit a non-health one (CHAT-05)', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 });
    const healthBefore = ['take metformin with food', 'allergic to penicillin'];
    for (const e of healthBefore) await cm.write('health', e);

    // Life budget is small (440) — overfill it.
    await expect(cm.write('life', 'y'.repeat(1000))).rejects.toThrow(BudgetExceededError);

    const healthAfter = await readHealthSection();
    for (const e of healthBefore) expect(healthAfter).toContain(`- ${e}`);
  });

  it('a successful life write leaves full-health bytes untouched (no cross-category eviction, CHAT-02)', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 });
    const healthLines = ['metformin 850mg', 'penicillin allergy', 'diabetes type 2'];
    for (const e of healthLines) await cm.write('health', e);
    const before = await readHealthSection();

    await cm.write('life', 'loves Nolan films');
    expect(await readHealthSection()).toBe(before);
  });
});

describe('CuratedMemory.replace', () => {
  it('writes a merged set within budget (the in-turn merge path)', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 });
    await cm.write('health', 'metformin 850mg');
    await cm.write('health', 'aspirin 75mg');

    const merged = await cm.replace('health', ['metformin 850mg']); // agent pruned one
    expect(merged).toEqual(['metformin 850mg']);

    const md = await fs.promises.readFile(memoryFile(), 'utf-8');
    expect(md).toContain('- metformin 850mg');
    expect(md).not.toContain('- aspirin 75mg');
  });

  it('throws fail-loud when the merged set still exceeds the budget; file untouched', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 });
    await cm.write('health', 'existing note');
    const before = await fs.promises.readFile(memoryFile(), 'utf-8');

    const err = await cm.replace('health', ['x'.repeat(2000)]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    const be = err as BudgetExceededError;
    expect(be.section).toBe('health');
    expect(be.currentEntries).toEqual(['existing note']); // current on-disk entries relayed for merge
    expect(await fs.promises.readFile(memoryFile(), 'utf-8')).toBe(before);
  });
});

describe('CuratedMemory.entries', () => {
  it('returns the current entry texts for a section (empty when section has none)', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 });
    expect(await cm.entries('health')).toEqual([]);

    await cm.write('health', 'a');
    await cm.write('health', 'b');
    expect(await cm.entries('health')).toEqual(['a', 'b']);
    expect(await cm.entries('life')).toEqual([]);
  });
});

describe('CuratedMemory corrupt-file degradation', () => {
  it('degrades to empty sections, warns sanitized, and preserves corrupt bytes in a quarantine note', async () => {
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xfe, 0x81]), Buffer.from('\n## Health\n- broken bytes')]);
    await fs.promises.writeFile(memoryFile(), corrupt);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 });
      const entries = await cm.write('health', 'fresh entry');
      expect(entries).toEqual(['fresh entry']);

      const md = await fs.promises.readFile(memoryFile(), 'utf-8');
      expect(md).toContain('- fresh entry'); // write still lands
      expect(md).toContain('PARSE-ERROR'); // constant pointer present
      expect(md).not.toContain('broken bytes'); // raw bytes NOT inline — side-filed
      expect(warnSpy).toHaveBeenCalled();
      // corrupt bytes preserved in a sidecar
      const sidecar = fs.readdirSync(tmpDir).find(n => n.includes('MEMORY.md.quarantine'));
      expect(sidecar).toBeDefined();
      expect(fs.readFileSync(path.join(tmpDir, sidecar!), 'utf-8')).toContain('broken bytes');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('CuratedMemory.read', () => {
  it('returns null when no MEMORY.md exists yet', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 });
    expect(await cm.read()).toBeNull();
  });

  it('returns the current on-disk content', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 });
    await cm.write('health', 'a');
    expect(await cm.read()).toBe(await fs.promises.readFile(memoryFile(), 'utf-8'));
  });

  it('preserves unknown hand-written sections across writes', async () => {
    const cm = new CuratedMemory(tmpDir, { budgetChars: 2200 });
    await cm.write('health', 'a');
    await fs.promises.appendFile(memoryFile(), '\n## Habits\n- morning walk\n');

    await cm.write('life', 'loves Nolan films');
    const md = await cm.read();
    expect(md).toContain('## Habits');
    expect(md).toContain('- morning walk');
  });
});