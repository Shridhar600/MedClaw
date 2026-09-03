// RR-STRUCT R-S3b Part A — `memory_write` routes through the single-writer.
//
// RED baseline: on HEAD f73b557 `createMemoryTools` takes NO coordinator, so the 6th
// argument below is ignored and every `memory_write` hits `MemoryEngine` directly —
// two concurrent appends overlap inside the read-modify-write (pre-scan / append /
// post-scan / rollback) sequence instead of serializing as ONE coordinator op.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MutationCoordinator, type QueuePort } from '../../src/capture';
import { MemoryEngine } from '../../src/memory/memory-engine';
import { WriteQueue } from '../../src/profiles';
import { createMemoryTools } from '../../src/tools/memory-tools';

// A MemoryEngine-shaped fake whose methods yield exactly once, so two UNSERIALIZED
// concurrent callers deterministically overlap (maxInFlight === 2), while
// coordinator-serialized callers never do (maxInFlight === 1). No wall-clock sleeps —
// overlap is forced by microtask ordering, gated on both callers having started.
class TrackingEngine {
  content: string | null = null;
  inFlight = 0;
  maxInFlight = 0;

  async readFile(): Promise<string | null> {
    return this.tracked(async () => this.content);
  }

  async appendToFile(_relativePath: string, chunk: string): Promise<void> {
    await this.tracked(async () => {
      this.content = (this.content ?? '') + chunk;
    });
  }

  async writeFile(_relativePath: string, next: string): Promise<void> {
    await this.tracked(async () => {
      this.content = next;
    });
  }

  async listFiles(): Promise<string[]> {
    return [];
  }

  private async tracked<T>(fn: () => T | Promise<T>): Promise<T> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await Promise.resolve();
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }
}

function asEngine(fake: TrackingEngine): MemoryEngine {
  return fake as unknown as MemoryEngine;
}

describe('R-S3b Part A — memory_write single-writer routing', () => {
  it('routes the whole memory_write body through the injected coordinator as ONE turn-priority op', async () => {
    const engine = new TrackingEngine();
    const calls: Array<{ priority: string; label: string; scope?: string }> = [];
    let accessorReads = 0;
    const recordingQueue: QueuePort = {
      enqueue: (priority, op) => {
        calls.push({ priority, label: op.label, scope: op.scope });
        return op.run();
      },
    };
    // Lazy accessor — the gateway can only supply `() => runtime.mutationCoordinator`
    // because memory tools register before the coordinator exists (runtime.ts trap).
    const tools = createMemoryTools(
      asEngine(engine),
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        accessorReads += 1;
        return recordingQueue;
      },
    );
    const tool = tools.find((t) => t.name === 'memory_write')!;

    const result = await tool.execute({ path: 'notes/t.md', content: 'note-aaa', mode: 'append' });

    expect(result.isError).toBeFalsy();
    expect(accessorReads).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].priority).toBe('turn');
    expect(calls[0].label).toBe('memory:write');
    expect(engine.content).toContain('note-aaa');
  });

  it('serializes two concurrent appends to the SAME file (no overlap inside the write body)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs3b-mem-'));
    try {
      const engine = new TrackingEngine();
      const queue = new WriteQueue({ journalPath: path.join(root, '.state', 'write-queue.journal') });
      const coordinator = new MutationCoordinator(queue);
      const tools = createMemoryTools(asEngine(engine), undefined, undefined, undefined, undefined, coordinator);
      const tool = tools.find((t) => t.name === 'memory_write')!;

      const first = tool.execute({ path: 'notes/t.md', content: 'note-aaa', mode: 'append' });
      const second = tool.execute({ path: 'notes/t.md', content: 'note-bbb', mode: 'append' });
      const [r1, r2] = await Promise.all([first, second]);

      expect(r1.isError).toBeFalsy();
      expect(r2.isError).toBeFalsy();
      expect(engine.maxInFlight).toBe(1);
      expect(engine.content).toContain('note-aaa');
      expect(engine.content).toContain('note-bbb');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('without a coordinator, a single caller still works (append + overwrite + credential rejection unchanged)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs3b-memfb-'));
    try {
      const engine = new MemoryEngine(dir);
      const tools = createMemoryTools(engine);
      const tool = tools.find((t) => t.name === 'memory_write')!;

      const appended = await tool.execute({ path: 'notes/t.md', content: 'plain health note', mode: 'append' });
      expect(appended.isError).toBeFalsy();
      expect(await engine.readFile('notes/t.md')).toContain('plain health note');

      const overwritten = await tool.execute({ path: 'notes/t.md', content: 'replacement note', mode: 'overwrite' });
      expect(overwritten.isError).toBeFalsy();
      expect(await engine.readFile('notes/t.md')).toBe('replacement note');

      const rejected = await tool.execute({
        path: 'notes/t.md',
        content: 'leaked api_key = "abcd1234abcd1234abcd1234ab"',
        mode: 'overwrite',
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text).toMatch(/credential pattern/);
      expect(await engine.readFile('notes/t.md')).toBe('replacement note');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an accessor that resolves to undefined degrades to inline (availability over atomicity)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs3b-memdeg-'));
    try {
      const engine = new MemoryEngine(dir);
      const tools = createMemoryTools(engine, undefined, undefined, undefined, undefined, () => undefined);
      const tool = tools.find((t) => t.name === 'memory_write')!;

      const result = await tool.execute({ path: 'notes/t.md', content: 'degraded note', mode: 'overwrite' });
      expect(result.isError).toBeFalsy();
      expect(await engine.readFile('notes/t.md')).toBe('degraded note');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
