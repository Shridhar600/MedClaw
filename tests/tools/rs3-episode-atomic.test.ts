import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createEpisodeTools } from '../../src/tools/episode-tools';
import { EpisodeStore } from '../../src/memcore';
import { WriteQueue } from '../../src/profiles';
import type { QueuePort } from '../../src/capture';
import { mutableClock, seqIdGen } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';

// RED item #2: two concurrent keyed mutations on the SAME episode id must not lost-update.
// `EpisodeStore` stores one file per episode id and `update()`/`link()` are read-then-write on
// that file — a classic lost-update race with no serialization. On HEAD a678272, `episode_manage`
// called `deps.store.update()` DIRECTLY with no queue at all (the dep didn't even exist), so this
// race was unconditional. R-S3 routes it through the injected coordinator/queue.
describe('RR-STRUCT R-S3 — episode_manage atomic read-modify-write (C-46)', () => {
  let tmp: string;
  let store: EpisodeStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs3-episode-'));
    store = new EpisodeStore(tmp, mutableClock('2026-08-20T10:00:00.000Z'), seqIdGen('ep'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** Deterministically force call #1's underlying store write to land AFTER call #2's has
   *  already completed — reproducing the lost-update window a non-atomic read-then-write allows.
   *  No wall-clock sleep: an externally-controlled gate promise decides the interleave. */
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

  it('RED baseline: WITHOUT a coordinator, two concurrent updates on the same id lose one write', async () => {
    const created = await store.create({ title: 'knee', profileId: 'default' });
    const { release } = installDelayedFirstWrite();
    const noQueueTool = tool(undefined);

    const first = noQueueTool.execute({ action: 'update', id: created.id, note: 'first-note' });
    const second = noQueueTool.execute({ action: 'update', id: created.id, note: 'second-note' });
    await second; // call 2's read+write completes while call 1 is still gated
    release();
    await first; // call 1's (stale-read) write now lands LAST, clobbering call 2's

    const final = await store.get(created.id);
    // This is the hazard, reproduced: 'second-note' is lost.
    expect(final!.note).toBe('first-note');
  });

  it('FIXED: WITH the coordinator, the SAME race is serialized — no lost update', async () => {
    const created = await store.create({ title: 'knee', profileId: 'default' });
    const { release } = installDelayedFirstWrite();
    const queue = new WriteQueue({ journalPath: path.join(tmp, 'write-queue.journal') });
    const coordinatedTool = tool(queue);

    const first = coordinatedTool.execute({ action: 'update', id: created.id, note: 'first-note' });
    const second = coordinatedTool.execute({ action: 'update', id: created.id, note: 'second-note' });
    // `second`'s op cannot even START running until `first`'s op (still gated) resolves — the
    // single-writer queue serializes the WHOLE read-modify-write, not just the write.
    release();
    await Promise.all([first, second]);

    const final = await store.get(created.id);
    // Whichever op the queue happened to run second wins outright — never a merge of a stale
    // read — so the result is deterministically ONE of the two notes, never neither/corrupted.
    expect(['first-note', 'second-note']).toContain(final!.note);
    // The queue drains strictly in enqueue order (turn-priority FIFO) — the SECOND call's note
    // is the one that should be current.
    expect(final!.note).toBe('second-note');
  });

  it('without an injected queue, episode_manage still works for a single sequential caller (fallback preserves existing test construction)', async () => {
    const noQueueTool = tool(undefined);
    const r = await noQueueTool.execute({ action: 'create', title: 'ankle sprain' });
    expect(r.isError).toBeFalsy();
    expect((await store.list()).items).toHaveLength(1);
  });
});
