import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from '../../src/gateway/session';

// P2b Wave D-1 / A-M4 — SessionManager gains an options-object constructor (the new canonical shape).
// Expand-contract: the legacy positional form keeps working during D1 (56 call sites) and is removed
// once every caller is migrated. This test pins the new form; the legacy form stays covered by the
// existing session suites.

describe('SessionManager options-object constructor (A-M4)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-opts-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('constructs from an options object and records a turn to sessionsPath', async () => {
    const m = new SessionManager({ sessionsPath: dir, profileId: 'p1' });
    await m.recordTurn('c1', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ]);
    expect(m.getHistory('c1').map((x) => x.content)).toEqual(['hi', 'yo']);
    const today = new Date().toISOString().slice(0, 10);
    expect(fs.existsSync(path.join(dir, `${today}.jsonl`))).toBe(true);
  });

  it('applies defaults when soft/hard reset minutes are omitted', () => {
    const m = new SessionManager({ sessionsPath: dir });
    expect((m as unknown as { softResetMs: number }).softResetMs).toBe(240 * 60 * 1000);
    expect((m as unknown as { hardResetMs: number }).hardResetMs).toBe(1440 * 60 * 1000);
    expect((m as unknown as { profileId: string }).profileId).toBe('default');
  });
});
