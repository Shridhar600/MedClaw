import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CuratedMemory } from '../../src/memcore';
import { BudgetExceededError } from '../../src/shared/errors';
import { DEFAULT_CONFIG } from '../../src/config/defaults';

// E1.4 — the 60/20/20 MEMORY.md split becomes configurable (config.memory.budgetRatios), while the
// no-cross-category + health-never-evicted invariants stay code-enforced (CHAT-02/05 unchanged).

describe('CuratedMemory configurable budget ratios (E1.4)', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-cm-ratios-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const mkDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-cm-ratios-'));

  it('respects a custom health share (an entry that overflows the default fits the larger budget)', async () => {
    // A single health line of 700 chars renders to 703 bytes: over the default 600 (0.6×1000),
    // under 800 (0.8×1000).
    const big = 'x'.repeat(700);

    const custom = new CuratedMemory(mkDir(), { budgetChars: 1000, budgetRatios: { health: 0.8, life: 0.1, agent: 0.1 } });
    await expect(custom.write('health', big)).resolves.toBeDefined();

    const dflt = new CuratedMemory(mkDir(), { budgetChars: 1000 });
    await expect(dflt.write('health', big)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('renders the H1 budget comment from the effective ratios', async () => {
    const cm = new CuratedMemory(tmp, { budgetChars: 2000, budgetRatios: { health: 0.5, life: 0.3, agent: 0.2 } });
    await cm.write('health', 'hi');
    const md = (await cm.read())!;
    expect(md).toContain('health 50% / life 30% / agent 20%');
  });

  it('defaults to 60/20/20 when no ratios are given (H1 comment unchanged)', async () => {
    const cm = new CuratedMemory(tmp, { budgetChars: 2200 });
    await cm.write('health', 'hi');
    const md = (await cm.read())!;
    expect(md).toContain('health 60% / life 20% / agent 20%');
  });

  it('never evicts a health entry to fit a non-health one, even with custom ratios (CHAT-05)', async () => {
    // life share deliberately tiny so a life append overflows fast; health must be untouched.
    const cm = new CuratedMemory(tmp, { budgetChars: 1000, budgetRatios: { health: 0.9, life: 0.05, agent: 0.05 } });
    await cm.write('health', 'important allergy: penicillin');
    await expect(cm.write('life', 'y'.repeat(200))).rejects.toBeInstanceOf(BudgetExceededError);
    const healthEntries = await cm.entries('health');
    expect(healthEntries).toEqual(['important allergy: penicillin']);
  });

  it('falls back to the default share for any missing/invalid ratio', async () => {
    // Only health provided → life/agent fall back to 0.2 each; a life entry still respects 0.2×1000.
    const cm = new CuratedMemory(mkDir(), { budgetChars: 1000, budgetRatios: { health: 0.6 } });
    const lifeBig = 'z'.repeat(300); // 303 bytes > 200 (0.2×1000)
    await expect(cm.write('life', lifeBig)).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe('config default budget ratios (E1.4)', () => {
  it('DEFAULT_CONFIG.memory.budgetRatios is 60/20/20', () => {
    expect(DEFAULT_CONFIG.memory.budgetRatios).toEqual({ health: 0.6, life: 0.2, agent: 0.2 });
  });
});
