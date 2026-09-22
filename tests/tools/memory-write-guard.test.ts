import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemoryTools } from '../../src/tools/memory-tools';
import { MemoryEngine } from '../../src/memory/memory-engine';
import type { Tool } from '../../src/tools/types';

// Task 12.6 (G1): memory_write must refuse writes to every invariant-bearing managed path,
// directing the agent to the owning tool. `memory/**` (narrative) and core files stay
// writable (no regression). SAFETY.md removal is an OVERWRITE-drop check, not append.
describe('memory_write managed-path guard (G1 / CONTRA-03)', () => {
  let tmpDir: string;
  let engine: MemoryEngine;
  let write: Tool;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wguard-'));
    engine = new MemoryEngine(tmpDir);
    write = createMemoryTools(engine).find(t => t.name === 'memory_write')!;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const reject = (r: { isError?: boolean }) => expect(r.isError).toBe(true);
  const ok = (r: { isError?: boolean }) => expect(r.isError).toBeFalsy();

  it('rejects a raw overwrite of a ledger file', async () => {
    const r = await write.execute({ path: 'ledger/medications.md', content: '## metformin\nfake', mode: 'overwrite' });
    reject(r);
    expect(r.content[0].text).toMatch(/ledger_record|ledger_update/);
    expect(fs.existsSync(path.join(tmpDir, 'ledger', 'medications.md'))).toBe(false);
  });

  it('rejects an append to a ledger file too', async () => {
    const r = await write.execute({ path: 'ledger/allergies.md', content: '- injected', mode: 'append' });
    reject(r);
  });

  it('rejects a write to MEMORY.md (budget lives in the curated-memory tool)', async () => {
    const r = await write.execute({ path: 'MEMORY.md', content: 'x', mode: 'overwrite' });
    reject(r);
    expect(r.content[0].text).toMatch(/curated|budget|MEMORY/i);
  });

  it('rejects a SAFETY.md overwrite that DROPS a base allergy entry (CONTRA-03)', async () => {
    await engine.writeFile('SAFETY.md', '# Safety\n## Allergies\n- penicillin — anaphylaxis\n## Medications\n- warfarin — 5mg\n');
    const dropped = '# Safety\n## Medications\n- warfarin — 5mg\n'; // penicillin removed
    const r = await write.execute({ path: 'SAFETY.md', content: dropped, mode: 'overwrite' });
    reject(r);
    expect(r.content[0].text).toMatch(/confirm|ledger_update|removal/i);
    // The destructive overwrite did NOT land.
    expect(await engine.readFile('SAFETY.md')).toContain('penicillin');
  });

  it('allows a SAFETY.md overwrite that keeps all base allergy/med entries', async () => {
    await engine.writeFile('SAFETY.md', '# Safety\n## Allergies\n- penicillin — anaphylaxis\n');
    const kept = '# Safety\n## Allergies\n- penicillin — anaphylaxis\n## Critical Events\n- chest pain episode\n';
    const r = await write.execute({ path: 'SAFETY.md', content: kept, mode: 'overwrite' });
    ok(r);
  });

  it('allows an append to SAFETY.md (append cannot remove an entry)', async () => {
    await engine.writeFile('SAFETY.md', '# Safety\n## Allergies\n- penicillin — anaphylaxis\n');
    const r = await write.execute({ path: 'SAFETY.md', content: '## Notes (user)\n- feeling better\n', mode: 'append' });
    ok(r);
  });

  it('rejects writes to episodes/, curiosity.md, .state/, scratch/', async () => {
    reject(await write.execute({ path: 'episodes/e1.md', content: 'x', mode: 'overwrite' }));
    reject(await write.execute({ path: 'curiosity.md', content: 'x', mode: 'overwrite' }));
    reject(await write.execute({ path: '.state/scheduler.json', content: 'x', mode: 'overwrite' }));
    reject(await write.execute({ path: 'scratch/n1.md', content: 'x', mode: 'overwrite' }));
  });

  it('still allows narrative appends under memory/ (no P0 regression)', async () => {
    const r = await write.execute({ path: 'memory/2026-08-12.md', content: '- 10:00 — felt tired\n', mode: 'append' });
    ok(r);
    expect(await engine.readFile('memory/2026-08-12.md')).toContain('felt tired');
  });

  it('still allows writes to core files (SOUL.md, USER.md) — no regression', async () => {
    ok(await write.execute({ path: 'SOUL.md', content: '# Soul\nbe kind', mode: 'overwrite' }));
    ok(await write.execute({ path: 'USER.md', content: '# User\nArjun', mode: 'overwrite' }));
  });

  it('normalizes leading ./ and backslashes when classifying', async () => {
    reject(await write.execute({ path: './ledger/conditions.md', content: 'x', mode: 'overwrite' }));
    reject(await write.execute({ path: 'ledger\\symptoms.md', content: 'x', mode: 'overwrite' }));
  });

  // W-C/D fix pass (PT / SB-1): a raw path whose `..` segments RESOLVE INTO a managed
  // lane must be classified by its normalized target — never slip through on the
  // un-normalized prefix. Residual `..` above the root is refused outright.
  describe('hostile paths — .. segment resolution (PT)', () => {
    it.each([
      ['memory/../ledger/medications.md', /ledger_record|ledger_update|ledger/i],
      ['x/../ledger/allergies.md', /ledger_record|ledger_update|ledger/i],
      ['memory/../MEMORY.md', /curated|budget|MEMORY/i],
      ['episodes/../.state/scheduler.json', /\.state|scheduler/i],
    ])('classifies %s by its resolved target', async (rawPath, msgRe) => {
      const r = await write.execute({ path: rawPath, content: '## injected\nfake', mode: 'overwrite' });
      reject(r);
      expect(r.content[0].text).toMatch(msgRe);
      expect(fs.existsSync(path.join(tmpDir, 'ledger', 'medications.md'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'ledger', 'allergies.md'))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, '.state', 'scheduler.json'))).toBe(false);
    });

    it('refuses paths that traverse ABOVE the workspace root', async () => {
      for (const rawPath of ['../outside.md', 'memory/../../outside.md', '..\\..\\ledger\\x.md', 'a/../b/../../../c.md']) {
        const r = await write.execute({ path: rawPath, content: 'x', mode: 'overwrite' });
        reject(r);
        expect(r.content[0].text).toMatch(/traversal|\.\./i);
      }
    });

    it('still allows clean nested narrative paths (no regression)', async () => {
      ok(await write.execute({ path: 'memory/2026-08-12.md', content: '- ok\n', mode: 'append' }));
      ok(await write.execute({ path: './memory/sub/dir/note.md', content: '# note', mode: 'overwrite' }));
      ok(await write.execute({ path: 'memory/a/../b.md', content: '- resolved inside memory/\n', mode: 'overwrite' }));
      expect(await engine.readFile('memory/b.md')).toContain('resolved inside');
    });
  });
});
