// Shared EventSink contract (P2 Task A3). The append-only event store feeding Stage-3
// entity-correlation lag queries (DIAB-07 is P5; the sink is populated in P2 on metric/fact
// writes). NOT a test file itself; invoked from an adapter's own *.test.ts.

import type { EventSink, EventRecord } from '../../src/ports';

export type ContractEventSink = EventSink & { close?: () => void };
export type MakeEventSink = () => ContractEventSink;

async function collect(it: AsyncIterable<EventRecord>): Promise<EventRecord[]> {
  const out: EventRecord[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function ev(id: string, over: Partial<EventRecord> = {}): EventRecord {
  return {
    id,
    eventType: over.eventType ?? 'ledger:medication',
    entity: over.entity ?? 'metformin',
    value: over.value ?? 'active',
    ts: over.ts ?? '2026-08-12T00:00:00.000Z',
    ...over,
  };
}

export function runEventSinkContract(makeSink: MakeEventSink): void {
  describe('EventSink contract (P2 A3)', () => {
    let sink: ContractEventSink;

    beforeEach(() => {
      sink = makeSink();
    });
    afterEach(() => {
      sink.close?.();
    });

    it('append then window returns events for the entity within the time range', async () => {
      await sink.append(ev('e1', { entity: 'metformin', ts: '2026-08-10T00:00:00.000Z' }));
      await sink.append(ev('e2', { entity: 'metformin', ts: '2026-08-12T00:00:00.000Z' }));
      const rows = await collect(sink.window('metformin', { start: '2026-08-11T00:00:00.000Z', end: '2026-08-13T00:00:00.000Z' }));
      expect(rows.map(r => r.id)).toEqual(['e2']);
    });

    it('window filters out other entities', async () => {
      await sink.append(ev('a', { entity: 'metformin' }));
      await sink.append(ev('b', { entity: 'jardiance' }));
      const rows = await collect(sink.window('metformin', { start: '2026-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' }));
      expect(rows.map(r => r.id)).toEqual(['a']);
    });

    it('append is idempotent by id (re-append updates, no duplicate)', async () => {
      await sink.append(ev('e1', { value: 'active' }));
      await sink.append(ev('e1', { value: 'discontinued' }));
      const rows = await collect(sink.window('metformin', { start: '2026-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' }));
      expect(rows).toHaveLength(1);
      expect(rows[0].value).toBe('discontinued');
    });

    it('window returns events sorted by ts ascending', async () => {
      await sink.append(ev('late', { ts: '2026-08-20T00:00:00.000Z' }));
      await sink.append(ev('early', { ts: '2026-08-01T00:00:00.000Z' }));
      const rows = await collect(sink.window('metformin', { start: '2026-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' }));
      expect(rows.map(r => r.id)).toEqual(['early', 'late']);
    });
  });
}
