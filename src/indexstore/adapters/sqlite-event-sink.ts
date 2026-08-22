// src/indexstore/adapters/sqlite-event-sink.ts
//
// EventSink adapter over SQLite — the append-only event store feeding Stage-3 entity-correlation
// lag queries (P2 Task A3, specs/07 §4 `events`). Own better-sqlite3 connection to the per-profile
// search.db (WAL + busy_timeout, D6); imports better-sqlite3 DIRECTLY — never src/memory/.
// Mirror-layer owned (M-3): the `events` table.

import Database from 'better-sqlite3';
import { summarizeErrorForLog } from '../../security';
import type { EventSink, EventRecord, TimeRange } from '../../ports';

export interface SqliteEventSinkConfig {
  dbPath: string;
}

interface EventRow {
  id: string;
  event_type: string;
  entity: string;
  value: string;
  ts: string;
}

export class SqliteEventSink implements EventSink {
  private readonly db: Database.Database;

  constructor(config: SqliteEventSinkConfig) {
    this.db = new Database(config.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        event_type TEXT,
        entity TEXT,
        value TEXT,
        ts TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_entity_ts ON events(entity, ts);
    `);
  }

  async append(event: EventRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO events (id, event_type, entity, value, ts)
      VALUES (@id, @eventType, @entity, @value, @ts)
      ON CONFLICT(id) DO UPDATE SET
        event_type = excluded.event_type, entity = excluded.entity,
        value = excluded.value, ts = excluded.ts
    `).run({
      id: event.id,
      eventType: event.eventType,
      entity: event.entity,
      value: event.value,
      ts: event.ts,
    });
  }

  async *window(entity: string, range: TimeRange): AsyncIterable<EventRecord> {
    let rows: EventRow[];
    try {
      rows = this.db.prepare(`
        SELECT id, event_type, entity, value, ts FROM events
        WHERE entity = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC
      `).all(entity, range.start, range.end) as EventRow[];
    } catch (e) {
      console.warn('[sqlite-event-sink] window query failed:', summarizeErrorForLog(e));
      return;
    }
    for (const r of rows) {
      yield { id: r.id, eventType: r.event_type, entity: r.entity, value: r.value, ts: r.ts };
    }
  }

  /** Release the underlying connection. Not part of EventSink; needed for lifecycle/tests. */
  close(): void {
    try {
      this.db.close();
    } catch (e) {
      console.warn('[sqlite-event-sink] close failed:', summarizeErrorForLog(e));
    }
  }
}
