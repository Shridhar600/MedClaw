import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { LLMProvider, Message } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';

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

  it('appends user and assistant turns to JSONL file', async () => {
    await manager.addTurn('chat1', { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi there' });
    const jsonlPath = path.join(tmpDir, 'active-chat1.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('reconstructs history from JSONL on startup', () => {
    const jsonlPath = path.join(tmpDir, 'active-chat1.jsonl');
    fs.writeFileSync(jsonlPath, JSON.stringify({ timestamp: new Date().toISOString(), role: 'user', content: 'Hello', chatId: 'chat1' }) + '\n');
    fs.writeFileSync(jsonlPath, JSON.stringify({ timestamp: new Date().toISOString(), role: 'assistant', content: 'Hi there', chatId: 'chat1' }) + '\n', { flag: 'a' });

    const manager2 = new SessionManager(240, 1440, tmpDir);
    const history = manager2.getHistory('chat1');
    expect(history.length).toBe(2);
    expect(history[0].content).toBe('Hello');
  });

  it('archives session on resetSession and creates summary', async () => {
    await manager.addTurn('chat1', { role: 'user', content: 'Test' }, { role: 'assistant', content: 'Response' });
    await manager.resetSession('chat1');

    const archiveDir = path.join(tmpDir, 'archive');
    expect(fs.existsSync(archiveDir)).toBe(true);
    expect(fs.readdirSync(archiveDir).length).toBeGreaterThan(0);

    const summariesDir = path.join(tmpDir, 'summaries');
    expect(fs.existsSync(summariesDir)).toBe(true);
  });

  it('active JSONL deleted after archive', async () => {
    await manager.addTurn('chat1', { role: 'user', content: 'Test' }, { role: 'assistant', content: 'Response' });
    const jsonlPath = path.join(tmpDir, 'active-chat1.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);

    await manager.resetSession('chat1');
    expect(fs.existsSync(jsonlPath)).toBe(false);
  });

  describe('Phase 2.6 lifecycle semantics', () => {
    function makeProvider(summaryText: string): LLMProvider {
      return {
        chat: jest.fn().mockResolvedValue({ type: 'text', text: summaryText }),
        embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
      };
    }

    it('archives active JSONL on idle hard reset and removes active file', async () => {
      await manager.addTurn('chat-hard', { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' });
      const activePath = path.join(tmpDir, 'active-chat-hard.jsonl');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (manager as any).sessions.get('chat-hard');
      state.lastActiveAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

      const history = await manager.prepareHistory('chat-hard');

      expect(history).toEqual([]);
      expect(fs.existsSync(activePath)).toBe(false);
      const archiveDir = path.join(tmpDir, 'archive');
      expect(fs.existsSync(archiveDir)).toBe(true);
      expect(fs.readdirSync(archiveDir).some(name => name.includes('chat-hard'))).toBe(true);
    });

    it('restores lastActiveAt from last JSONL timestamp on reload', () => {
      const staleTimestamp = new Date('2026-04-17T12:00:00.000Z').toISOString();
      const jsonlPath = path.join(tmpDir, 'active-chat-reload.jsonl');
      fs.writeFileSync(jsonlPath, JSON.stringify({ timestamp: staleTimestamp, role: 'user', content: 'Old', chatId: 'chat-reload' }) + '\n');
      fs.writeFileSync(jsonlPath, JSON.stringify({ timestamp: staleTimestamp, role: 'assistant', content: 'Session', chatId: 'chat-reload' }) + '\n', { flag: 'a' });

      const manager2 = new SessionManager(240, 1440, tmpDir);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (manager2 as any).sessions.get('chat-reload');

      expect(state).toBeDefined();
      expect(Math.abs(state.lastActiveAt.getTime() - new Date(staleTimestamp).getTime())).toBeLessThan(1000);
    });

    it('/new reset writes real summary content instead of placeholder text', async () => {
      const summaryManager = new SessionManager(240, 1440, tmpDir, makeProvider('Health facts: user tracks fasting glucose and knee pain.'));
      await summaryManager.addTurn('chat-summary', { role: 'user', content: 'Summarize me' }, { role: 'assistant', content: 'Noted' });
      await summaryManager.resetSession('chat-summary');

      const summariesDir = path.join(tmpDir, 'summaries');
      const summaryFiles = fs.readdirSync(summariesDir);
      const summaryPath = path.join(summariesDir, summaryFiles[0]);
      const summary = fs.readFileSync(summaryPath, 'utf-8');

      expect(summary).toContain('Health facts: user tracks fasting glucose and knee pain.');
      expect(summary).not.toContain('This session has been archived.');
    });

    it('does not race compaction with live request history retrieval', async () => {
      const compactionManager = new SessionManager(
        1,
        1440,
        tmpDir,
        makeProvider('Compaction summary for older turns.'),
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
      expect(history[0].role).toBe('system');
      expect(history[0].content).toContain('[Previous conversation summary]');
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

      const lines = fs.readFileSync(path.join(tmpDir, 'active-chat-trace.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.map((line) => line.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      expect(lines[1].tool_calls[0].function.name).toBe('ping');
      expect(lines[2].tool_call_id).toBe('c1');
    });

    it('reload restores tool_calls and tool_call_id metadata in original order', async () => {
      const jsonlPath = path.join(tmpDir, 'active-chat-trace-reload.jsonl');
      const entries = [
        { timestamp: new Date().toISOString(), role: 'user', content: 'Ping', chatId: 'chat-trace-reload' },
        {
          timestamp: new Date().toISOString(),
          role: 'assistant',
          content: null,
          chatId: 'chat-trace-reload',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{}' } }],
        },
        {
          timestamp: new Date().toISOString(),
          role: 'tool',
          content: 'pong',
          chatId: 'chat-trace-reload',
          tool_call_id: 'c1',
        },
        { timestamp: new Date().toISOString(), role: 'assistant', content: 'Done', chatId: 'chat-trace-reload' },
      ];
      fs.writeFileSync(jsonlPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');

      const manager2 = new SessionManager(240, 1440, tmpDir);
      const history = await manager2.prepareHistory('chat-trace-reload');

      expect(history.map((msg) => msg.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      expect(history[1].tool_calls?.[0].function.name).toBe('ping');
      expect(history[2].tool_call_id).toBe('c1');
    });

    it('does not re-run soft-reset compaction on consecutive prepareHistory calls before recordTurn', async () => {
      const provider = {
        chat: jest.fn().mockResolvedValue({ type: 'text', text: 'Compaction summary for older turns.' }),
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
      expect(history1[0].role).toBe('system');
      expect(history1[0].content).toContain('[Previous conversation summary]');

      const chatCallCountBefore = provider.chat.mock.calls.length;
      const history2 = await compactionManager.prepareHistory('chat-repeat');
      const chatCallCountAfter = provider.chat.mock.calls.length;

      expect(chatCallCountAfter).toBe(chatCallCountBefore);

      const systemMessages = history2.filter((m: Message) => m.role === 'system');
      expect(systemMessages).toHaveLength(1);
    });
  });
});
