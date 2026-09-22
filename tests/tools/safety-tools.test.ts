import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSafetyTools } from '../../src/tools/safety-tools';
import { SafetyView } from '../../src/memcore';
import { mutableClock } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';

describe('safety_note (Task 12.5)', () => {
  let tmp: string;
  let view: SafetyView;
  let tool: Tool;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-safetytool-'));
    view = new SafetyView(tmp, mutableClock('2026-08-20T10:00:00.000Z'));
    tool = createSafetyTools({ safetyView: view }).find(t => t.name === 'safety_note')!;
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('adds a critical event to SAFETY.md (always allowed), date-free (C6a)', async () => {
    const r = await tool.execute({ action: 'add-critical-event', summary: 'chest pain episode', action_taken: 'advised ER', date: '2026-08-12' });
    expect(r.isError).toBeFalsy();
    const md = await view.read();
    expect(md).toContain('chest pain episode');
    expect(md).toContain('advised ER');
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}/); // C6a: no date token in SAFETY.md
  });

  it('rejects add-critical-event without a summary', async () => {
    const r = await tool.execute({ action: 'add-critical-event' });
    expect(r.isError).toBe(true);
  });

  it('refuses propose-removal and routes to ledger_update (CONTRA-03/04)', async () => {
    await view.render([]); // ensure SAFETY.md exists
    const r = await tool.execute({ action: 'propose-removal', entity: 'penicillin' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/ledger_update|confirm/i);
  });
});
