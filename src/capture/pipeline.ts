// src/capture/pipeline.ts
//
// CapturePipeline — the turn-level CaptureEvent router. Given a normalized event, it
// writes BOTH memory lanes (structured ledger + lossless narrative) with cross-anchors
// and re-renders SAFETY.md on safety-relevant facts, all serialized through the write
// queue (a single turn-priority op per event, IO-only — amendment B2).
//
// Boundary (F5/G7): every dependency is a typed IN-MODULE interface — no concrete-class
// import from memcore, only type-only. Gateway (Task 13) injects the concrete
// LedgerStore / NarrativeStore / SafetyView-adapter / WriteQueue / CuriosityQueue, which
// structurally satisfy these ports.

import type { Clock, EventSink } from '../ports';
import { systemClock } from '../ports';
import type {
  LedgerFact,
  CaptureEvent,
  RecordFactResult,
  RetractResult,
  CuriosityItem,
  Provenance,
  FactType,
  LedgerFactInput,
  NarrativeNoteInput,
  MetricPointInput,
  LedgerCorrectionInput,
} from '../memcore';
import { summarizeErrorForLog } from '../security';

/** The single-writer queue seam (WriteQueue). Ops MUST be IO-only (B2). */
export interface QueuePort {
  enqueue<T>(priority: 'turn' | 'background', op: { label: string; run(): Promise<T> }): Promise<T>;
}

/** The structured lane. Mirrors LedgerStore.recordFact / retract. */
export interface LedgerWriter {
  recordFact(p: {
    entity: string;
    type: FactType;
    fields: Record<string, string | number | string[]>;
    provenance: Provenance;
    safetyRelevant?: boolean;
    episodeId?: string;
    language?: string;
    verbatim?: string;
    replaces?: string;
    corrects?: string;
  }): Promise<RecordFactResult>;
  retract(p: { entity: string; type: FactType; provenance: Provenance }): Promise<RetractResult>;
}

/** The lossless daily-log lane. Mirrors NarrativeStore. */
export interface NarrativeWriter {
  append(e: { text: string; language?: string; verbatim?: string; date?: string }): Promise<{ date: string; anchor: string }>;
  appendLedgerAnchor(date: string, entity: string, factId: string): Promise<string>;
}

/** The SAFETY.md view. `listSafetyRelevant` sources the full current set to re-render from (D8). */
export interface SafetyRenderer {
  render(safetyRelevantFacts: LedgerFact[]): Promise<string>;
  listSafetyRelevant(): Promise<LedgerFact[]>;
}

/** The durable follow-up queue (consumed P4). Mirrors CuriosityQueue.add. */
export interface CuriosityWriter {
  add(item: Omit<CuriosityItem, 'id' | 'profileId' | 'createdAt'>): Promise<CuriosityItem>;
}

export interface CapturePipelineDeps {
  queue: QueuePort;
  ledger: LedgerWriter;
  narrative: NarrativeWriter;
  safety: SafetyRenderer;
  curiosity?: CuriosityWriter;
  events?: EventSink;
  clock?: Clock;
}

export class CapturePipeline {
  private readonly clock: Clock;

