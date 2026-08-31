// Acceptance suite — P2b spec 14 §7 endless-thread session model, disk-backed against the REAL
// SessionManager + SqliteSessionIndex + CuriosityQueue on a temp profile. Each test maps to one §7
// hook. These are end-to-end regression locks over shipped D-1..D-4 behavior; a failure here means a
// real integration gap, not a unit edge case.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SessionManager, pruneToolResults, windowTriggerFor, PRUNED_TOOL_MARKER } from '../../src/gateway/session';
import { dateKey, countDayFileLines } from '../../src/gateway/session-window';
import { SqliteSessionIndex } from '../../src/indexstore';
import { CuriosityQueue, sweep } from '../../src/memcore';
import { runNightlySweep } from '../../src/scheduler/transcript-sweep-job';
import type { LLMProvider, LLMResponse, Message } from '../../src/providers/types';
import type { SweepLexicon } from '../../src/memcore';

const tmpDirs: string[] = [];
const openIndexes: SqliteSessionIndex[] = [];

function tmp(): { sessionsPath: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-accept-session-'));
  tmpDirs.push(dir);
  const sessionsPath = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsPath, { recursive: true });
  return { sessionsPath, dbPath: path.join(dir, 'search.db') };
}

function makeIndex(dbPath: string, sessionsDir: string): SqliteSessionIndex {
  const idx = new SqliteSessionIndex({ dbPath, sessionsDir });
  openIndexes.push(idx);
  return idx;
}

// F-1: a provider that records the messages it is asked to summarize, so a test can prove the REAL
// older turns (not an empty/ignored input) are what gets summarized.
function capturingProvider(text: string): { provider: LLMProvider; seen: Message[][] } {
  const seen: Message[][] = [];
  return {
    seen,
    provider: {
      modelName: 'test-model',
      async chat(messages: Message[]): Promise<LLMResponse> { seen.push(messages); return { type: 'text', text }; },
      async embed(): Promise<number[]> { return []; },
    },
  };
}

function throwingProvider(): LLMProvider {
  return {
    modelName: 'test-model',
    async chat(): Promise<LLMResponse> {
      const err = new Error('400 deterministic failure');
      (err as Error & { status?: number }).status = 400;
      throw err;
    },
    async embed(): Promise<number[]> { return []; },
  };
}

