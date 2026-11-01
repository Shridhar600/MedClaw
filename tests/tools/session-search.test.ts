import * as fs from 'fs';
import * as path from 'path';

import { SqliteSessionIndex } from '../../src/indexstore';
import type { SessionSearchResult } from '../../src/indexstore';
import { createSessionTools } from '../../src/tools/session-tools';
import { makeTestTemp } from '../helpers/test-temp';

const tmpDirs: string[] = [];

function realIndex(): SqliteSessionIndex {
  const dir = makeTestTemp('redacted-sesstool-');
  tmpDirs.push(dir);
  return new SqliteSessionIndex({ dbPath: path.join(dir, 'search.db'), sessionsDir: path.join(dir, 'sessions') });
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('session_search tool', () => {
  test('exposes the expected tool schema', () => {
    const index = realIndex();
    const [tool] = createSessionTools({ index });
    index.close();
    expect(tool.name).toBe('session_search');
    expect(tool.group).toBe('group:session');
    expect(tool.parameters.required).toContain('query');
  });

  test('returns a planted turn with its anchor, role, timestamp, and verbatim snippet', async () => {
    const index = realIndex();
    index.indexTurn('chat1', '2026-06-01.jsonl', 7, 'user', '2026-06-01T09:00:00.000Z', 'metformin 500mg twice daily');
    const [tool] = createSessionTools({ index });

    const res = await tool.execute({ query: 'metformin 500mg twice daily' }, { chatId: 'chat1' });
    index.close();

    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain('sessions/2026-06-01.jsonl#L7');
    expect(text).toContain('metformin 500mg twice daily'); // verbatim
    expect(text).toContain('user');
    expect(text).toContain('2026-06-01T09:00:00.000Z');
  });

  test('a no-match query degrades to a graceful message, not an error', async () => {
    const index = realIndex();
    index.indexTurn('chat1', '2026-06-01.jsonl', 1, 'user', '2026-06-01T09:00:00.000Z', 'metformin note');
    const [tool] = createSessionTools({ index });

    const res = await tool.execute({ query: 'zolpidem' }, { chatId: 'chat1' });
    index.close();

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.toLowerCase()).toContain('no');
  });

  test('a failed index degrades to an unavailable message, never throws', async () => {
    const failing = { search: (): SessionSearchResult => ({ hits: [], status: 'failed' }) };
    const [tool] = createSessionTools({ index: failing });

    const res = await tool.execute({ query: 'anything' }, { chatId: 'chat1' });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.toLowerCase()).toContain('unavailable');
  });

  // The tool must scope the search to the calling chat and fail closed when there is no chat context.
  test('passes the calling chatId (and limit) through to the index (chat scope)', async () => {
    let captured: { chatId?: string; limit?: number } | undefined;
    const spy = {
      search: (_q: string, opts?: { chatId?: string; limit?: number }): SessionSearchResult => {
        captured = opts;
        return { hits: [], status: 'full' };
      },
    };
    const [tool] = createSessionTools({ index: spy });
    await tool.execute({ query: 'x', limit: 3 }, { chatId: 'chat-42' });
    expect(captured?.chatId).toBe('chat-42');
    expect(captured?.limit).toBe(3);
  });

  test('fails closed (unavailable) when there is no chat context — never searches unscoped', async () => {
    let called = false;
    const spy = {
      search: (): SessionSearchResult => {
        called = true;
        return { hits: [], status: 'full' };
      },
    };
    const [tool] = createSessionTools({ index: spy });
    const res = await tool.execute({ query: 'x' }); // no context
    expect(called).toBe(false); // the index was NOT queried unscoped
    expect(res.content[0].text.toLowerCase()).toContain('unavailable');
  });
});
