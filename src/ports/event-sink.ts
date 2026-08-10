export interface EventRecord {
  id: string;
  eventType: string;
  entity: string;
  value: string;
  ts: string;
}

export interface TimeRange {
  start: string;
  end: string;
}

export interface EventSink {
  append(event: EventRecord): Promise<void>;
  window(entity: string, range: TimeRange): AsyncIterable<EventRecord>;
}
