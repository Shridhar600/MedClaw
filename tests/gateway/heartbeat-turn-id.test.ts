// RR-STRUCT R-S3b Part B — heartbeat idempotency `turnId`.
//
// RED baseline: on HEAD f73b557 `HeartbeatTurnRequest` carries NO turnId and
// `executeHeartbeat` drops it, so a scheduler RETRY of a heartbeat re-runs the turn
// with a fresh `AgentLoop` sequence number — any `ledger_record` inside re-writes
// instead of returning the cached original. And a static `job.id`-only key would drop
// tomorrow's recurring reminder as a duplicate of tonight's.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CapturePipeline, FileCaptureIdempotency, makeSafetyRenderer } from '../../src/capture';
import { LedgerStore, NarrativeStore, SafetyView } from '../../src/memcore';
import { WriteQueue } from '../../src/profiles';
import { createLedgerTools } from '../../src/tools/ledger-tools';
import { LLMSemaphore } from '../../src/tools/semaphore';
import { TurnCoordinator, heartbeatTurnId } from '../../src/gateway/turn-coordinator';
import type { ProfileRuntime } from '../../src/gateway/runtime';
import type { AgentRunResult } from '../../src/providers/types';

function heartbeatResponse(text: string): AgentRunResult {
  return {
    text,
    trace: [{ role: 'assistant', content: text }],
    usedTools: [],
    healthResponse: false,
  };
}

describe('R-S3b Part B — heartbeat turnId scheme', () => {
  it('is stable across a RETRY of one occurrence (same job.id + same lastRunAt)', () => {
    const job = { id: 'job-1', lastRunAt: '2026-09-01T10:00:00.000Z' };
    expect(heartbeatTurnId(job)).toBe(heartbeatTurnId({ ...job }));
  });

  it('is distinct across occurrences (a static job.id alone would drop the next reminder)', () => {
    const tonight = heartbeatTurnId({ id: 'job-1', lastRunAt: '2026-09-01T10:00:00.000Z' })!;
    const tomorrow = heartbeatTurnId({ id: 'job-1', lastRunAt: '2026-09-02T10:00:00.000Z' })!;
    expect(tonight).not.toBe(tomorrow);
    // The occurrence MUST be in the key — a bare job.id is the exact bug this closes.
    expect(tonight).not.toBe('job-1');
    expect(tonight).toContain('job-1');
    expect(tonight).toContain('2026-09-01T10:00:00.000Z');
  });

  it('falls back to no key (today\u2019s behavior) when lastRunAt is undefined, never a random one', () => {
    expect(heartbeatTurnId({ id: 'job-1', lastRunAt: undefined })).toBeUndefined();
    expect(heartbeatTurnId({ id: 'job-1' })).toBeUndefined();
  });
});

describe('R-S3b Part B — runHeartbeat threads the turnId into the agent turn', () => {
  function makeRuntime(agentRun: jest.Mock) {
    return {
      agentLoop: { run: agentRun },
      sessions: {
        prepareHistory: jest.fn().mockResolvedValue([]),
        recordTurn: jest.fn().mockResolvedValue([]),
        recordPromptUsage: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as ProfileRuntime;
  }

  it('passes a supplied heartbeat turnId through to AgentLoop.run', async () => {
    const agentRun = jest.fn().mockResolvedValue(heartbeatResponse('done'));
    const coordinator = new TurnCoordinator(makeRuntime(agentRun), new LLMSemaphore());
    const egress = jest.fn().mockResolvedValue(undefined);
    const afterDelivery = jest.fn().mockResolvedValue(undefined);

    await coordinator.runHeartbeat({
      chatId: 'chat-1',
      input: '[Heartbeat Trigger]\nreminder',
      egress,
      afterDelivery,
      turnId: 'job-1:2026-09-01T10:00:00.000Z',
    });

    expect(agentRun).toHaveBeenCalledTimes(1);
    expect(agentRun.mock.calls[0][2]).toMatchObject({
      chatId: 'chat-1',
      origin: 'heartbeat',
      mode: 'heartbeat',
      turnId: 'job-1:2026-09-01T10:00:00.000Z',
    });
  });

  it('without a turnId the heartbeat still runs (AgentLoop sequence fallback, unchanged)', async () => {
    const agentRun = jest.fn().mockResolvedValue(heartbeatResponse('done'));
    const coordinator = new TurnCoordinator(makeRuntime(agentRun), new LLMSemaphore());

    const result = await coordinator.runHeartbeat({
      chatId: 'chat-1',
      input: '[Heartbeat Trigger]\nreminder',
      egress: jest.fn().mockResolvedValue(undefined),
      afterDelivery: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.status).toBe('sent');
    expect(agentRun.mock.calls[0][2]).toMatchObject({ chatId: 'chat-1', origin: 'heartbeat', mode: 'heartbeat' });
    expect(agentRun.mock.calls[0][2].turnId).toBeUndefined();
  });
});

describe('R-S3b Part B — a heartbeat ledger_record dedupes on retry, fires anew next occurrence', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rs3b-hb-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('same (job.id, lastRunAt) returns the cached original; a new lastRunAt writes anew', async () => {
    const ledger = new LedgerStore(root);
    const narrative = new NarrativeStore(root);
    const view = new SafetyView(root);
    const safety = makeSafetyRenderer({
      render: (facts) => view.render(facts),
      listSafetyRelevant: () => ledger.listSafetyRelevant(),
    });
    const queue = new WriteQueue({ journalPath: path.join(root, '.state', 'write-queue.journal') });
    const pipeline = new CapturePipeline({
      queue,
      ledger,
      narrative,
      safety,
      idempotency: new FileCaptureIdempotency(path.join(root, '.state', 'capture-idempotency.log')),
    });
    const [ledgerRecord] = createLedgerTools({ pipeline, ledger, safety, queue });

    const params = { entity: 'morning-walk', type: 'symptom', fields: { severity: 'mild' } };
    const retryContext = {
      chatId: 'chat-1',
      turnId: heartbeatTurnId({ id: 'job-1', lastRunAt: '2026-09-01T10:00:00.000Z' }),
      toolCallId: 'call-1',
    };
    const first = await ledgerRecord.execute({ ...params }, retryContext);
    expect(first.isError).toBeFalsy();

    // Scheduler RETRY of the same occurrence: same key → cached ORIGINAL, no double-write.
    const replayed = await ledgerRecord.execute({ ...params }, retryContext);
    expect(replayed.content[0].text).toBe(first.content[0].text);

    // NEXT occurrence: new lastRunAt → NOT dropped as a duplicate.
    const next = await ledgerRecord.execute(
      { ...params },
      { ...retryContext, turnId: heartbeatTurnId({ id: 'job-1', lastRunAt: '2026-09-02T10:00:00.000Z' }) },
    );
    expect(next.isError).toBeFalsy();
    expect(next.content[0].text).not.toBe(first.content[0].text);
  });
});