// One tool-bearing turn = [user, assistant(tool_call), tool result].
function toolTurn(n: number, toolContent: string): Message[] {
  return [
    { role: 'user', content: `user turn ${n}` },
    { role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', content: toolContent, tool_call_id: `c${n}` },
  ];
}

afterAll(() => {
  for (const idx of openIndexes) { try { idx.close(); } catch { /* already closed */ } }
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('P2b acceptance — spec 14 §7 session hooks', () => {
  it('midnight rollover: a turn after midnight lands in a NEW day file; the earlier file is untouched', async () => {
    const { sessionsPath } = tmp();
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-08-30T10:00:00.000Z'));
      const mgr = new SessionManager({ sessionsPath, perChatArchive: true });
      await mgr.recordTurn('c1', [{ role: 'user', content: 'day one message' }]);
      const day1 = path.join(sessionsPath, 'c1', '2026-08-30.jsonl');
      const day1Before = fs.readFileSync(day1, 'utf8');

      jest.setSystemTime(new Date('2026-08-31T00:30:00.000Z'));
      await mgr.recordTurn('c1', [{ role: 'user', content: 'day two message' }]);

      const day2 = path.join(sessionsPath, 'c1', '2026-08-31.jsonl');
      expect(fs.existsSync(day2)).toBe(true);
      expect(fs.readFileSync(day2, 'utf8')).toContain('day two message');
      // the earlier day file is byte-identical — never rewritten (DD1).
      expect(fs.readFileSync(day1, 'utf8')).toBe(day1Before);
    } finally {
      jest.useRealTimers();
    }
  });

  it('resume-after-restart: a fresh manager on the same dir replays the same context', async () => {
    const { sessionsPath } = tmp();
    const mgr1 = new SessionManager({ sessionsPath, perChatArchive: true });
    await mgr1.recordTurn('c1', [{ role: 'user', content: 'my knee has hurt for a week' }]);
    await mgr1.recordTurn('c1', [{ role: 'assistant', content: 'noted — since when exactly?' }]);
    const before = mgr1.getHistory('c1').map(m => `${m.role}:${m.content}`);

    const mgr2 = new SessionManager({ sessionsPath, perChatArchive: true });
    const after = mgr2.getHistory('c1').map(m => `${m.role}:${m.content}`);
    expect(after).toEqual(before);
  });

  it('prune losslessness: an old in-window tool result is a marker, but session_search returns it verbatim', async () => {
    const { sessionsPath, dbPath } = tmp();
    const mgr = new SessionManager({ sessionsPath, perChatArchive: true });
    const index = makeIndex(dbPath, sessionsPath);
    mgr.setTurnIndex(index);

    for (let n = 1; n <= 7; n++) await mgr.recordTurn('c1', toolTurn(n, `glucose reading ${n}80 mgdl`));
    const dayFile = path.join(sessionsPath, 'c1', `${dateKey(new Date())}.jsonl`);
    const archiveBefore = fs.readFileSync(dayFile, 'utf8');

    await mgr.pruneWindow('c1');

    const firstTool = mgr.getHistory('c1').find(m => m.role === 'tool');
    expect(firstTool?.content).toBe(PRUNED_TOOL_MARKER);

    // F-2: losslessness rests on the ARCHIVE being untouched — prove the day file is byte-identical, so
    // a rebuilt-from-disk index (not just the live FTS row) can still recover the pruned result.
    expect(fs.readFileSync(dayFile, 'utf8')).toBe(archiveBefore);
    const rebuilt = makeIndex(path.join(path.dirname(sessionsPath), 'rebuilt.db'), sessionsPath);
    expect(rebuilt.search('glucose reading 180 mgdl', { chatId: 'c1' }).hits.some(h => h.snippet === 'glucose reading 180 mgdl')).toBe(true);

    const res = index.search('glucose reading 180 mgdl', { chatId: 'c1' });
    expect(res.hits.some(h => h.snippet === 'glucose reading 180 mgdl')).toBe(true);
  });

  it('threshold table: 34→none, 35→prune, 49→prune, 50→compact, 80→emergency', () => {
    const t = { pruneAtPercent: 35, compactAtPercent: 50, emergencyAtPercent: 80 };
    expect(windowTriggerFor(34, t)).toBe('none');
    expect(windowTriggerFor(35, t)).toBe('prune');
    expect(windowTriggerFor(49, t)).toBe('prune');
    expect(windowTriggerFor(50, t)).toBe('compact');
    expect(windowTriggerFor(80, t)).toBe('emergency');
    // prune keeps the last 5 turns verbatim (A-M6), older tool results become the marker.
    const history: Message[] = [];
    for (let n = 1; n <= 7; n++) history.push(...toolTurn(n, `r${n}`));
    const pruned = pruneToolResults(history, 5);
    expect(pruned[2].content).toBe(PRUNED_TOOL_MARKER);
    expect(pruned[8].content).toBe('r3');
  });

  it('compaction: summarizes the REAL older turns; every bullet is anchored; day file byte-identical', async () => {
    const { sessionsPath } = tmp();
    const summary = '- Patient reported knee pain\n- Started metformin 500mg\n- Follow up next week';
    const compaction = { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 };
    const { provider, seen } = capturingProvider(summary);
    const mgr = new SessionManager({ sessionsPath, perChatArchive: true, provider, compaction });

    for (let n = 1; n <= 6; n++) {
      await mgr.recordTurn('c1', [{ role: 'user', content: `user message ${n}` }, { role: 'assistant', content: `reply ${n}` }]);
    }
    const dayFile = path.join(sessionsPath, 'c1', `${dateKey(new Date())}.jsonl`);
    const before = fs.readFileSync(dayFile, 'utf8');

    await mgr.runCompaction('c1');

    // F-1: the summary call actually received the older turns (not an empty/ignored snapshot).
    const summarizeCall = seen.find(msgs => msgs.some(m => typeof m.content === 'string' && m.content.includes('Summarize the conversation turns below')));
    expect(summarizeCall).toBeDefined();
    const summarizedText = summarizeCall!.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(summarizedText).toContain('user message 1'); // an older turn that was compacted out
    expect(summarizedText).toContain('user message 4');

    const history = mgr.getHistory('c1');
    expect(history[0].role).toBe('system');
    expect(history[0].content).toContain('[Previous conversation summary]');

    // F-10: EVERY non-empty summary bullet carries a resolving anchor, not just "some" anchor.
    const summaryBody = (history[0].content as string).replace('[Previous conversation summary]\n', '');
    const bullets = summaryBody.split('\n').filter(l => l.trim().startsWith('- '));
    const anchors = [...summaryBody.matchAll(/sessions\/(\S+?)#L(\d+)/g)];
    expect(anchors.length).toBe(bullets.length);
    expect(bullets.length).toBeGreaterThanOrEqual(3);
    for (const m of anchors) {
      const count = countDayFileLines(path.join(sessionsPath, 'c1', m[1]));
      expect(Number(m[2])).toBeGreaterThanOrEqual(1);
      expect(Number(m[2])).toBeLessThanOrEqual(count);
    }
    expect(fs.readFileSync(dayFile, 'utf8')).toBe(before);
  });

  it('compaction failure keeps the OLD window (never lose the thread)', async () => {
    const { sessionsPath } = tmp();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const compaction = { enabled: true, triggerAtTokenPercent: 80, memoryFlush: false, keepRecentTurns: 2 };
      const mgr = new SessionManager({ sessionsPath, perChatArchive: true, provider: throwingProvider(), compaction });
      for (let n = 1; n <= 6; n++) {
        await mgr.recordTurn('c1', [{ role: 'user', content: `user message ${n}` }, { role: 'assistant', content: `reply ${n}` }]);
      }
      const before = mgr.getHistory('c1').map(m => `${m.role}:${m.content}`);
      await expect(mgr.runCompaction('c1')).resolves.toBeUndefined();
      const after = mgr.getHistory('c1').map(m => `${m.role}:${m.content}`);
      // F-4: the OLD window is preserved intact — same messages, same CONTENT (not just the same count).
      expect(after).toEqual(before);
      expect(mgr.getHistory('c1').every(m => m.role !== 'system')).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('/new continuity: reset empties the context while disk line numbers stay contiguous', async () => {
    const { sessionsPath } = tmp();
    const mgr = new SessionManager({ sessionsPath, perChatArchive: true });
    await mgr.recordTurn('c1', [{ role: 'user', content: 'first' }]);
    await mgr.recordTurn('c1', [{ role: 'user', content: 'second' }]);
    const dayFile = path.join(sessionsPath, 'c1', `${dateKey(new Date())}.jsonl`);
    const linesBefore = countDayFileLines(dayFile);

    await mgr.resetSession('c1');
    expect(mgr.getHistory('c1')).toEqual([]); // context emptied

    await mgr.recordTurn('c1', [{ role: 'user', content: 'after new' }]);
    // the disk log keeps growing contiguously — /new never rewrites or gaps the archive.
    expect(countDayFileLines(dayFile)).toBe(linesBefore + 1);
    expect(fs.readFileSync(dayFile, 'utf8')).toContain('after new');
    // context now holds only the post-/new turn.
    expect(mgr.getHistory('c1').map(m => m.content)).toEqual(['after new']);
  });

  it('PLAT-20 verbatim clinical search: a recorded clinical turn is retrievable verbatim, chat-scoped', async () => {
    const { sessionsPath, dbPath } = tmp();
    const mgr = new SessionManager({ sessionsPath, perChatArchive: true });
    const index = makeIndex(dbPath, sessionsPath);
    mgr.setTurnIndex(index);

    await mgr.recordTurn('c1', [{ role: 'user', content: 'blood pressure was 150/95 this morning' }]);
    await mgr.recordTurn('c2', [{ role: 'user', content: 'unrelated other chat' }]);

    const res = index.search('blood pressure 150/95', { chatId: 'c1' });
    expect(res.hits.some(h => h.snippet === 'blood pressure was 150/95 this morning')).toBe(true);
    // chat isolation: c2 never sees c1's clinical turn.
    expect(index.search('blood pressure 150/95', { chatId: 'c2' }).hits).toEqual([]);
  });

  it('migration round-trip: a legacy active file becomes day files that a fresh manager resumes', async () => {
    const { sessionsPath } = tmp();
    fs.writeFileSync(
      path.join(sessionsPath, 'active-c1.jsonl'),
      [
        JSON.stringify({ timestamp: '2026-08-24T10:00:00.000Z', role: 'user', content: 'migrated one', chatId: 'c1' }),
        JSON.stringify({ timestamp: '2026-08-24T10:01:00.000Z', role: 'assistant', content: 'migrated two', chatId: 'c1' }),
      ].join('\n') + '\n',
    );

    // no-registry (perChatArchive) migration buckets the source into its own <chatId>/ subdir.
    const mgr = new SessionManager({ sessionsPath, perChatArchive: true });
    expect(fs.existsSync(path.join(sessionsPath, '.migrated'))).toBe(true);
    const dayFile = path.join(sessionsPath, 'c1', '2026-08-24.jsonl');
    expect(fs.existsSync(dayFile)).toBe(true);
    expect(fs.readFileSync(dayFile, 'utf8')).toContain('migrated one');

    const resumed = mgr.getHistory('c1').map(m => m.content);
    expect(resumed).toEqual(['migrated one', 'migrated two']);
  });

  it('sweep goldens: 2 planted misses (med critical + symptom) become exactly 2 curiosity items on disk', async () => {
    const { sessionsPath } = tmp();
    const dir = path.dirname(sessionsPath);
    const LEX: SweepLexicon = { med: ['naproxen', 'metformin'], symptom: ['headache'], appointment: [] };

    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-08-30T09:00:00.000Z'));
      const mgr = new SessionManager({ sessionsPath, perChatArchive: true });
      await mgr.recordTurn('c1', [{ role: 'user', content: 'took naproxen this morning' }]);   // med miss
      await mgr.recordTurn('c1', [{ role: 'user', content: 'bad headache all day' }]);          // symptom miss
      await mgr.recordTurn('c1', [{ role: 'user', content: 'started metformin again' }]);        // logged -> no item

      const curiosity = new CuriosityQueue(dir);
      const result = await runNightlySweep({
        readDayLines: (date) => mgr.readDayFileLines(date),
        ledgerEntitiesForDay: async () => new Set(['metformin']),
        listCuriosity: () => curiosity.list(),
        addCuriosity: (item) => curiosity.add(item),
        lexicon: LEX,
        now: () => new Date('2026-08-31T03:15:00.000Z'), // yesterday = 2026-08-30
      });

      expect(result).toEqual({ scanned: true, added: 2 });
      const items = await curiosity.list();
      expect(items).toHaveLength(2);
      const med = items.find(i => i.relatedEntity === 'naproxen');
      expect(med?.kind).toBe('missing-data');
      expect(med?.critical).toBe(true);
      expect(items.find(i => i.relatedEntity === 'headache')?.critical).toBeFalsy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('A-L4: a resolved missing-data item re-fires on the next sweep (fresh signal)', async () => {
    const { sessionsPath } = tmp();
    const dir = path.dirname(sessionsPath);
    const LEX: SweepLexicon = { med: ['naproxen'], symptom: [], appointment: [] };
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-08-30T09:00:00.000Z'));
      const mgr = new SessionManager({ sessionsPath, perChatArchive: true });
      await mgr.recordTurn('c1', [{ role: 'user', content: 'took naproxen' }]);
      const curiosity = new CuriosityQueue(dir);
      const deps = {
        readDayLines: (d: Date) => mgr.readDayFileLines(d),
        ledgerEntitiesForDay: async () => new Set<string>(),
        listCuriosity: () => curiosity.list(),
        addCuriosity: (i: Parameters<typeof curiosity.add>[0]) => curiosity.add(i),
        lexicon: LEX,
        now: () => new Date('2026-08-31T03:15:00.000Z'),
      };
      await runNightlySweep(deps);
      const first = await curiosity.list();
      expect(first).toHaveLength(1);

      await curiosity.resolve(first[0].id); // the user answered the question
      await runNightlySweep(deps);          // next night — the transcript miss is still there
      expect((await curiosity.list()).map(i => i.relatedEntity)).toEqual(['naproxen']); // re-fires
    } finally {
      jest.useRealTimers();
    }
  });

  it('sweep purity: the same inputs yield the same items (deterministic, no LLM)', () => {
    const LEX: SweepLexicon = { med: ['naproxen'], symptom: ['headache'], appointment: [] };
    const lines = [JSON.stringify({ role: 'user', content: 'naproxen and a headache', chatId: 'c1' })];
    const a = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [], lexicon: LEX });
    const b = sweep({ dayFileLines: lines, ledgerEntitiesForDay: new Set(), existingCuriosity: [], lexicon: LEX });
    expect(a).toEqual(b);
  });
});
