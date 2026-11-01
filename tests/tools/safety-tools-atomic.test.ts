import * as fs from 'fs';
import * as path from 'path';
import { createSafetyTools } from '../../src/tools/safety-tools';
import { SafetyView } from '../../src/memcore';
import { WriteQueue } from '../../src/profiles';
import type { QueuePort } from '../../src/capture';
import { mutableClock } from '../helpers/memcore-fixtures';
import type { Tool } from '../../src/tools/types';
import { makeTestTemp } from '../helpers/test-temp';

describe('safety_note add-critical-event atomic append', () => {
  let tmp: string;
  let view: SafetyView;

  beforeEach(() => {
    tmp = makeTestTemp('redacted-safety-');
    view = new SafetyView(tmp, mutableClock('2026-08-20T10:00:00.000Z'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // The delay sits at the private write boundary, so call #2 reads before call #1 writes. No sleep.
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

  it('WITHOUT a coordinator, two concurrent critical-event appends lose one event', async () => {
    await view.render([]);
    const { release } = installDelayedFirstWrite();
    const noQueueTool = tool(undefined);

    const first = noQueueTool.execute({ action: 'add-critical-event', summary: 'chest pain episode' });
    const second = noQueueTool.execute({ action: 'add-critical-event', summary: 'severe allergic reaction' });
    await second;
    release();
    await first;

    const md = await view.read();
    const hasFirst = md!.includes('chest pain episode');
    const hasSecond = md!.includes('severe allergic reaction');
    expect(hasFirst && hasSecond).toBe(false);
  });

  it('WITH the coordinator, BOTH concurrent critical events are preserved (add-only)', async () => {
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
