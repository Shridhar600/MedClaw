import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createEpisodeTools } from '../../src/tools/episode-tools';
import { EpisodeStore } from '../../src/memcore';
import { mutableClock, seqIdGen } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';

describe('episode_manage (Task 12.4)', () => {
  let tmp: string;
  let store: EpisodeStore;
  let tool: Tool;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-eptool-'));
    store = new EpisodeStore(tmp, mutableClock('2026-08-20T10:00:00.000Z'), seqIdGen('ep'));
    tool = createEpisodeTools({ store, profileId: 'default' }).find(t => t.name === 'episode_manage')!;
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('creates an episode and returns its id', async () => {
    const r = await tool.execute({ action: 'create', title: 'left knee injury' });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/left knee injury/);
    expect(r.content[0].text).toMatch(/ep-/); // seq id surfaced
    expect((await store.list()).items).toHaveLength(1);
  });

  it('links ledger facts to an episode', async () => {
    const created = await store.create({ title: 'knee', profileId: 'default' });
    const r = await tool.execute({ action: 'link', id: created.id, factIds: ['ibuprofen@v1', 'mcl-sprain@v1'] });
    expect(r.isError).toBeFalsy();
    const got = await store.get(created.id);
    expect(got!.linkedFactIds).toEqual(expect.arrayContaining(['ibuprofen@v1', 'mcl-sprain@v1']));
  });

  it('closes an episode (status -> resolved)', async () => {
    const created = await store.create({ title: 'knee', profileId: 'default' });
    await tool.execute({ action: 'close', id: created.id });
    expect((await store.get(created.id))!.status).toBe('resolved');
  });

  it('gets an episode and reports not-found for a bad id', async () => {
    const created = await store.create({ title: 'knee', profileId: 'default' });
    const got = await tool.execute({ action: 'get', id: created.id });
    expect(got.content[0].text).toMatch(/knee/);
    const missing = await tool.execute({ action: 'get', id: 'nope' });
    expect(missing.isError).toBe(true);
  });

  it('lists episodes with pagination (limit + cursor)', async () => {
    await store.create({ title: 'a', profileId: 'default' });
    await store.create({ title: 'b', profileId: 'default' });
    await store.create({ title: 'c', profileId: 'default' });
    const page1 = await tool.execute({ action: 'list', limit: 2 });
    expect(page1.content[0].text).toMatch(/cursor/i); // a nextCursor is surfaced
  });
});
