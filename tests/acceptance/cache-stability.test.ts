import { ContextAssembler } from '../../src/context2';
import type { WorkspaceReader, SafetyReader } from '../../src/context2';
import type { AssemblerRecall } from '../../src/context2/assembler';
import type { Clock } from '../../src/ports';

// P2 E2.4 / PLAT-22 — prefix-cache friendliness. The cacheStable prefix (SAFETY + L2 skeleton) must be
// BYTE-IDENTICAL across consecutive same-mode turns even when the clock advances and recall changes,
// so the provider's prefix cache stays warm. Only the volatile tail (ACTIVE FACTS / RECALL / RUNTIME)
// moves. We assert stability and log the cache-hit ratio (prefix bytes / total bytes).

const SKELETON: Record<string, string> = {
  'SOUL.md': '# Soul\nYou are a careful health companion.',
  'USER.md': '# User\nName: Arjun. Timezone: Asia/Kolkata.',
  'HEALTH_PROFILE.md': '# Health Profile\nType 2 diabetes since 2025.',
  'MEMORY.md': '# Memory\n## Health\n- prefers morning check-ins',
};
const reader: WorkspaceReader = { readFile: async (p) => SKELETON[p] ?? null };
const safety: SafetyReader = { read: async () => '## Allergies\n- penicillin — hives\n## Medications\n- metformin — 500mg' };

function mutableClock(startIso: string): Clock & { advanceDays(n: number): void } {
  let t = new Date(startIso).getTime();
  return { now: () => new Date(t), advanceDays: (n: number) => { t += n * 86_400_000; } };
}

function prefixOf(report: { sections: { content: string }[]; cacheBoundaryIndex: number }): string {
  return report.sections.slice(0, report.cacheBoundaryIndex).map(s => s.content).join('\n');
}

describe('P2 cache-hit stability (PLAT-22)', () => {
  it('keeps the cacheStable prefix byte-identical across turns as the clock + recall change', async () => {
    const clock = mutableClock('2026-08-24T09:00:00.000Z');
    const assembler = new ContextAssembler({ reader, safety, maxChars: 20000, clock });

    const turn1: AssemblerRecall = { ledger: '- metformin (medication) active', hits: [{ id: 'c1', content: 'noted knee soreness' }], checkNotes: '' };
    const report1 = await assembler.assemble('default', 'chat', turn1);

    clock.advanceDays(3); // a later turn — the RUNTIME date changes
    const turn2: AssemblerRecall = { ledger: '- metformin (medication) active — dose: 500mg', hits: [{ id: 'c2', content: 'asked about a workout plan' }], checkNotes: 'CHECK: metformin lists nausea.' };
    const report2 = await assembler.assemble('default', 'chat', turn2);

    const p1 = prefixOf(report1);
    const p2 = prefixOf(report2);
    expect(p2).toBe(p1); // byte-identical cached prefix
    expect(report1.sections.slice(0, report1.cacheBoundaryIndex).every(s => s.cacheStable)).toBe(true);

    // The volatile tail actually differs (proves the boundary is doing work, not that nothing changed).
    expect(report2.content).not.toBe(report1.content);

    // Cache-hit ratio: fraction of the assembled prompt that stayed in the warm prefix.
    const ratio = p2.length / report2.content.length;
    // eslint-disable-next-line no-console
    console.log(`[cache-metric] PLAT-22 prefix-stable=${p2.length}B / total=${report2.content.length}B → cache-hit ratio ${(ratio * 100).toFixed(1)}%`);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it('no clock-derived text leaks into the cached prefix (PLAT-22)', async () => {
    const clock = mutableClock('2026-08-24T09:00:00.000Z');
    const assembler = new ContextAssembler({ reader, safety, maxChars: 20000, clock });
    const report = await assembler.assemble('default', 'chat', { ledger: '', hits: [], checkNotes: '' });
    expect(prefixOf(report)).not.toContain('Today is'); // the RUNTIME date lives below the boundary
  });
});
