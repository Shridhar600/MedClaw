import * as fs from 'fs';
import * as path from 'path';
import { WriteQueue, replayJournal } from '../../src/profiles';
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
    // Enqueued while `gate` is in flight: background first, then turn.
    const bg = q.enqueue('background', { label: 'bg', run: async () => { order.push('bg'); } });
    const turn2 = q.enqueue('turn', { label: 'turn2', run: async () => { order.push('turn2'); } });

    releaseGate();
    await Promise.all([gate, bg, turn2]);
    expect(order).toEqual(['gate', 'turn2', 'bg']);
  });
});

describe('WriteQueue per-line journal', () => {
  it('keeps a failed op line at boot even after a later op succeeds', async () => {
    const q = new WriteQueue({ journalPath: jp });
    await expect(
      q.enqueue('turn', { label: 'ledger:x', run: async () => { throw new Error('disk full'); } }),
    ).rejects.toThrow();
    await q.enqueue('turn', { label: 'ledger:y', run: async () => { /* succeeds */ } });

    const records = (await fs.promises.readFile(jp, 'utf-8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { phase: string; id: string; label?: string });
    const failed = records.find((record) => record.phase === 'begin' && record.label === 'ledger:x');
    const succeeded = records.find((record) => record.phase === 'begin' && record.label === 'ledger:y');
    expect(failed).toBeDefined(); // failed intent remains an unresolved A4 recovery target
    expect(succeeded).toBeDefined();
    expect(records).toContainEqual({ phase: 'commit', id: succeeded!.id }); // success is explicit, not deletion
    expect(records).not.toContainEqual({ phase: 'commit', id: failed!.id });
  });

  it('does not cross-delete a stuck line when a later op shares the same label', async () => {
    const q = new WriteQueue({ journalPath: jp });
    await expect(
      q.enqueue('turn', { label: 'ledger:dup', run: async () => { throw new Error('boom'); } }),
    ).rejects.toThrow();
    await q.enqueue('turn', { label: 'ledger:dup', run: async () => { /* succeeds */ } });

    const records = (await fs.promises.readFile(jp, 'utf-8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { phase: string; id: string; label?: string });
    const begins = records.filter((record) => record.phase === 'begin' && record.label === 'ledger:dup');
    const commits = new Set(records.filter((record) => record.phase === 'commit').map((record) => record.id));
    // Same-label operations remain distinct: only the successful id is committed.
    expect(begins).toHaveLength(2);
    expect(begins.filter((record) => commits.has(record.id))).toHaveLength(1);
  });

  it('never blocks an op when the journal path is unwritable (warn-and-continue)', async () => {
    // Point the journal at a path whose parent is a FILE, so every journal write fails.
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

describe('WriteQueue drain reconciliation lifetime', () => {
  it('waits for overlapping and follow-on idle journal callbacks before returning', async () => {
    const gate = () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      return { promise, release };
    };
    const firstGate = gate();
    const secondGate = gate();
    const thirdGate = gate();
    const firstStarted = gate();
    const secondStarted = gate();
    const thirdStarted = gate();
    const firstFinished = gate();
    const secondFinished = gate();
    const thirdFinished = gate();
    const reconciled: string[] = [];
    let callbacksStarted = 0;
    const q = new WriteQueue({
      journalPath: jp,
      onReconcile: async (record) => {
        callbacksStarted += 1;
        reconciled.push(record.label);
        if (reconciled.length === 1) {
          firstStarted.release();
          await firstGate.promise;
          firstFinished.release();
        } else if (reconciled.length === 2) {
          secondStarted.release();
          await secondGate.promise;
          secondFinished.release();
        } else if (reconciled.length === 3) {
          thirdStarted.release();
          await thirdGate.promise;
          thirdFinished.release();
        }
      },
    });
    let drain: Promise<void> | undefined;
    let drainSettled = false;

    try {
      await expect(q.enqueue('turn', {
        label: 'retained-unresolved-intent',
        run: async () => { throw new Error('source write failed'); },
      })).rejects.toThrow('source write failed');
      await firstStarted.promise;

      await expect(q.enqueue('turn', {
        label: 'committed-write-two',
        run: async () => 'second-result',
      })).resolves.toBe('second-result');
      await secondStarted.promise;

      drain = q.drain();
      void drain.then(() => { drainSettled = true; });

      secondGate.release();
      await secondFinished.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      // The second overlapping callback is finished, but the first callback from the same
      // pre-drain snapshot is still held. Do not return after tracking only the latest callback.
      expect(drainSettled).toBe(false);

      await expect(q.enqueue('turn', {
        label: 'committed-write-three',
        run: async () => 'third-result',
      })).resolves.toBe('third-result');
      await thirdStarted.promise;

      firstGate.release();
      await firstFinished.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      // The initial drain snapshot has now settled, but this later idle callback remains held.
      expect(drainSettled).toBe(false);

      thirdGate.release();
      await thirdFinished.promise;
      await drain;
      expect(drainSettled).toBe(true);
      expect(reconciled).toEqual([
        'retained-unresolved-intent',
        'retained-unresolved-intent',
        'retained-unresolved-intent',
      ]);

      const records = (await fs.promises.readFile(jp, 'utf-8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { phase: string; id: string; label?: string });
      const failed = records.find((record) => record.phase === 'begin' && record.label === 'retained-unresolved-intent');
      const commits = new Set(records.filter((record) => record.phase === 'commit').map((record) => record.id));
      expect(failed).toBeDefined();
      expect(commits.has(failed!.id)).toBe(false);
      expect(records.filter((record) => record.phase === 'commit')).toHaveLength(2);
    } finally {
      firstGate.release();
      secondGate.release();
      thirdGate.release();
      const finished = [firstFinished, secondFinished, thirdFinished]
        .slice(0, callbacksStarted)
        .map((signal) => signal.promise);
      await Promise.all(finished);
      await q.drain();
    }
  });
});

describe('replayJournal', () => {
  it('surfaces each residual line via onStuck, then clears the file', async () => {
    fs.mkdirSync(path.dirname(jp), { recursive: true });
    fs.writeFileSync(jp, 'id1\tledger:a\nid2\tledger:b\n');
    const surfaced: string[] = [];
    await replayJournal(jp, async (label) => { surfaced.push(label); });
    expect(surfaced).toEqual(['ledger:a', 'ledger:b']);
    const after = await fs.promises.readFile(jp, 'utf-8');
    expect(after.trim()).toBe('');
  });

  it('leaves a line in the journal if its onStuck rejects (crash-safe replay)', async () => {
    fs.mkdirSync(path.dirname(jp), { recursive: true });
    fs.writeFileSync(jp, 'id1\tledger:a\nid2\tledger:b\n');
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await replayJournal(jp, async (label) => {
        if (label === 'ledger:a') throw new Error('recovery failed');
      });
      const after = await fs.promises.readFile(jp, 'utf-8');
      expect(after).toContain('ledger:a');     // unprocessed line survives for next boot
      expect(after).not.toContain('ledger:b'); // processed line cleared
      expect(warnSpy).toHaveBeenCalled();       // recovery failure was logged
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('is a no-op when the journal file does not exist', async () => {
    await expect(replayJournal(path.join(tmpDir, 'nope', 'journal'), async () => {})).resolves.toBeUndefined();
  });
});
