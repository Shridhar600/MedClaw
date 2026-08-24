import {
  ContextAssembler,
  assertCacheDiscipline,
  type WorkspaceReader,
  type SafetyReader,
  type AssemblerRecall,
  type ContextSection,
} from '../../src/context2';
import { fixedClock } from '../helpers/memcore-fixtures';
import { InvariantViolationError } from '../../src/shared/errors';

// ---- fakes -------------------------------------------------------------------

function makeReader(files: Record<string, string>): WorkspaceReader {
  return { async readFile(rel: string) { return Object.prototype.hasOwnProperty.call(files, rel) ? files[rel] : null; } };
}
function makeSafety(content: string | null): SafetyReader {
  return { async read() { return content; } };
}

const CLOCK = fixedClock('2026-08-24T10:00:00.000Z');

// A fully-populated skeleton (no date tokens inside the file bytes).
const FULL_FILES: Record<string, string> = {
  'SOUL.md': 'You are a caring health companion.',
  'HEALTH_PROFILE.md': 'Name: Sam. Age band: 30s.',
  'USER.md': 'Prefers concise answers.',
  'HEARTBEAT.md': '- morning check-in\n- evening review',
  'MEMORY.md': 'Long-term: enjoys running.',
};

const SAFETY = '## Allergies\n- penicillin\n## Medications\n- metformin — 1000mg';

const RECALL: AssemblerRecall = {
  ledger: '- metformin (medication) active — dose: 1000mg\n- penicillin (allergy) active',
  hits: [
    { id: 'narrative:2026-06-01#L2', content: 'felt shaky after metformin' },
    { id: 'episode:knee-1#L1', content: 'MCL sprain, avoid heavy leg loading' },
  ],
  checkNotes: 'CHECK: metformin lists nausea as a known side effect.',
};

function make(files: Record<string, string>, safety: string | null, maxChars = 100_000): ContextAssembler {
  return new ContextAssembler({ reader: makeReader(files), safety: makeSafety(safety), maxChars, clock: CLOCK });
}

function keys(sections: ContextSection[]): string[] {
  return sections.map(s => s.key);
}
function aboveBoundary(report: { sections: ContextSection[]; cacheBoundaryIndex: number }): ContextSection[] {
  return report.sections.slice(0, report.cacheBoundaryIndex);
}
function belowBoundary(report: { sections: ContextSection[]; cacheBoundaryIndex: number }): ContextSection[] {
  return report.sections.slice(report.cacheBoundaryIndex);
}

// ---- tests -------------------------------------------------------------------

