import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContextAssembler } from '../../src/agent/context';
import { MemoryEngine } from '../../src/memory/memory-engine';

describe('ContextAssembler', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let assembler: ContextAssembler;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-ctx-'));
    engine = new MemoryEngine(tmpDir);
    assembler = new ContextAssembler(engine, 20000);

    await engine.writeFile('SOUL.md', '# SOUL\nYou are a health companion.');
    await engine.writeFile('HEALTH_PROFILE.md', '# Health\nDiabetes Type 2.');
    await engine.writeFile('USER.md', '# User\nName: Arjun');
    await engine.writeFile('HEARTBEAT.md', '# Heartbeat\nPhase 3 not implemented.');
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true }));

  it('assembles system prompt from core files', async () => {
    const messages = await assembler.buildSystemMessages();
    const combined = messages.map(m => m.content).join('\n');
    expect(combined).toContain('You are a health companion');
    expect(combined).toContain('Diabetes Type 2');
    expect(combined).toContain('Arjun');
  });

  it('includes todays memory log if present', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await engine.writeFile(`memory/${today}.md`, '# Log\n- Had oats for breakfast');
    const messages = await assembler.buildSystemMessages();
    const combined = messages.map(m => m.content).join('\n');
    expect(combined).toContain('Had oats for breakfast');
  });

  it('skips missing optional files gracefully', async () => {
    // HEARTBEAT.md and MEMORY.md not created — should not throw
    await expect(assembler.buildSystemMessages()).resolves.not.toThrow();
  });

  it('truncates oversized core files safely with explicit markers', async () => {
    assembler = new ContextAssembler(engine, 400);
    await engine.writeFile('SOUL.md', 'A'.repeat(900) + '🙂');
    await engine.writeFile('HEALTH_PROFILE.md', 'B'.repeat(900));

    const messages = await assembler.buildSystemMessages();
    const system = messages[0].content ?? '';

    expect(system.length).toBeLessThanOrEqual(400);
    expect(system).toContain('[TRUNCATED SOUL.md');
    expect(system).not.toContain('\uFFFD');
  });

  it('enforces total bootstrap cap and stable file priority order', async () => {
    assembler = new ContextAssembler(engine, 900);
    await engine.writeFile('MEMORY.md', 'M'.repeat(500));
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await engine.writeFile(`memory/${today}.md`, 'T'.repeat(500));
    await engine.writeFile(`memory/${yesterday}.md`, 'Y'.repeat(500));

    const messages = await assembler.buildSystemMessages();
    const system = messages[0].content ?? '';

    expect(system.length).toBeLessThanOrEqual(900);
    expect(system.indexOf('## SOUL.md')).toBeLessThan(system.indexOf('## HEALTH_PROFILE.md'));
    expect(system.indexOf('## HEALTH_PROFILE.md')).toBeLessThan(system.indexOf('## USER.md'));
    expect(system.indexOf('## USER.md')).toBeLessThan(system.indexOf('## HEARTBEAT.md'));
  });

  it('keeps today/yesterday logs within remaining budget without overflow', async () => {
    assembler = new ContextAssembler(engine, 320);
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await engine.writeFile(`memory/${today}.md`, 'today-'.repeat(200));
    await engine.writeFile(`memory/${yesterday}.md`, 'yesterday-'.repeat(200));

    const messages = await assembler.buildSystemMessages();
    const system = messages[0].content ?? '';

    expect(system.length).toBeLessThanOrEqual(320);
    expect(system).toContain("Today's Log");
    expect(system).not.toContain("Yesterday's Log");
  });

  it('injects a non-empty SAFETY.md in full and never truncates it (PLAT-05)', async () => {
    const safety = '# SAFETY\n' + 'ALLERGY: penicillin — anaphylaxis. '.repeat(40);
    await engine.writeFile('SAFETY.md', safety);
    // Tiny budget, far smaller than SAFETY.md — the budget must NOT cut SAFETY.md.
    assembler = new ContextAssembler(engine, 500);

    const messages = await assembler.buildSystemMessages();
    const system = messages[0].content ?? '';

    expect(system).toContain(safety); // full, verbatim
    expect(system).not.toContain('[TRUNCATED SAFETY.md'); // exempt from fitContent
  });

  it('places SAFETY.md before the budgeted core sections', async () => {
    await engine.writeFile('SAFETY.md', '# SAFETY\n- ALLERGY: penicillin — anaphylaxis');
    const messages = await assembler.buildSystemMessages();
    const system = messages[0].content ?? '';

    expect(system.indexOf('## SAFETY.md')).toBeGreaterThanOrEqual(0);
    expect(system.indexOf('## SAFETY.md')).toBeLessThan(system.indexOf('## SOUL.md'));
  });

  it('skips an empty SAFETY.md and builds normally (PLAT-04)', async () => {
    await engine.writeFile('SAFETY.md', '   \n\t  ');
    const messages = await assembler.buildSystemMessages();
    const system = messages[0].content ?? '';

    expect(system).not.toContain('## SAFETY.md'); // empty => skipped, no dangling header
    expect(system).toContain('You are a health companion');
  });

  it('builds normally when SAFETY.md is absent', async () => {
    const messages = await assembler.buildSystemMessages();
    expect(messages[0].content).toContain('You are a health companion');
  });
});
