import * as fs from 'fs';
import { CuratedMemory } from '../../src/memcore';
import { BudgetExceededError } from '../../src/shared/errors';
import { DEFAULT_STORED_CONFIG } from '../../src/config/defaults';
import { makeTestTemp } from '../helpers/test-temp';

describe('CuratedMemory configurable budget ratios', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTestTemp('redacted-cm-ratios-'); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const mkDir = (): string => makeTestTemp('redacted-cm-ratios-');

  it('respects a custom health share (an entry that overflows the default fits the larger budget)', async () => {
    const big = 'x'.repeat(700);

    const custom = new CuratedMemory(mkDir(), { budgetChars: 1000, budgetRatios: { health: 0.8, life: 0.1, agent: 0.1 } });
    await expect(custom.write('health', big)).resolves.toBeDefined();

    const dflt = new CuratedMemory(mkDir(), { budgetChars: 1000 });
    await expect(dflt.write('health', big)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('renders the budget comment from the effective ratios', async () => {
    const cm = new CuratedMemory(tmp, { budgetChars: 2000, budgetRatios: { health: 0.5, life: 0.3, agent: 0.2 } });
    await cm.write('health', 'hi');
    const md = (await cm.read())!;
    expect(md).toContain('health 50% / life 30% / agent 20%');
  });

  it('defaults to 60/20/20 when no ratios are given', async () => {
    const cm = new CuratedMemory(tmp, { budgetChars: 2200 });
    await cm.write('health', 'hi');
    const md = (await cm.read())!;
    expect(md).toContain('health 60% / life 20% / agent 20%');
  });

  it('never evicts a health entry to fit a non-health one, even with custom ratios', async () => {
    const cm = new CuratedMemory(tmp, { budgetChars: 1000, budgetRatios: { health: 0.9, life: 0.05, agent: 0.05 } });
    await cm.write('health', 'important allergy: penicillin');
    await expect(cm.write('life', 'y'.repeat(200))).rejects.toBeInstanceOf(BudgetExceededError);
    const healthEntries = await cm.entries('health');
    expect(healthEntries).toEqual(['important allergy: penicillin']);
  });

  it('falls back to the default share for any missing/invalid ratio', async () => {
    const cm = new CuratedMemory(mkDir(), { budgetChars: 1000, budgetRatios: { health: 0.6 } });
    const lifeBig = 'z'.repeat(300); // 303 bytes > 200 (0.2×1000)
    await expect(cm.write('life', lifeBig)).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe('config default budget ratios', () => {
  it('DEFAULT_STORED_CONFIG.memory.budgetRatios is 60/20/20', () => {
    expect(DEFAULT_STORED_CONFIG.memory.budgetRatios).toEqual({ health: 0.6, life: 0.2, agent: 0.2 });
  });
});