describe('ContextAssembler v2 — chat-mode injection map (C1)', () => {
  it('constructs with injected readers without throwing', () => {
    expect(() => make(FULL_FILES, SAFETY)).not.toThrow();
  });

  it('emits the spec-14 section order with the cache boundary after the skeleton', async () => {
    const report = await make(FULL_FILES, SAFETY).assemble('default', 'chat', RECALL);
    expect(keys(report.sections)).toEqual([
      'SAFETY.md', 'SOUL.md', 'HEALTH_PROFILE.md', 'USER.md', 'HEARTBEAT.md', 'MEMORY.md',
      'active-ledger', 'recall', 'check', 'runtime',
    ]);
    // Skeleton (SAFETY + 5 files) is above the boundary; recall/check/runtime below.
    expect(report.cacheBoundaryIndex).toBe(6);
    expect(aboveBoundary(report).every(s => s.cacheStable)).toBe(true);
    expect(belowBoundary(report).every(s => !s.cacheStable)).toBe(true);
  });

  it('places SAFETY first and marks it non-truncatable', async () => {
    const report = await make(FULL_FILES, SAFETY).assemble('default', 'chat', RECALL);
    expect(report.sections[0].key).toBe('SAFETY.md');
    expect(report.sections[0].nonTruncatable).toBe(true);
    expect(report.sections[0].cacheStable).toBe(true);
  });

  it('injects SAFETY in full and never truncates it even under a tiny budget (differential truncation)', async () => {
    const bigSoul = 'X'.repeat(4000);
    const report = await make({ ...FULL_FILES, 'SOUL.md': bigSoul }, SAFETY, 80).assemble('default', 'chat', RECALL);
    // SAFETY present verbatim regardless of budget.
    expect(report.content).toContain(SAFETY);
    const safetySection = report.sections.find(s => s.key === 'SAFETY.md')!;
    expect(safetySection.content).toBe(SAFETY);
    // Something got truncated/dropped under the tiny budget.
    expect(report.truncated).toBe(true);
    // The oversized SOUL did not survive in full.
    expect(report.content).not.toContain(bigSoul);
  });

  it('skips an empty SAFETY (PLAT-04) and does not throw the invariant', async () => {
    const report = await make(FULL_FILES, '   ').assemble('default', 'chat', RECALL);
    expect(keys(report.sections)).not.toContain('SAFETY.md');
    expect(report.sections[0].key).toBe('SOUL.md');
  });

  it('renders recalled hits WITH their ids so the model can cite them in <used> (H-3/B7)', async () => {
    const report = await make(FULL_FILES, SAFETY).assemble('default', 'chat', RECALL);
    const recall = report.sections.find(s => s.key === 'recall')!;
    expect(recall.content).toContain('[narrative:2026-06-01#L2]');
    expect(recall.content).toContain('felt shaky after metformin');
    expect(recall.content).toContain('[episode:knee-1#L1]');
  });

  it('injects the Stage-1 active-ledger one-liners and Stage-3 CHECK notes below the boundary', async () => {
    const report = await make(FULL_FILES, SAFETY).assemble('default', 'chat', RECALL);
    const ledger = report.sections.find(s => s.key === 'active-ledger')!;
    const check = report.sections.find(s => s.key === 'check')!;
    expect(ledger.content).toContain('metformin (medication) active');
    expect(check.content).toContain('CHECK: metformin lists nausea');
    expect(ledger.cacheStable).toBe(false);
    expect(check.cacheStable).toBe(false);
  });

  it('the runtime clock date lives ONLY below the cache boundary (PLAT-22 / H-2)', async () => {
    const report = await make(FULL_FILES, SAFETY).assemble('default', 'chat', RECALL);
    const above = aboveBoundary(report).map(s => s.content).join('\n');
    const runtime = report.sections.find(s => s.key === 'runtime')!;
    expect(above).not.toContain('2026-08-24');
    expect(runtime.cacheStable).toBe(false);
    expect(runtime.content).toContain('2026-08-24');
  });

  it('omits volatile recall sections at boot (null recall) but keeps skeleton + runtime and the SAFETY invariant', async () => {
    const report = await make(FULL_FILES, SAFETY).assemble('default', 'chat', null);
    expect(keys(report.sections)).not.toContain('recall');
    expect(keys(report.sections)).not.toContain('active-ledger');
    expect(keys(report.sections)).not.toContain('check');
    expect(keys(report.sections)).toContain('SAFETY.md');
    expect(keys(report.sections)).toContain('runtime');
    expect(report.content).toContain(SAFETY);
  });

  it('skips missing optional skeleton files', async () => {
    const report = await make({ 'SOUL.md': FULL_FILES['SOUL.md'] }, SAFETY).assemble('default', 'chat', RECALL);
    const k = keys(report.sections);
    expect(k).toContain('SOUL.md');
    expect(k).not.toContain('USER.md');
    expect(k).not.toContain('MEMORY.md');
    expect(k).not.toContain('HEALTH_PROFILE.md');
    expect(k).not.toContain('HEARTBEAT.md');
  });

  it('retires the blanket daily-log dump in favor of RECALL (parity — no silent vanish)', async () => {
    // Even if today's/yesterday's logs exist on disk, the assembler does not read them as sections.
    const withLogs = {
      ...FULL_FILES,
      'memory/2026-08-24.md': 'TODAY-LOG-UNIQUE-BODY',
      'memory/2026-08-23.md': 'YESTERDAY-LOG-UNIQUE-BODY',
    };
    const report = await make(withLogs, SAFETY).assemble('default', 'chat', RECALL);
    expect(report.content).not.toContain('TODAY-LOG-UNIQUE-BODY');
    expect(report.content).not.toContain('YESTERDAY-LOG-UNIQUE-BODY');
    expect(keys(report.sections).some(k => k.startsWith('memory/'))).toBe(false);
  });

  it('never drops the RUNTIME date line under budget pressure (L-1)', async () => {
    const bigSoul = 'X'.repeat(8000);
    const report = await make({ ...FULL_FILES, 'SOUL.md': bigSoul }, SAFETY, 60).assemble('default', 'chat', RECALL);
    const runtime = report.sections.find(s => s.key === 'runtime');
    expect(runtime).toBeDefined();
    expect(runtime!.content).toContain('2026-08-24');
    expect(report.content).toContain('2026-08-24');
  });

  it('reports totalTokens as ceil(totalChars/4)', async () => {
    const report = await make(FULL_FILES, SAFETY).assemble('default', 'chat', RECALL);
    expect(report.totalChars).toBe(report.content.length);
    expect(report.totalTokens).toBe(Math.ceil(report.content.length / 4));
  });
});

