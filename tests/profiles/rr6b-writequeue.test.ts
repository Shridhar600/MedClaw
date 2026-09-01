import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WriteQueue, replayJournal } from '../../src/profiles';

describe('RR-6b WriteQueue intent and commit journal', () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr6b-wq-'));
    journalPath = path.join(tmpDir, '.state', 'journal');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a begin and commit record with scope and idempotency key for a successful source op', async () => {
    const queue = new WriteQueue({
      journalPath,
      idGen: { newId: () => 'journal-op-1' },
    });

    await expect(queue.enqueue('turn', {
      label: 'capture:ledger-fact',
      scope: 'ledger',
      idempotencyKey: 'capture-1',
      run: async () => 'source-write-complete',
    })).resolves.toBe('source-write-complete');

    const records = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toEqual([
      {
        phase: 'begin',
        id: 'journal-op-1',
        label: 'capture:ledger-fact',
        scope: 'ledger',
        idempotencyKey: 'capture-1',
      },
      { phase: 'commit', id: 'journal-op-1' },
    ]);
  });

  it('detects an uncommitted begin during boot reconciliation', async () => {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, JSON.stringify({
      phase: 'begin',
      id: 'crashed-op',
      label: 'capture:narrative-note',
      scope: 'narrative',
      idempotencyKey: 'capture-2',
    }) + '\n');
    const seen: string[] = [];

    await replayJournal(journalPath, (label) => { seen.push(label); });

    expect(seen).toEqual(['capture:narrative-note']);
  });

  it('detects an uncommitted begin again when the queue reaches idle', async () => {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, JSON.stringify({
      phase: 'begin',
      id: 'idle-op',
      label: 'capture:metric-point',
      scope: 'metric',
      idempotencyKey: 'capture-3',
    }) + '\n');
    const seen: string[] = [];
    const queue = new WriteQueue({
      journalPath,
      onReconcile: (record) => { seen.push(record.label); },
    });

    await queue.drain();

    expect(seen).toEqual(['capture:metric-point']);
  });
});