  constructor(private readonly deps: CapturePipelineDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Route one capture event. The whole per-event work runs inside ONE turn-priority
   * queue op so both lanes and the SAFETY re-render land atomically relative to other
   * writes. Returns the ledger result for fact-bearing kinds (so the tool layer can relay
   * a needs-confirmation / disputed question); void for narrative-only kinds.
   */
  async ingest(event: CaptureEvent): Promise<RecordFactResult | void> {
    return this.deps.queue.enqueue('turn', {
      label: `capture:${event.kind}`,
      run: () => this.route(event),
    });
  }

  private route(event: CaptureEvent): Promise<RecordFactResult | void> {
    switch (event.kind) {
      case 'ledger-fact':
        return this.ingestLedgerFact(event.payload);
      case 'narrative-note':
        return this.ingestNarrativeNote(event.payload);
      case 'metric-point':
        return this.ingestMetricPoint(event.payload);
      case 'curiosity-item':
        return this.ingestCuriosity(event.payload);
      case 'ledger-correction':
        return this.ingestCorrection(event.payload);
      default: {
        // Defensive: an untyped source could deliver an unknown kind. Warn, never throw.
        console.warn(`[capture] ignoring unknown event kind: ${String((event as { kind?: unknown }).kind)}`);
        return Promise.resolve();
      }
    }
  }

  // ---- kinds -------------------------------------------------------------

  private async ingestLedgerFact(p: LedgerFactInput): Promise<RecordFactResult> {
    const day = this.dayOf(p.provenance.capturedAt);
    // Lossless narrative first, so the structured fact can anchor back to it (KNEE-01).
    const { anchor } = await this.deps.narrative.append({
      text: p.text ?? p.entity,
      language: p.language,
      verbatim: p.verbatim,
      date: day,
    });
    const result = await this.deps.ledger.recordFact({
      entity: p.entity,
      type: p.type,
      fields: p.fields,
      provenance: { ...p.provenance, anchor },
      safetyRelevant: p.safetyRelevant,
      episodeId: p.episodeId,
      language: p.language,
      verbatim: p.verbatim,
      replaces: p.replaces,
      corrects: p.corrects,
    });
    // needs-confirmation / disputed: the narrative note stands, but there is no applied
    // fact yet — do NOT write the cross-anchor and do NOT re-render SAFETY.
    if (result.kind === 'applied') {
      await this.deps.narrative.appendLedgerAnchor(day, p.entity, result.fact.id);
      if (result.fact.safetyRelevant) await this.reRenderSafety();
      await this.emitEvent(result.fact);
    }
    return result;
  }

  private async ingestNarrativeNote(p: NarrativeNoteInput): Promise<void> {
    await this.deps.narrative.append({ text: p.text, language: p.language, verbatim: p.verbatim, date: p.date });
  }

  private async ingestMetricPoint(p: MetricPointInput): Promise<RecordFactResult> {
    const day = this.dayOf(p.provenance.capturedAt);
    const { anchor } = await this.deps.narrative.append({
      text: p.note ?? `${p.entity} reading`,
      language: p.language,
      date: day,
    });
    const result = await this.deps.ledger.recordFact({
      entity: p.entity,
      type: 'metric',
      // F19 / DIAB-02: a metric fact always carries its day-granularity date as a field.
      fields: { ...p.fields, date: p.date },
      provenance: { ...p.provenance, anchor },
      safetyRelevant: p.safetyRelevant,
      language: p.language,
    });
    if (result.kind === 'applied') {
      await this.deps.narrative.appendLedgerAnchor(day, p.entity, result.fact.id);
      if (result.fact.safetyRelevant) await this.reRenderSafety();
      await this.emitEvent(result.fact);
    }
    return result;
  }

  private async ingestCuriosity(p: Omit<CuriosityItem, 'id' | 'profileId' | 'createdAt'>): Promise<void> {
    const writer = this.deps.curiosity;
    if (!writer) {
      console.warn('[capture] curiosity-item dropped: no curiosity writer configured');
      return;
    }
    await writer.add(p);
  }

  private async ingestCorrection(p: LedgerCorrectionInput): Promise<RecordFactResult | void> {
    const day = this.dayOf(p.corrected.provenance.capturedAt);
    const { anchor } = await this.deps.narrative.append({ text: p.note, date: day });

    // Record the corrected fact first (additive, safe), carrying the cross-link to the
    // mistaken fact. Then retract the mistaken one — both lanes in this one queue op.
    const corrected = await this.deps.ledger.recordFact({
      entity: p.corrected.entity,
      type: p.corrected.type,
      fields: p.corrected.fields,
      provenance: { ...p.corrected.provenance, anchor },
      safetyRelevant: p.corrected.safetyRelevant,
      episodeId: p.corrected.episodeId,
      language: p.corrected.language,
      verbatim: p.corrected.verbatim,
      replaces: p.corrected.replaces,
      corrects: p.corrected.corrects,
    });

    let safetyTouched = false;
    if (corrected.kind === 'applied') {
      await this.deps.narrative.appendLedgerAnchor(day, p.corrected.entity, corrected.fact.id);
      safetyTouched = corrected.fact.safetyRelevant;
      await this.emitEvent(corrected.fact);
    }

    const retract = await this.deps.ledger.retract({
      entity: p.wrong.entity,
      type: p.wrong.type,
      provenance: p.corrected.provenance,
    });
    if (retract.kind === 'applied') {
      safetyTouched = safetyTouched || retract.fact.safetyRelevant;
    } else if (retract.kind === 'needs-confirmation') {
      // The mistaken fact is safety-relevant; it stays active pending user confirmation,
      // while the corrected fact is already recorded. The tool layer relays the token.
      console.warn(`[capture] correction retract needs confirmation for "${p.wrong.entity}"; corrected fact recorded, mistaken fact retained pending confirmation`);
    }

    if (safetyTouched) await this.reRenderSafety();
    return corrected;
  }

  // ---- helpers -----------------------------------------------------------

  /** Re-render SAFETY.md from the current safety-relevant set (D8). */
  private async reRenderSafety(): Promise<void> {
    const facts = await this.deps.safety.listSafetyRelevant();
    await this.deps.safety.render(facts);
  }

  /** Best-effort event mirror (P2 no-op when no sink is injected). Never throws. */
  private async emitEvent(fact: LedgerFact): Promise<void> {
    const sink = this.deps.events;
    if (!sink) return;
    try {
      await sink.append({
        id: fact.id,
        eventType: `ledger:${fact.type}`,
        entity: fact.entity,
        value: fact.status,
        ts: fact.provenance.capturedAt,
      });
    } catch (e) {
      console.warn(`[capture] event sink append failed: ${summarizeErrorForLog(e)}`);
    }
  }

  /**
   * Both lanes agree on the same day, derived from the event's capturedAt — NOT a
   * divergent store clock (F20). The injected clock is only a defensive fallback for a
   * missing/invalid capturedAt.
   */
  private dayOf(iso?: string): string {
    const parsed = iso ? new Date(iso) : this.clock.now();
    const valid = Number.isNaN(parsed.getTime()) ? this.clock.now() : parsed;
    return valid.toISOString().slice(0, 10);
  }
}
