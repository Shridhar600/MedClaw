import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { LLMProvider, Message } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';
import { dateKey, resolveWindow } from '../../src/gateway/session-window';

const fsReal = jest.requireActual<typeof import('fs')>('fs');

describe('RR-6b session and window durability', () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr6b-session-'));
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('falls back to the latest archive EOF for an out-of-range persisted anchor', async () => {
    const manager = new SessionManager({ sessionsPath: sessionsDir });
    await manager.recordTurn('chat-1', [{ role: 'user', content: 'archived turn' }]);

    const dayFile = `${dateKey(new Date())}.jsonl`;
    const windowPath = path.join(sessionsDir, 'session-window.json');
    fs.writeFileSync(windowPath, JSON.stringify({
      summaryBlock: 'stale summary',
      verbatimFrom: { file: dayFile, line: 999999 },
    }));

    expect(resolveWindow(windowPath, sessionsDir)).toEqual({
      summaryBlock: '',
      verbatimFrom: { file: dayFile, line: 1 },
    });
  });

  it('derives the window boundary from physical slots when a middle archive line is malformed', async () => {
    const dayFile = `${dateKey(new Date())}.jsonl`;
    fs.writeFileSync(path.join(sessionsDir, dayFile), [
      JSON.stringify({ timestamp: '2026-08-26T10:00:00.000Z', role: 'user', content: 'first', chatId: 'chat-1' }),
      'not-json',
      JSON.stringify({ timestamp: '2026-08-26T10:01:00.000Z', role: 'assistant', content: 'second', chatId: 'chat-1' }),
      JSON.stringify({ timestamp: '2026-08-26T10:02:00.000Z', role: 'user', content: 'third', chatId: 'chat-1' }),
    ].join('\n') + '\n');
    fs.writeFileSync(
      path.join(sessionsDir, 'session-window.json'),
      JSON.stringify({ summaryBlock: '', verbatimFrom: { file: dayFile, line: 0 } }),
    );

    const manager = new SessionManager({ sessionsPath: sessionsDir });
    await manager.recordTurn('chat-1', [{ role: 'assistant', content: 'fourth' }]);

    const saved = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'session-window.json'), 'utf8'));
    expect(saved.verbatimFrom).toEqual({ file: dayFile, line: 0 });

    const restarted = new SessionManager({ sessionsPath: sessionsDir });
    expect(restarted.getHistory('chat-1').map((message: Message) => message.content)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
  });

  it('anchors compaction bullets to valid physical lines instead of malformed slots', async () => {
    const dayFile = `${dateKey(new Date())}.jsonl`;
    fs.writeFileSync(path.join(sessionsDir, dayFile), [
      JSON.stringify({ timestamp: '2026-08-26T10:00:00.000Z', role: 'user', content: 'old user', chatId: 'chat-1' }),
      'malformed middle slot',
      JSON.stringify({ timestamp: '2026-08-26T10:01:00.000Z', role: 'assistant', content: 'old assistant', chatId: 'chat-1' }),
      JSON.stringify({ timestamp: '2026-08-26T10:02:00.000Z', role: 'user', content: 'recent user', chatId: 'chat-1' }),
      JSON.stringify({ timestamp: '2026-08-26T10:03:00.000Z', role: 'assistant', content: 'recent assistant', chatId: 'chat-1' }),
    ].join('\n') + '\n');
    fs.writeFileSync(
      path.join(sessionsDir, 'session-window.json'),
      JSON.stringify({ summaryBlock: '', verbatimFrom: { file: dayFile, line: 0 } }),
    );

    const provider: LLMProvider = {
      chat: jest.fn().mockResolvedValue({ type: 'text', text: '- old user retained\n- old assistant retained' }),
      embed: jest.fn(),
    };
    const manager = new SessionManager({
      sessionsPath: sessionsDir,
      provider,
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 1 },
    });

    await manager.runCompaction('chat-1');

    const summary = manager.getHistory('chat-1')[0].content as string;
    expect(summary).toContain(`sessions/${dayFile}#L1`);
    expect(summary).toContain(`sessions/${dayFile}#L3`);
    expect(summary).not.toContain(`#L2`);
  });

  it('publishes an empty EOF window before clearing state when the old-window unlink fails', async () => {
    const manager = new SessionManager({ sessionsPath: sessionsDir });
    await manager.recordTurn('chat-1', [{ role: 'user', content: 'pre-new context' }]);

    jest.spyOn(fsReal, 'unlinkSync').mockImplementation(() => {
      throw new Error('simulated unlink failure');
    });

    await manager.resetSession('chat-1');

    const restarted = new SessionManager({ sessionsPath: sessionsDir });
    expect(restarted.getHistory('chat-1')).toEqual([]);
  });

  it('does not trust a torn session migration sentinel', () => {
    const dayFile = `${dateKey(new Date())}.jsonl`;
    fs.writeFileSync(
      path.join(sessionsDir, 'active-chat-1.jsonl'),
      JSON.stringify({ timestamp: '2026-08-26T10:00:00.000Z', role: 'user', content: 'legacy context', chatId: 'chat-1' }) + '\n',
    );
    fs.writeFileSync(path.join(sessionsDir, '.migrated'), '{"version":1');

    new SessionManager({ sessionsPath: sessionsDir });

    expect(fs.readFileSync(path.join(sessionsDir, dayFile), 'utf8')).toContain('legacy context');
    expect(JSON.parse(fs.readFileSync(path.join(sessionsDir, '.migrated'), 'utf8'))).toMatchObject({
      version: 1,
      completed: true,
    });
  });
});
