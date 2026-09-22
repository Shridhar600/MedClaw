import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SessionManager } from '../../src/gateway/session';
import { SqliteSessionIndex } from '../../src/indexstore';
import { dateKey } from '../../src/gateway/session-window';

const tmpDirs: string[] = [];

function tmp(): { sessionsPath: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-sesswire-'));
  tmpDirs.push(dir);
  const sessionsPath = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsPath, { recursive: true });
  return { sessionsPath, dbPath: path.join(dir, 'search.db') };
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('SessionManager × SqliteSessionIndex wiring (D2.5)', () => {
  test('recordTurn indexes each appended turn so session_search finds it without an explicit rebuild', async () => {
    const { sessionsPath, dbPath } = tmp();
    const mgr = new SessionManager({ sessionsPath });
    const index = new SqliteSessionIndex({ dbPath, sessionsDir: sessionsPath });
    mgr.setTurnIndex(index);

    await mgr.recordTurn('chat1', [
      { role: 'user', content: 'metformin 500mg twice daily' },
      { role: 'assistant', content: 'noted' },
    ]);

    const today = `${dateKey(new Date())}.jsonl`;
    const res = index.search('metformin 500mg twice daily');
    index.close();

    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({ file: today, line: 1, role: 'user', snippet: 'metformin 500mg twice daily' });
  });

  test('a turn with a null-content message still indexes the textual messages at the right line', async () => {
    const { sessionsPath, dbPath } = tmp();
    const mgr = new SessionManager({ sessionsPath });
    const index = new SqliteSessionIndex({ dbPath, sessionsDir: sessionsPath });
    mgr.setTurnIndex(index);

    // assistant tool-call message has null content; the tool result at line 3 must still index at line 3.
    await mgr.recordTurn('chat1', [
      { role: 'user', content: 'check my ibuprofen' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', content: 'ibuprofen 200mg recorded', tool_call_id: 'c1' },
    ]);

    const res = index.search('ibuprofen 200mg recorded');
    index.close();
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0].line).toBe(3);
  });

  test('an indexing failure never blocks the turn (best-effort degrade)', async () => {
    const { sessionsPath } = tmp();
    const mgr = new SessionManager({ sessionsPath });
    mgr.setTurnIndex({
      indexTurn: () => {
        throw new Error('index boom');
      },
    });

    const anchors = await mgr.recordTurn('chat1', [
      { role: 'user', content: 'aspirin' },
      { role: 'assistant', content: 'ok' },
    ]);

    expect(anchors).toHaveLength(2);
    expect(mgr.getHistory('chat1')).toHaveLength(2);
  });

  test('records turns fine when no index is wired at all', async () => {
    const { sessionsPath } = tmp();
    const mgr = new SessionManager({ sessionsPath });
    const anchors = await mgr.recordTurn('chat1', [{ role: 'user', content: 'hi' }]);
    expect(anchors).toHaveLength(1);
  });

  test('sessionsDir getter returns the resolved archive path', () => {
    const { sessionsPath } = tmp();
    const mgr = new SessionManager({ sessionsPath });
    expect(mgr.sessionsDir).toBe(sessionsPath);
  });
});
