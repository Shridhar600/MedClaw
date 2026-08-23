import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { LLMProvider } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';

// F8 — compaction LLM calls must run through the injected background runner (semaphore 'background'
// priority in production) so background compaction never starves or collides with user turns.
describe('Compaction runs at background priority (F8)', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-bg-compaction-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); jest.restoreAllMocks(); });

  function makeProvider(summaryText: string): LLMProvider {
    return {
      chat: jest.fn().mockResolvedValue({ type: 'text', text: summaryText }),
      embed: jest.fn().mockResolvedValue([0.1]),
    } as unknown as LLMProvider;
  }

  it('routes the compaction summary LLM call through the background runner', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let backgroundInvocations = 0;
    const manager = new SessionManager(
      240, 1440, tmpDir, makeProvider('compaction summary'), undefined,
      { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 },
    );
    manager.setBackgroundRunner(async (fn) => { backgroundInvocations += 1; return fn(); });

    const chatId = 'chat-bg';
    for (let i = 0; i < 6; i++) {
      await manager.addTurn(chatId, { role: 'user', content: `u${i}` }, { role: 'assistant', content: `a${i}` });
    }
    await manager.runCompaction(chatId);
    warn.mockRestore();

    // The summary generation went through the background runner (not a direct provider call).
    expect(backgroundInvocations).toBeGreaterThan(0);
  });
});
