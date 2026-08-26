import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LLMProvider, Message } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';

// P2b Wave D-1 / D1.4 — `prepareHistory` returns the WINDOW: `[summary system message?, ...verbatim
// tail]`, sanitized with `stripOrphanToolMessages` (DD2). The idle soft/hard reset branches are gone
// (DD10). At D1.4 the disk archive + the token-budget compaction auto-trigger are unchanged (D3
// reworks the triggers to real-token thresholds).

describe('prepareHistory window (D1.4)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-win-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const makeProvider = (text: string): LLMProvider => ({
    chat: jest.fn().mockResolvedValue({ type: 'text', text }),
    embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  });

  it('returns [] for an unknown chat (empty window)', async () => {
    const m = new SessionManager({ sessionsPath: dir });
    expect(await m.prepareHistory('nope')).toEqual([]);
  });

  it('returns [summary system message, ...verbatim tail] after compaction', async () => {
    const m = new SessionManager({
      sessionsPath: dir,
      provider: makeProvider('SUMMARY: older turns'),
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 4 },
    });
    for (let i = 0; i < 5; i++) {
      await m.recordTurn('c1', [
        { role: 'user', content: `u${i}` },
        { role: 'assistant', content: `a${i}` },
      ]);
    }
    await m.runCompaction('c1');

    const history = await m.prepareHistory('c1');
    expect(history[0].role).toBe('system');
    expect(history[0].content).toContain('[Previous conversation summary]');
    expect(history[0].content).toContain('SUMMARY: older turns');
    // The verbatim tail (last 4 messages) follows the summary.
    expect(history.slice(1).map((x: Message) => x.content)).toEqual(['u3', 'a3', 'u4', 'a4']);
  });

  it('sanitizes an orphaned trailing assistant+tool_calls out of the returned window (#16)', async () => {
    const m = new SessionManager({ sessionsPath: dir });
    await m.recordTurn('c1', [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }],
      },
    ]);

    const history = await m.prepareHistory('c1');
    // prepareHistory must never emit a trailing assistant+tool_calls with no following tool result.
    expect(history.map((x: Message) => x.role)).toEqual(['user']);
  });
});
