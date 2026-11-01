import * as fs from 'fs';
import * as path from 'path';
import type { LLMProvider } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';
import { dateKey } from '../../src/gateway/session-window';
import { makeTestTemp } from '../helpers/test-temp';

const fsReal = jest.requireActual<typeof import('fs')>('fs');

describe('Compaction disk-preservation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-compaction-atomic-');
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-26T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function makeProvider(summaryText: string): LLMProvider {
    return {
      chat: jest.fn().mockResolvedValue({ type: 'text', text: summaryText }),
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    } as unknown as LLMProvider;
  }

  it('compaction never rewrites the day-file archive; a failing window save degrades without corrupting it', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const manager = new SessionManager({
      sessionsPath: tmpDir,
      provider: makeProvider('Compaction summary for older turns — PHI marker glucose 300.'),
      compaction: { enabled: true, memoryFlush: false, keepRecentTurns: 2 },
    });

    const chatId = 'chat-atom';
    for (let i = 0; i < 6; i++) {
      await manager.addTurn(
        chatId,
        { role: 'user', content: `Seed user ${i}` },
        { role: 'assistant', content: `Seed assistant ${i}` },
      );
    }

    const dayFile = path.join(tmpDir, `${dateKey(new Date())}.jsonl`);
    const seededRaw = fs.readFileSync(dayFile, 'utf-8');
    expect(seededRaw.trim().split('\n').length).toBe(12); // 6 user/assistant pairs, append-only

    const writeSpy = jest.spyOn(fsReal, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full mid-write');
    });
    await expect(manager.runCompaction(chatId)).resolves.toBeUndefined();
    writeSpy.mockRestore();

    expect(fs.readFileSync(dayFile, 'utf-8')).toBe(seededRaw);
    expect(seededRaw).not.toContain('Compaction summary');
    expect(seededRaw).not.toContain('glucose');

    const history = manager.getHistory(chatId);
    expect(history.every((m) => m.role !== 'system')).toBe(true);
    expect(history.length).toBe(12);

    warnSpy.mockRestore();
  });
});
