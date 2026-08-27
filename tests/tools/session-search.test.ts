import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SqliteSessionIndex } from '../../src/indexstore';
import type { SessionSearchResult } from '../../src/indexstore';
import { createSessionTools } from '../../src/tools/session-tools';

const tmpDirs: string[] = [];

function realIndex(): SqliteSessionIndex {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-sesstool-'));
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

  test('returns a planted turn with its anchor, role, timestamp, and verbatim snippet (PLAT-20/A-L1)', async () => {
    const index = realIndex();
    index.indexTurn('2026-06-01.jsonl', 7, 'user', '2026-06-01T09:00:00.000Z', 'metformin 500mg twice daily');
    const [tool] = createSessionTools({ index });

    const res = await tool.execute({ query: 'metformin 500mg twice daily' });
    index.close();

    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain('sessions/2026-06-01.jsonl#L7'); // anchor is the session identity (A-L1)
    expect(text).toContain('metformin 500mg twice daily'); // verbatim
    expect(text).toContain('user');
    expect(text).toContain('2026-06-01T09:00:00.000Z');
  });

  test('a no-match query degrades to a graceful message, not an error', async () => {
    const index = realIndex();
    index.indexTurn('2026-06-01.jsonl', 1, 'user', '2026-06-01T09:00:00.000Z', 'metformin note');
    const [tool] = createSessionTools({ index });

    const res = await tool.execute({ query: 'zolpidem' });
    index.close();

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.toLowerCase()).toContain('no');
  });

  test('a failed index degrades to an unavailable message, never throws', async () => {
    const failing = { search: (): SessionSearchResult => ({ hits: [], status: 'failed' }) };
    const [tool] = createSessionTools({ index: failing });

    const res = await tool.execute({ query: 'anything' });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.toLowerCase()).toContain('unavailable');
  });

  test('passes the limit option through to the index', async () => {
    let captured: { limit?: number } | undefined;
    const spy = {
      search: (_q: string, opts?: { limit?: number }): SessionSearchResult => {
        captured = opts;
        return { hits: [], status: 'full' };
      },
    };
    const [tool] = createSessionTools({ index: spy });
    await tool.execute({ query: 'x', limit: 3 });
    expect(captured?.limit).toBe(3);
  });
});
