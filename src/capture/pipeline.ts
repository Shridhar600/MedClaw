import { NotImplementedError } from '../shared/errors';
import type { FactMirror, EventSink } from '../ports';

export interface CaptureEvent {
  profileId: string;
  kind: 'ledger-fact' | 'narrative-note' | 'curiosity-item' | 'metric-point';
  payload: unknown;
  source: string;
}

export class CapturePipeline {
  constructor(
    private factMirror: FactMirror,
    private eventSink: EventSink,
  ) {
    throw new NotImplementedError('CapturePipeline');
  }

  async ingest(event: CaptureEvent): Promise<void> {
    void event;
    throw new NotImplementedError('CapturePipeline.ingest');
  }
}
