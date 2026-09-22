import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SqliteChunkStats } from '../../src/indexstore';

let tmpDir: string;
let stats: SqliteChunkStats;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-chunkstats-'));
  stats = new SqliteChunkStats({ dbPath: path.join(tmpDir, 'search.db') });
});
afterEach(() => {
  stats.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// P2 A3: chunk_stats is finally WRITTEN (the schema existed in P0 but nothing fed it — the single
// most important recall learning signal). Stage 4 bumps injected/used; get() reads them back.
describe('SqliteChunkStats (recall Stage-4 telemetry, P2 A3)', () => {
  it('bumpInjected increments injected_count and accumulates across calls', async () => {
    await stats.bumpInjected(['a', 'b']);
    await stats.bumpInjected(['a']);
    expect((await stats.get('a'))?.injectedCount).toBe(2);
    expect((await stats.get('b'))?.injectedCount).toBe(1);
  });

  it('bumpUsed increments used_count and records last_used_at', async () => {
    await stats.bumpInjected(['a']);
    await stats.bumpUsed(['a'], '2026-09-07T10:00:00.000Z');
    const s = await stats.get('a');
    expect(s?.usedCount).toBe(1);
    expect(s?.lastUsedAt).toBe('2026-09-07T10:00:00.000Z');
  });

  it('bumpUsed on a never-injected chunk still records the use (row created)', async () => {
    await stats.bumpUsed(['fresh'], '2026-09-07T10:00:00.000Z');
    const s = await stats.get('fresh');
    expect(s?.usedCount).toBe(1);
    expect(s?.injectedCount).toBe(0);
  });

  it('get returns null for an unknown chunk', async () => {
    expect(await stats.get('nope')).toBeNull();
  });
});
