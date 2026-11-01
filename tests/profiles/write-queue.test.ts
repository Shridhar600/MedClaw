import * as fs from 'fs';
import * as path from 'path';
import { WriteQueue, reconcileJournal } from '../../src/profiles';
import { makeTestTemp } from '../helpers/test-temp';

let tmpDir: string;
let jp: string;

beforeEach(() => {
  tmpDir = makeTestTemp('redacted-wq-');
  jp = path.join(tmpDir, '.state', 'journal');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('WriteQueue serialization', () => {
  it('runs at most one op at a time, in FIFO order within a priority', async () => {
    const q = new WriteQueue({ journalPath: jp });
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const mkOp = (label: string) => ({
      label,
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 5));
        order.push(label);
        active--;
      },
    });
    await Promise.all([
      q.enqueue('turn', mkOp('a')),
      q.enqueue('turn', mkOp('b')),
      q.enqueue('turn', mkOp('c')),
    ]);
    expect(maxActive).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('WriteQueue priority', () => {
  it('lets a queued turn op jump an already-queued background op', async () => {
    const q = new WriteQueue({ journalPath: jp });
    const order: string[] = [];
    let releaseGate!: () => void;
    const gateBlocked = new Promise<void>(r => { releaseGate = r; });

    const gate = q.enqueue('turn', { label: 'gate', run: async () => { order.push('gate'); await gateBlocked; } });
    const bg = q.enqueue('background', { label: 'bg', run: async () => { order.push('bg'); } });
    const turn2 = q.enqueue('turn', { label: 'turn2', run: async () => { order.push('turn2'); } });

    releaseGate();
    await Promise.all([gate, bg, turn2]);
    expect(order).toEqual(['gate', 'turn2', 'bg']);
  });
});

describe('WriteQueue journal', () => {
  it('reports a failed op once at the next idle, then empties the journal', async () => {
    const reconciled: string[] = [];
    const q = new WriteQueue({ journalPath: jp, onReconcile: (record) => { reconciled.push(record.label); } });
    await expect(
      q.enqueue('turn', { label: 'ledger:x', run: async () => { throw new Error('disk full'); } }),
    ).rejects.toThrow();
    await q.enqueue('turn', { label: 'ledger:y', run: async () => { /* succeeds */ } });
    await q.drain();
    await q.enqueue('turn', { label: 'ledger:z', run: async () => { /* succeeds */ } });
    await q.drain();

    expect(reconciled).toEqual(['ledger:x']);
    expect(fs.readFileSync(jp, 'utf8')).toBe('');
  });

  it('does not let a later op with the same label hide a failed one', async () => {
    const reconciled: string[] = [];
    const q = new WriteQueue({ journalPath: jp, onReconcile: (record) => { reconciled.push(record.label); } });
    await expect(
      q.enqueue('turn', { label: 'ledger:dup', run: async () => { throw new Error('boom'); } }),
    ).rejects.toThrow();
    await q.enqueue('turn', { label: 'ledger:dup', run: async () => { /* succeeds */ } });
    await q.drain();
    expect(reconciled).toEqual(['ledger:dup']);
  });

  it('never blocks an op when the journal path is unwritable (warn-and-continue)', async () => {
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const q = new WriteQueue({ journalPath: path.join(blocker, 'journal') });
      const result = await q.enqueue('turn', { label: 'ok', run: async () => 42 });
      expect(result).toBe(42);
      expect(warnSpy).toHaveBeenCalled(); // journal write failure was logged, not thrown
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('WriteQueue drain', () => {
  it('waits for the idle journal callback before returning', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const q = new WriteQueue({ journalPath: jp, onReconcile: () => gate });
    await expect(q.enqueue('turn', { label: 'ledger:x', run: async () => { throw new Error('boom'); } })).rejects.toThrow();
    let settled = false;
    const drain = q.drain().then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await drain;
    expect(settled).toBe(true);
  });
});

describe('reconcileJournal at boot', () => {
  it('reports each op that never committed, then empties the journal', async () => {
    fs.mkdirSync(path.dirname(jp), { recursive: true });
    fs.writeFileSync(jp, [
      JSON.stringify({ phase: 'begin', id: 'a', label: 'ledger:a' }),
      JSON.stringify({ phase: 'begin', id: 'b', label: 'ledger:b' }),
      JSON.stringify({ phase: 'commit', id: 'b' }),
      'not json',
    ].join('\n') + '\n');
    const surfaced: string[] = [];
    await expect(reconcileJournal(jp, (record) => { surfaced.push(record.label); }))
      .resolves.toEqual({ readable: true, uncommitted: 1 });
    expect(surfaced).toEqual(['ledger:a']);
    expect(fs.readFileSync(jp, 'utf8')).toBe('');
  });

  it('is a no-op when the journal file does not exist', async () => {
    await expect(reconcileJournal(path.join(tmpDir, 'nope', 'journal'))).resolves.toEqual({ readable: false, uncommitted: 0 });
  });
});
