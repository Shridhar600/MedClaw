import * as fs from 'fs';
import * as path from 'path';

import { SessionManager, pruneToolResults, PRUNED_TOOL_MARKER, stripOrphanToolMessages } from '../../src/gateway/session';
import { SqliteSessionIndex } from '../../src/indexstore';
import type { Message } from '../../src/providers/types';
import { makeTestTemp } from '../helpers/test-temp';

const tmpDirs: string[] = [];

function tmp(): { sessionsPath: string; dbPath: string } {
  const dir = makeTestTemp('redacted-prune-');
  tmpDirs.push(dir);
  const sessionsPath = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsPath, { recursive: true });
  return { sessionsPath, dbPath: path.join(dir, 'search.db') };
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function turn(n: number, toolContent: string): Message[] {
  return [
    { role: 'user', content: `user turn ${n}` },
    { role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', content: toolContent, tool_call_id: `c${n}` },
  ];
}

describe('pruneToolResults (last 5 turns)', () => {
  it('replaces tool-result content older than the last 5 turns with the marker, keeping recent verbatim', () => {
    const history: Message[] = [];
    for (let n = 1; n <= 7; n++) history.push(...turn(n, `tool result ${n}`));

    const pruned = pruneToolResults(history, 5);

    expect(pruned[2].content).toBe(PRUNED_TOOL_MARKER); // turn 1 tool
    expect(pruned[5].content).toBe(PRUNED_TOOL_MARKER); // turn 2 tool
    expect(pruned[8].content).toBe('tool result 3');
    expect(pruned[20].content).toBe('tool result 7');
  });

  it('preserves tool_call_id and role on a pruned message (tool-group integrity / OpenAI ordering)', () => {
    const history: Message[] = [];
    for (let n = 1; n <= 7; n++) history.push(...turn(n, `tool result ${n}`));
    const pruned = pruneToolResults(history, 5);

    expect(pruned[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: PRUNED_TOOL_MARKER });
    expect(pruned).toHaveLength(history.length);
    expect(stripOrphanToolMessages(pruned)).toHaveLength(history.length);
  });

  it('is a no-op when there are not more than 5 turns', () => {
    const history: Message[] = [];
    for (let n = 1; n <= 5; n++) history.push(...turn(n, `tool result ${n}`));
    expect(pruneToolResults(history, 5)).toEqual(history);
  });
});

describe('window prune (losslessness — the day file / session_search is untouched)', () => {
  it('marks old in-window tool results but session_search still returns the verbatim original', async () => {
    const { sessionsPath, dbPath } = tmp();
    const mgr = new SessionManager({ sessionsPath });
    const index = new SqliteSessionIndex({ dbPath, sessionsDir: sessionsPath });
    mgr.setTurnIndex(index);

    for (let n = 1; n <= 7; n++) {
      await mgr.recordTurn('chat1', turn(n, `glucose reading ${n}80 mgdl`));
    }

    await mgr.recordPromptUsage('chat1', 3000); // 37% of the 8k window → prune
    await mgr.prepareHistory('chat1');

    const history = mgr.getHistory('chat1');
    const firstTool = history.find((m) => m.role === 'tool');
    expect(firstTool?.content).toBe(PRUNED_TOOL_MARKER);

    const res = index.search('glucose reading 180 mgdl');
    index.close();
    expect(res.hits.length).toBeGreaterThanOrEqual(1);
    expect(res.hits.some((h) => h.snippet === 'glucose reading 180 mgdl')).toBe(true);
  });
});
