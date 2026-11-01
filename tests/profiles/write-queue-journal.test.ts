import * as fs from 'fs';
import * as path from 'path';
import { WriteQueue, reconcileJournal } from '../../src/profiles';
import { makeTestTemp } from '../helpers/test-temp';

describe('WriteQueue intent and commit journal', () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = makeTestTemp('redacted-wq-');
    journalPath = path.join(tmpDir, '.state', 'journal');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('holds a begin record with scope and idempotency key while the source op runs', async () => {
    const queue = new WriteQueue({
      journalPath,
      idGen: { newId: () => 'journal-op-1' },
    });
    let duringRun: unknown[] = [];

    await expect(queue.enqueue('turn', {
      label: 'capture:ledger-fact',
      scope: 'ledger',
      idempotencyKey: 'capture-1',
      run: async () => {
        duringRun = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        return 'source-write-complete';
      },
    })).resolves.toBe('source-write-complete');
    await queue.drain();

    expect(duringRun).toEqual([{
      phase: 'begin',
      id: 'journal-op-1',
      label: 'capture:ledger-fact',
      scope: 'ledger',
      idempotencyKey: 'capture-1',
    }]);
    expect(fs.readFileSync(journalPath, 'utf8')).toBe('');
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

    await reconcileJournal(journalPath, (record) => { seen.push(record.label); });

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
