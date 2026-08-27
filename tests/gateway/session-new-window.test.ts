import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SessionManager } from '../../src/gateway/session';
import { dateKey, countDayFileLines } from '../../src/gateway/session-window';
import type { Message } from '../../src/providers/types';

const tmpDirs: string[] = [];

function tmpSessions(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-newwin-'));
  tmpDirs.push(dir);
  const sessionsPath = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsPath, { recursive: true });
  return sessionsPath;
}

const turn: Message[] = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi' },
];

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('/new window-archive (DD9)', () => {
  it('clears the in-context window but the day-file archive continues with contiguous line numbers', async () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({ sessionsPath });
    await mgr.recordTurn('chat1', turn); // lines 1-2
    await mgr.recordTurn('chat1', turn); // lines 3-4

    await mgr.resetSession('chat1');
    expect(mgr.getHistory('chat1')).toEqual([]); // fresh context

    const anchors = await mgr.recordTurn('chat1', turn); // must continue at lines 5-6, not reset to 1
    expect(anchors[0].line).toBe(5);
    expect(anchors[1].line).toBe(6);

    const dayFile = path.join(sessionsPath, `${dateKey(new Date())}.jsonl`);
    expect(countDayFileLines(dayFile)).toBe(6);
  });

  it('does not create the retired archive/ or summaries/ directories (day files are the archive)', async () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({ sessionsPath });
    await mgr.recordTurn('chat1', turn);

    await mgr.resetSession('chat1');

    expect(fs.existsSync(path.join(sessionsPath, 'archive'))).toBe(false);
    expect(fs.existsSync(path.join(sessionsPath, 'summaries'))).toBe(false);
  });

  it('drops the window snapshot so a restart resumes an empty context', async () => {
    const sessionsPath = tmpSessions();
    const mgr = new SessionManager({ sessionsPath });
    await mgr.recordTurn('chat1', turn);
    await mgr.resetSession('chat1');

    // Fresh manager over the same dir: nothing to replay (verbatimFrom at EOF ⇒ empty tail).
    const mgr2 = new SessionManager({ sessionsPath });
    expect(mgr2.getHistory('chat1')).toEqual([]);
  });
});
