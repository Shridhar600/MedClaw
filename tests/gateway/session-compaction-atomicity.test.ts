import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { LLMProvider } from '../../src/providers/types';
import { SessionManager } from '../../src/gateway/session';

// The raw CJS module object so writeFileSync can be spied reliably.
const fsReal = jest.requireActual<typeof import('fs')>('fs');

// RES-P1-1/P1-2: a persist throw mid-compaction must NOT corrupt the on-disk
// JSONL (atomic write) NOR mutate in-memory session.history before disk
// commits.
describe('Compaction atomicity (RES-P1-1/P1-2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-compaction-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function makeProvider(summaryText: string): LLMProvider {
    return {
      chat: jest.fn().mockResolvedValue({ type: 'text', text: summaryText }),
      embed: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    } as unknown as LLMProvider;
  }

  it('persistHistory throw mid-compaction leaves session.history unchanged and on-disk JSONL parseable with old content', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const manager = new SessionManager(
      240,
      1440,
      tmpDir,
      makeProvider('Compaction summary for older turns — PHI marker glucose 300.'),
      undefined,
      { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 },
    );

    const chatId = 'chat-atom';
    for (let i = 0; i < 6; i++) {
      await manager.addTurn(
        chatId,
        { role: 'user', content: `Seed user ${i}` },
        { role: 'assistant', content: `Seed assistant ${i}` },
      );
    }

    const jsonlPath = path.join(tmpDir, `active-${chatId}.jsonl`);
    const seededRaw = fs.readFileSync(jsonlPath, 'utf-8');
    // Sanity: the seeded JSONL has 12 parseable lines (6 user/assistant pairs).
    const seededLines = seededRaw.trim().split('\n');
    expect(seededLines.length).toBe(12);

    // Make secureWriteViaTmp's tmp write fail for the duration of compaction.
    // This intercepts BOTH persistHistory attempts (summary + fallback), so
    // session.history must remain the original seeded history.
    const writeSpy = jest.spyOn(fsReal, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full mid-write');
    });

    // Compaction must not throw out of runCompaction (the inner catch absorbs
    // the fallback persist failure and just logs).
    await expect(manager.runCompaction(chatId)).resolves.toBeUndefined();

    writeSpy.mockRestore();

    // In-memory history is UNCHANGED — still the 12 seeded messages.
    const history = manager.getHistory(chatId);
    expect(history.length).toBe(12);
    expect(history[0].content).toBe('Seed user 0');
    expect(history[11].content).toBe('Seed assistant 5');

    // On-disk JSONL is intact and parseable — atomic write never truncated it.
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const afterRaw = fs.readFileSync(jsonlPath, 'utf-8');
    expect(afterRaw).toBe(seededRaw);
    const afterLines = afterRaw.trim().split('\n').map((l) => JSON.parse(l));
    expect(afterLines.length).toBe(12);

    // The compaction summary text never reached disk nor memory.
    expect(afterRaw).not.toContain('Compaction summary');
    expect(afterRaw).not.toContain('glucose');

    warnSpy.mockRestore();
  });
});