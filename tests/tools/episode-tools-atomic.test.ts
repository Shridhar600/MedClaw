import * as fs from 'fs';
import * as path from 'path';
import { createEpisodeTools } from '../../src/tools/episode-tools';
import { EpisodeStore } from '../../src/memcore';
import { WriteQueue } from '../../src/profiles';
import type { QueuePort } from '../../src/capture';
import { mutableClock, seqIdGen } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';
import { makeTestTemp } from '../helpers/test-temp';

describe('episode_manage atomic read-modify-write', () => {
  let tmp: string;
  let store: EpisodeStore;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-episode-');
    store = new EpisodeStore(tmp, mutableClock('2026-08-20T10:00:00.000Z'), seqIdGen('ep'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function installDelayedFirstWrite(): { release: () => void } {
    let releaseFn!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFn = resolve; });
    const original = store.update.bind(store);
    let callCount = 0;
    jest.spyOn(store, 'update').mockImplementation(async (id, patch) => {
      callCount += 1;
      if (callCount === 1) await gate;
      return original(id, patch);
    });
    return { release: releaseFn };
  }

  function tool(queue?: QueuePort): Tool {
    return createEpisodeTools({ store, profileId: 'default', queue }).find(t => t.name === 'episode_manage')!;
  }

  it('WITHOUT a coordinator, two concurrent updates on the same id lose one write', async () => {
    const created = await store.create({ title: 'knee', profileId: 'default' });
    const { release } = installDelayedFirstWrite();
    const noQueueTool = tool(undefined);

    const first = noQueueTool.execute({ action: 'update', id: created.id, note: 'first-note' });
    const second = noQueueTool.execute({ action: 'update', id: created.id, note: 'second-note' });
    await second; // call 2's read+write completes while call 1 is still gated
    release();
    await first; // call 1's (stale-read) write now lands LAST, clobbering call 2's

    const final = await store.get(created.id);
    expect(final!.note).toBe('first-note');
  });

  it('WITH the coordinator, the SAME race is serialized — no lost update', async () => {
    const created = await store.create({ title: 'knee', profileId: 'default' });
    const { release } = installDelayedFirstWrite();
    const queue = new WriteQueue({ journalPath: path.join(tmp, 'write-queue.journal') });
    const coordinatedTool = tool(queue);

    const first = coordinatedTool.execute({ action: 'update', id: created.id, note: 'first-note' });
    const second = coordinatedTool.execute({ action: 'update', id: created.id, note: 'second-note' });
    release();
    await Promise.all([first, second]);

    const final = await store.get(created.id);
    expect(['first-note', 'second-note']).toContain(final!.note);
    expect(final!.note).toBe('second-note');
  });

  it('without an injected queue, episode_manage still works for a single sequential caller (fallback preserves existing test construction)', async () => {
    const noQueueTool = tool(undefined);
    const r = await noQueueTool.execute({ action: 'create', title: 'ankle sprain' });
    expect(r.isError).toBeFalsy();
    expect((await store.list()).items).toHaveLength(1);
  });
});
