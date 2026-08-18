import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WriteQueue, replayJournal } from '../../src/profiles';

let tmpDir: string;
let jp: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-wq-'));
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

    const j = await fs.promises.readFile(jp, 'utf-8');
    expect(j).toContain('ledger:x');     // failed line survives as an A4 replay target
    expect(j).not.toContain('ledger:y'); // succeeded line cleared
  });

  it('does not cross-delete a stuck line when a later op shares the same label', async () => {
    const q = new WriteQueue({ journalPath: jp });
    await expect(
      q.enqueue('turn', { label: 'ledger:dup', run: async () => { throw new Error('boom'); } }),
    ).rejects.toThrow();
    await q.enqueue('turn', { label: 'ledger:dup', run: async () => { /* succeeds */ } });

    const j = await fs.promises.readFile(jp, 'utf-8');
    // exactly one 'ledger:dup' line remains — the failed one, not the succeeded one
    expect(j.split('\n').filter(l => l.includes('ledger:dup'))).toHaveLength(1);
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
