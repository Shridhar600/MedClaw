import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CapturePipeline, FileCaptureIdempotency, makeSafetyRenderer, type QueuePort } from '../../src/capture';
import { LedgerStore, NarrativeStore, SafetyView } from '../../src/memcore';
import { WriteQueue } from '../../src/profiles';

describe('RR-6b capture idempotency', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr6b-capture-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makePipeline(): CapturePipeline {
    const ledger = new LedgerStore(root);
    const narrative = new NarrativeStore(root);
    const view = new SafetyView(root);
    const safety = makeSafetyRenderer({
      render: (facts) => view.render(facts),
      listSafetyRelevant: () => ledger.listSafetyRelevant(),
    });
    const queue: QueuePort = new WriteQueue({ journalPath: path.join(root, '.state', 'write-queue.journal') });
    return new CapturePipeline({
      queue,
      ledger,
      narrative,
      safety,
      idempotency: new FileCaptureIdempotency(path.join(root, '.state', 'capture-idempotency.log')),
    });
  }

  const event = {
    profileId: 'default',
    source: 'telegram',
    kind: 'ledger-fact' as const,
    idempotencyKey: 'telegram:chat-1:message-7',
    payload: {
      entity: 'metformin',
      type: 'medication' as const,
      fields: { dose: '500mg' },
      provenance: {
        source: 'user' as const,
        confidence: 1,
        anchor: '',
        capturedAt: '2026-08-26T10:00:00.000Z',
      },
      text: 'started metformin 500mg',
    },
  };

  it('replaying one capture event is a no-op for both ledger and narrative lanes', async () => {
    const pipeline = makePipeline();

    await pipeline.ingest(event);
    await pipeline.ingest(event);

    const ledger = new LedgerStore(root);
    const facts = await ledger.listAllOfType('medication');
    const narrative = new NarrativeStore(root);
    const day = await narrative.read('2026-08-26');
    expect(facts).toHaveLength(1);
    expect(day?.match(/started metformin 500mg/g)).toHaveLength(1);
  });

  it('replaying the same keyed event after a simulated restart remains a no-op', async () => {
    await makePipeline().ingest(event);
    await makePipeline().ingest(event);

    const ledger = new LedgerStore(root);
    expect(await ledger.listAllOfType('medication')).toHaveLength(1);
    const narrative = new NarrativeStore(root);
    expect((await narrative.read('2026-08-26'))?.match(/started metformin 500mg/g)).toHaveLength(1);
  });
});