describe('ContextAssembler v2 — SAFETY fails closed (H-1)', () => {
  it('aborts the turn when a present SAFETY cannot be read (never ships a SAFETY-less prompt)', async () => {
    const throwingSafety: SafetyReader = { async read() { throw new Error('EACCES: permission denied'); } };
    const asm = new ContextAssembler({
      reader: makeReader(FULL_FILES), safety: throwingSafety, maxChars: 100_000, clock: CLOCK,
    });
    await expect(asm.assemble('default', 'chat', RECALL)).rejects.toThrow();
  });

  it('still treats a genuinely absent/empty SAFETY as allowed (PLAT-04, no throw)', async () => {
    const asm = new ContextAssembler({
      reader: makeReader(FULL_FILES), safety: makeSafety(null), maxChars: 100_000, clock: CLOCK,
    });
    await expect(asm.assemble('default', 'chat', RECALL)).resolves.toBeDefined();
  });
});

describe('ContextAssembler v2 — turn modes (C2)', () => {
  it('heartbeat is lite: SAFETY + checklist + active-ledger, but no MEMORY/USER and no user-recall', async () => {
    const report = await make(FULL_FILES, SAFETY).assemble('default', 'heartbeat', RECALL);
    const k = keys(report.sections);
    expect(k).toContain('SAFETY.md');
    expect(k).toContain('HEARTBEAT.md');
    expect(k).toContain('active-ledger');
    expect(k).not.toContain('MEMORY.md');
    expect(k).not.toContain('USER.md');
    expect(k).not.toContain('recall');
    expect(k).not.toContain('check');
  });

  it('heartbeat injects Stage-1 active-ledger facts (KNEE-02)', async () => {
    const report = await make(FULL_FILES, SAFETY).assemble('default', 'heartbeat', RECALL);
    const ledger = report.sections.find(s => s.key === 'active-ledger')!;
    expect(ledger.content).toContain('metformin (medication) active');
  });

  it('subagent is PHI-minimal: never SAFETY/SOUL/USER/MEMORY/recall, and leaks no PHI (KNEE-05 half)', async () => {
    const report = await make(FULL_FILES, SAFETY).assemble('default', 'subagent', RECALL);
    const k = keys(report.sections);
    expect(k).not.toContain('SAFETY.md');
    expect(k).not.toContain('SOUL.md');
    expect(k).not.toContain('USER.md');
    expect(k).not.toContain('MEMORY.md');
    expect(k).not.toContain('HEALTH_PROFILE.md');
    expect(k).not.toContain('active-ledger');
    expect(k).not.toContain('recall');
    // No PHI reaches an isolated subagent, even though SAFETY.md + recall exist on the profile.
    expect(report.content).not.toContain('penicillin');
    expect(report.content).not.toContain('felt shaky after metformin');
  });

  it('subagent does not throw the SAFETY invariant (SAFETY is intentionally excluded)', async () => {
    await expect(make(FULL_FILES, SAFETY).assemble('default', 'subagent', RECALL)).resolves.toBeDefined();
  });

  it('dreaming excludes persona/user/memory and user-recall (consolidation turn)', async () => {
    const report = await make(FULL_FILES, SAFETY).assemble('default', 'dream', RECALL);
    const k = keys(report.sections);
    expect(k).not.toContain('SOUL.md');
    expect(k).not.toContain('USER.md');
    expect(k).not.toContain('MEMORY.md');
    expect(k).not.toContain('recall');
    // Safety context is retained for a consolidation turn over the user's own health memory.
    expect(k).toContain('SAFETY.md');
  });
});

describe('assertCacheDiscipline (C1.3 structural guard)', () => {
  const stable = (key: string): ContextSection => ({ key, title: key, layer: 2, cacheStable: true, budget: 100, content: 'x' });
  const volatile = (key: string): ContextSection => ({ key, title: key, layer: 3, cacheStable: false, budget: 100, content: 'y' });

  it('accepts a contiguous stable→volatile partition', () => {
    expect(() => assertCacheDiscipline([stable('a'), stable('b'), volatile('c')])).not.toThrow();
  });

  it('throws when a cacheStable section follows a volatile one', () => {
    expect(() => assertCacheDiscipline([stable('a'), volatile('c'), stable('b')]))
      .toThrow(InvariantViolationError);
  });
});
