import * as fs from 'fs';
import type { LLMProvider } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';
import { makeTestTemp } from '../helpers/test-temp';

describe('Compaction runs at background priority', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTestTemp('redacted-bg-compaction-'); });
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
      tmpDir, makeProvider('compaction summary'), undefined,
      { enabled: true, memoryFlush: false, keepRecentTurns: 2 },
    );
    manager.setBackgroundRunner(async (fn) => { backgroundInvocations += 1; return fn(); });

    const chatId = 'chat-bg';
    for (let i = 0; i < 6; i++) {
      await manager.addTurn(chatId, { role: 'user', content: `u${i}` }, { role: 'assistant', content: `a${i}` });
    }
    await manager.runCompaction(chatId);
    warn.mockRestore();

    expect(backgroundInvocations).toBeGreaterThan(0);
  });
});
