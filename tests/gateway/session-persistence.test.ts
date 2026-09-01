import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { LLMProvider, Message } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';

// The raw CJS module object — spyable, unlike the ts-jest __importStar clone
// produced by `import * as fs`, whose getter-only properties reject spyOn.
const fsReal = jest.requireActual<typeof import('fs')>('fs');

describe('SessionManager JSONL Persistence', () => {
  let tmpDir: string;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-session-'));
    manager = new SessionManager(240, 1440, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  // P2b/D1.6: turns are appended to the day-file archive (the active file is gone).
  const dayFile = (): string => path.join(tmpDir, new Date().toISOString().slice(0, 10) + '.jsonl');

  it('appends user and assistant turns to the day-file archive', async () => {
    await manager.addTurn('chat1', { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi there' });
    expect(fs.existsSync(dayFile())).toBe(true);
    const lines = fs.readFileSync(dayFile(), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
  });

  // P2b/D1.5: reconstruction now reads the day-file archive + window (not the active file). Round-trip
  // through the real persist path (recordTurn writes both) rather than hand-crafting the on-disk file.
  it('reconstructs history from the archive + window on startup', async () => {
    await manager.recordTurn('chat1', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);

    const manager2 = new SessionManager(240, 1440, tmpDir);
    const history = manager2.getHistory('chat1');
    expect(history.length).toBe(2);
    expect(history[0].content).toBe('Hello');
  });

  // P2b/D3.6 (DD9): the archive/ + summaries/ side-files + generateSummary are RETIRED — /new is now a
  // window-archive (empty context at the day-file EOF, disk log continues). The DD9 behavior (no archive
  // dirs, contiguous line numbers, empty-context resume) is covered by session-new-window.test.ts.
  // (Was: "archives session on resetSession and creates summary".)

  // P2b/D1.6: resetSession clears the in-memory session with a durable empty window, but the append-only
  // day-file archive is PRESERVED (never deleted — DD1). (Was: "active JSONL deleted after archive".)
  it('resetSession clears the session with an empty window and preserves the day-file archive', async () => {
    await manager.addTurn('chat1', { role: 'user', content: 'Test' }, { role: 'assistant', content: 'Response' });
    expect(fs.existsSync(dayFile())).toBe(true);

    await manager.resetSession('chat1');
    expect(manager.getHistory('chat1')).toEqual([]);
    const window = JSON.parse(fs.readFileSync(path.join(tmpDir, 'session-window.json'), 'utf8'));
    expect(window.summaryBlock).toBe('');
    expect(window.verbatimFrom.line).toBe(2);
    expect(fs.existsSync(dayFile())).toBe(true);
  });

  describe('Phase 2.6 lifecycle semantics', () => {
    function makeProvider(summaryText: string): LLMProvider {
      return {
        chat: jest.fn().mockResolvedValue({ type: 'text', text: summaryText }),
        embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      };
    }

    // P2b/D1.4 (DD10): idle resets are RETIRED — the perpetual thread never hard-resets on idle.
    // (Was: "archives active JSONL on idle hard reset and removes active file".)
    it('does NOT hard-reset or archive on long idle (idle resets retired — DD10)', async () => {
      await manager.addTurn('chat-hard', { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (manager as any).sessions.get('chat-hard');
      state.lastActiveAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

      const history = await manager.prepareHistory('chat-hard');

      // The window is returned intact; nothing is archived; the day-file archive stays.
      expect(history.map((m) => m.content)).toEqual(['Hello', 'Hi']);
      expect(fs.existsSync(dayFile())).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'archive'))).toBe(false);
    });

    // P2b/D1.5: lastActiveAt is restored from the last archive entry's timestamp on resume.
    it('restores lastActiveAt from the last archive entry timestamp on reload', async () => {
      jest.useFakeTimers();
      const stale = new Date('2026-04-17T12:00:00.000Z');
      jest.setSystemTime(stale);
      await manager.recordTurn('chat-reload', [
        { role: 'user', content: 'Old' },
        { role: 'assistant', content: 'Session' },
      ]);
      jest.useRealTimers();

      const manager2 = new SessionManager(240, 1440, tmpDir);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (manager2 as any).sessions.get('chat-reload');

      expect(state).toBeDefined();
      expect(Math.abs(state.lastActiveAt.getTime() - stale.getTime())).toBeLessThan(1000);
    });

    // P2b/D3.6 (DD9): the /new archive-summary feature (summaries/ + generateSummary) is RETIRED — the
    // compaction pipeline copies its summary to the daily log via the summary sink (PHI-safe narrative
    // store), and /new just archives the window. (Was: "/new reset writes real summary content".)

    // P2b/D1.4 (DD10): idle soft-reset compaction is RETIRED. An under-budget, idle session is NOT
    // compacted — the full verbatim window is returned, the provider is never called. (Token-budget
    // compaction — the surviving auto-trigger — is covered by session-compaction-tool-groups.)
    // (Was: "does not race compaction with live request history retrieval".)
    it('does NOT run compaction on idle (soft reset retired — DD10)', async () => {
      const provider = makeProvider('should not be produced on idle');
      const compactionManager = new SessionManager(
        1,
        1440,
        tmpDir,
        provider,
        undefined,
        { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 },
      );

      for (let i = 0; i < 6; i++) {
        await compactionManager.addTurn(
          'chat-race',
          { role: 'user', content: `Message ${i}` },
          { role: 'assistant', content: `Response ${i}` },
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (compactionManager as any).sessions.get('chat-race');
      state.lastActiveAt = new Date(Date.now() - 2 * 60 * 60 * 1000);

      const history = await compactionManager.prepareHistory('chat-race');
      expect(provider.chat as jest.Mock).not.toHaveBeenCalled();
      expect(history.some((m) => m.role === 'system')).toBe(false);
      expect(history).toHaveLength(12);
    });

    it('persists full turn trace to JSONL in user -> assistant(tool_request) -> tool -> assistant order', async () => {
      await manager.recordTurn('chat-trace', [
        { role: 'user', content: 'Ping the system' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'ping', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'pong', tool_call_id: 'c1' },
        { role: 'assistant', content: 'I called ping and got pong!' },
      ]);

      const lines = fs.readFileSync(dayFile(), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.map((line) => line.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      expect(lines[1].tool_calls[0].function.name).toBe('ping');
      expect(lines[2].tool_call_id).toBe('c1');
    });

    // P2b/D1.5: tool_calls / tool_call_id survive the persist→resume round-trip through the day-file
    // archive (written by recordTurn, replayed on construction).
    it('reload restores tool_calls and tool_call_id metadata in original order', async () => {
      await manager.recordTurn('chat-trace-reload', [
        { role: 'user', content: 'Ping' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
        },
        { role: 'tool', content: 'pong', tool_call_id: 'c1' },
        { role: 'assistant', content: 'Done' },
      ]);

      const manager2 = new SessionManager(240, 1440, tmpDir);
      const history = await manager2.prepareHistory('chat-trace-reload');

      expect(history.map((msg) => msg.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      expect(history[1].tool_calls?.[0].function.name).toBe('ping');
      expect(history[2].tool_call_id).toBe('c1');
    });

    // P2b/D1.4 (DD10): idle never triggers compaction, even across repeated prepareHistory calls.
    // (Was: "does not re-run soft-reset compaction on consecutive prepareHistory calls before recordTurn".)
    it('idle never triggers compaction across repeated prepareHistory calls (soft reset retired)', async () => {
      const provider = {
        chat: jest.fn().mockResolvedValue({ type: 'text', text: 'should not be produced on idle' }),
        embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      };
      const compactionManager = new SessionManager(
        1,
        1440,
        tmpDir,
        provider as LLMProvider,
        undefined,
        { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 },
      );

      for (let i = 0; i < 4; i++) {
        await compactionManager.addTurn(
          'chat-repeat',
          { role: 'user', content: `Message ${i}` },
          { role: 'assistant', content: `Response ${i}` },
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (compactionManager as any).sessions.get('chat-repeat');
      state.lastActiveAt = new Date(Date.now() - 2 * 60 * 60 * 1000);

      const history1 = await compactionManager.prepareHistory('chat-repeat');
      const history2 = await compactionManager.prepareHistory('chat-repeat');

      expect(provider.chat).not.toHaveBeenCalled();
      expect(history1.some((m: Message) => m.role === 'system')).toBe(false);
      expect(history2).toHaveLength(8);
    });
  });

  // ── CORR-M3: persist-first regression ─────────────────────────────────
  describe('CORR-M3 persist-first', () => {
    it('appendFileSync throw → recordTurn rejects, getHistory does NOT contain the turn, JSONL on disk does NOT contain it', async () => {
      const errorSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const appendSpy = jest
        .spyOn(fsReal, 'appendFileSync')
        .mockImplementation(() => {
          throw new Error('disk full simulated');
        });
      try {
        await expect(
          manager.recordTurn('chat-m3', [
            { role: 'user', content: 'should not persist' },
            { role: 'assistant', content: 'also lost' },
          ]),
        ).rejects.toThrow('disk full simulated');

        // In-memory history must NOT contain the failed turn.
        expect(manager.getHistory('chat-m3')).toEqual([]);

        // The day-file archive must NOT contain the failed turn.
        if (fs.existsSync(dayFile())) {
          const raw = fs.readFileSync(dayFile(), 'utf-8');
          expect(raw).not.toContain('should not persist');
          expect(raw).not.toContain('also lost');
        }
      } finally {
        appendSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it('happy path: after recordTurn, the day-file archive actually contains the turn content', async () => {
      await manager.recordTurn('chat-happy', [
        { role: 'user', content: 'persisted-ok' },
        { role: 'assistant', content: 'confirmed' },
      ]);

      expect(fs.existsSync(dayFile())).toBe(true);
      const lines = fs.readFileSync(dayFile(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0].content).toBe('persisted-ok');
      expect(lines[1].content).toBe('confirmed');
      expect(lines[0].role).toBe('user');
      expect(lines[1].role).toBe('assistant');
    });
  });
});
