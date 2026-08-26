import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { LLMProvider } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';
import { dateKey } from '../../src/gateway/session-window';

// The raw CJS module object so writeFileSync can be spied reliably.
const fsReal = jest.requireActual<typeof import('fs')>('fs');

// P2b/D1.6 (DD1): compaction mutates ONLY the in-memory window — it NEVER rewrites the append-only
// day-file archive. The window snapshot is saved best-effort, so even a failing window save cannot
// corrupt the durable archive nor reject the turn. (Replaces the old persist-first active-file
// atomicity contract; the active file no longer exists.)
describe('Compaction disk-preservation (DD1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-compaction-atomic-'));
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
      compaction: { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 },
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

    // Fail every atomic write (the window save) for the duration of compaction.
    const writeSpy = jest.spyOn(fsReal, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full mid-write');
    });
    // Compaction must not throw out — the window save is best-effort (warn-and-continue).
    await expect(manager.runCompaction(chatId)).resolves.toBeUndefined();
    writeSpy.mockRestore();

    // The append-only day-file archive is BYTE-IDENTICAL — compaction never touched it (DD1). The
    // summary text never reached the durable archive.
    expect(fs.readFileSync(dayFile, 'utf-8')).toBe(seededRaw);
    expect(seededRaw).not.toContain('Compaction summary');
    expect(seededRaw).not.toContain('glucose');

    // In-memory compaction still applied (best-effort window save; resume stays lossless from the
    // un-advanced anchor).
    const history = manager.getHistory(chatId);
    expect(history[0].role).toBe('system');
    expect(history[0].content).toContain('Previous conversation summary');

    warnSpy.mockRestore();
  });
});