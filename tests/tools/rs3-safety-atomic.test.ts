import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSafetyTools } from '../../src/tools/safety-tools';
import { SafetyView } from '../../src/memcore';
import { WriteQueue } from '../../src/profiles';
import type { QueuePort } from '../../src/capture';
import { mutableClock } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';

// RED item #2 (safety-critical flavor): `safety_note add-critical-event` used to write DIRECTLY
// to `SafetyView.addCriticalEvent` (load -> push -> write, a read-modify-write on SAFETY.md) with
// NO queue at all. Critical Events are add-only (VANI-05) — a lost-update race here silently drops
// a logged safety event, which is a genuine clinical-audit hazard, not just a data race.
describe('RR-STRUCT R-S3 — safety_note add-critical-event atomic append (C-46)', () => {
  let tmp: string;
  let view: SafetyView;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs3-safety-'));
    view = new SafetyView(tmp, mutableClock('2026-08-20T10:00:00.000Z'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /**
   * Deterministically force call #1's WRITE to land after call #2's has already completed —
   * reproducing the lost-update window a non-atomic read-modify-write allows. No wall-clock
   * sleep. `addCriticalEvent` runs its `load()` (read) synchronously and only reaches its
   * `writeItems()` (write) call at the very end of its own synchronous body — so, to get a real
   * interleave, the delay must sit at the WRITE boundary (a private method), not around the
   * whole public method: gating the whole method would delay call #1's READ too, and since
   * `addCriticalEvent`'s body has no `await` before that call, call #2 would then read call #1's
   * ALREADY-APPLIED bullet and nothing would be lost — a race that can't actually happen would
   * give a false "no bug here" reading. `writeItems`' real signature is synchronous (`=> string`);
   * for call #1 the mock instead returns a PROMISE that resolves only once the gate releases —
   * `addCriticalEvent`'s own `async` wrapper auto-flattens that, so the caller correctly awaits
   * the deferred write, while control still yields back to the event loop for call #2 to run
   * before call #1's write actually lands. Reflective access is deliberate: this targets the
   * exact private read/write boundary `SafetyView.addCriticalEvent` crosses.
   */
  function installDelayedFirstWrite(): { release: () => void } {
    let releaseFn!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFn = resolve; });
    type WithWriteItems = { writeItems(items: unknown): string | Promise<string> };
    const target = view as unknown as WithWriteItems;
    const original = target.writeItems.bind(target);
    let callCount = 0;
    jest.spyOn(target, 'writeItems').mockImplementation((items: unknown) => {
      callCount += 1;
      if (callCount === 1) return gate.then(() => original(items));
      return original(items);
    });
    return { release: releaseFn };
  }

  function tool(queue?: QueuePort): Tool {
    return createSafetyTools({ safetyView: view, queue }).find(t => t.name === 'safety_note')!;
  }

  it('RED baseline: WITHOUT a coordinator, two concurrent critical-event appends lose one event', async () => {
    await view.render([]);
    const { release } = installDelayedFirstWrite();
    const noQueueTool = tool(undefined);

    const first = noQueueTool.execute({ action: 'add-critical-event', summary: 'chest pain episode' });
    const second = noQueueTool.execute({ action: 'add-critical-event', summary: 'severe allergic reaction' });
    await second;
    release();
    await first;

    const md = await view.read();
    // The hazard, reproduced: only ONE of the two Critical Events survives — the other is
    // silently dropped from the add-only safety log.
    const hasFirst = md!.includes('chest pain episode');
    const hasSecond = md!.includes('severe allergic reaction');
    expect(hasFirst && hasSecond).toBe(false);
  });

  it('FIXED: WITH the coordinator, BOTH concurrent critical events are preserved (add-only, VANI-05)', async () => {
    await view.render([]);
    const { release } = installDelayedFirstWrite();
    const queue = new WriteQueue({ journalPath: path.join(tmp, 'write-queue.journal') });
    const coordinatedTool = tool(queue);

    const first = coordinatedTool.execute({ action: 'add-critical-event', summary: 'chest pain episode' });
    const second = coordinatedTool.execute({ action: 'add-critical-event', summary: 'severe allergic reaction' });
    release();
    await Promise.all([first, second]);

    const md = await view.read();
    expect(md).toContain('chest pain episode');
    expect(md).toContain('severe allergic reaction');
  });

  it('without an injected queue, safety_note still works for a single sequential caller (fallback preserves existing test construction)', async () => {
    const noQueueTool = tool(undefined);
    const r = await noQueueTool.execute({ action: 'add-critical-event', summary: 'routine note' });
    expect(r.isError).toBeFalsy();
    expect(await view.read()).toContain('routine note');
  });
});
