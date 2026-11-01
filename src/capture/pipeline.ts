import type { Clock, EventSink } from '../ports';
import { systemClock } from '../ports';
import { randomUUID } from 'crypto';
import type {
  LedgerFact,
  CaptureEvent,
  ConfirmationToken,
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
import { summarizeErrorForLog, contentContainsCredentials } from '../security';
import { sanitizeSingleLine, TYPE_TO_FILE } from '../memcore';
import type { CaptureIdempotency } from './idempotency';

/** Write-queue seam; ops must be IO-only. */
export interface QueuePort {
  enqueue<T>(priority: 'turn' | 'background', op: {
    label: string;
    scope?: string;
    idempotencyKey?: string;
    run(): Promise<T>;
  }): Promise<T>;
}

export type CaptureEventInput = CaptureEvent & { idempotencyKey?: string };

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

export interface NarrativeWriter {
  append(e: { text: string; language?: string; verbatim?: string; date?: string }): Promise<{ date: string; anchor: string }>;
  appendLedgerAnchor(date: string, entity: string, factId: string): Promise<string>;
}

export interface SafetyRenderer {
  render(safetyRelevantFacts: LedgerFact[]): Promise<string>;
  listSafetyRelevant(): Promise<LedgerFact[]>;
  /** Persist a PHI-free fail-closed signal when publication cannot complete. */
  markDirty?(): void;
}

export interface CuriosityWriter {
  add(item: Omit<CuriosityItem, 'id' | 'profileId' | 'createdAt'>): Promise<CuriosityItem>;
}

// Tier 1 runs synchronously inside the write lock; tier 2 runs outside it because embeddings must not.
export interface Rederiver {
  rederive(relPaths: string[]): Promise<void>;
}

// A failed safety render must not fail the write: mark dirty and let the next read repair.
export async function refreshSafetyView(safety: SafetyRenderer): Promise<void> {
  try {
    await safety.render(await safety.listSafetyRelevant());
  } catch (e) {
    try {
      safety.markDirty?.();
    } catch (markError) {
      console.warn('[capture] SAFETY dirty marker failed:', summarizeErrorForLog(markError));
    }
    console.warn('[capture] SAFETY refresh failed; view marked dirty for repair:', summarizeErrorForLog(e));
  }
}

export interface CapturePipelineDeps {
  queue: QueuePort;
  ledger: LedgerWriter;
  narrative: NarrativeWriter;
  safety: SafetyRenderer;
  curiosity?: CuriosityWriter;
  events?: EventSink;
  clock?: Clock;
  /** Sync tier: runs inside the lock and must not enqueue; the guard rejects rather than deadlocks. */
  tier1Rederive?: Rederiver;
  rederive?: Rederiver;
  idempotency?: CaptureIdempotency;
}

interface RouteOutcome {
  result: RecordFactResult | void;
  changed: string[];
}

export class CapturePipeline {
  private readonly clock: Clock;
  private readonly eventKeys = new WeakMap<object, string>();

  constructor(private readonly deps: CapturePipelineDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Runs the whole event as one write-queue op so both lanes commit together. */
  async ingest(event: CaptureEventInput): Promise<RecordFactResult | void> {
    const idempotencyKey = this.idempotencyKeyFor(event);
    const outcome = await this.deps.queue.enqueue('turn', {
      label: `capture:${event.kind}`,
      scope: `capture:${event.kind}`,
      idempotencyKey,
      run: async () => {
        // A replayed delivery still gets its original result, e.g. a confirmation token.
        const cached = this.cachedResult(idempotencyKey);
        if (cached.found) {
          return { result: cached.result as RecordFactResult | void, changed: [] };
        }
        const routed = await this.route(event);
        if (this.deps.tier1Rederive && routed.changed.length > 0) {
          try {
            await this.deps.tier1Rederive.rederive(routed.changed);
          } catch (e) {
            console.warn(`[capture] Tier-1 fact-mirror derivation failed (recall reads the ledger; next write repairs): ${summarizeErrorForLog(e)}`);
          }
        }
        this.markCommitted(idempotencyKey, routed.result);
        return routed;
      },
    });
    // Outside the lock: embedding latency must never wedge the queue.
    if (this.deps.rederive && outcome.changed.length > 0) {
      try {
        await this.deps.rederive.rederive(outcome.changed);
      } catch (e) {
        console.warn(`[capture] rederive failed (mirror/index may lag until next write or boot): ${summarizeErrorForLog(e)}`);
      }
    }
    return outcome.result;
  }

  private idempotencyKeyFor(event: CaptureEventInput): string {
    const supplied = event.idempotencyKey;
    if (typeof supplied === 'string' && supplied.length > 0) return supplied;
    const existing = this.eventKeys.get(event);
    if (existing) return existing;
    const generated = randomUUID();
    this.eventKeys.set(event, generated);
    return generated;
  }

  private cachedResult(key: string): { found: boolean; result?: RecordFactResult | void } {
    if (!this.deps.idempotency) return { found: false };
    try {
      const lookup = this.deps.idempotency.getCommittedResult(key);
      return lookup.found ? { found: true, result: lookup.result as RecordFactResult | void } : { found: false };
    } catch (e) {
      console.warn(`[capture] idempotency read failed; source operation continues: ${summarizeErrorForLog(e)}`);
      return { found: false };
    }
  }

  private markCommitted(key: string, result: RecordFactResult | void): void {
    if (!this.deps.idempotency) return;
    try {
      this.deps.idempotency.markCommitted(key, result);
    } catch (e) {
      // The lanes already committed; a marker outage must not reject the health-data write.
      console.warn(`[capture] idempotency commit failed; source operation succeeded: ${summarizeErrorForLog(e)}`);
    }
  }

  private async route(event: CaptureEvent): Promise<RouteOutcome> {
    // Defense in depth: no credential may reach any lane.
    const cred = contentContainsCredentials(JSON.stringify(event.payload));
    if (cred.matched) {
      console.warn(`[capture] event skipped: content matches credential pattern (${cred.pattern})`);
      return { result: undefined, changed: [] };
    }
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
        // An untyped source can deliver an unknown kind; warn, never throw.
        console.warn(`[capture] ignoring unknown event kind: ${String((event as { kind?: unknown }).kind)}`);
        return { result: undefined, changed: [] };
      }
    }
  }

  private ledgerPath(type: FactType): string {
    return `ledger/${TYPE_TO_FILE[type]}`;
  }

  private narrativePath(day: string): string {
    return `memory/${day}.md`;
  }

  private async ingestLedgerFact(p: LedgerFactInput): Promise<RouteOutcome> {
    const day = this.dayOf(p.provenance.capturedAt);
    // Narrative first, so the structured fact can anchor back to it.
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
    // `applied` and `disputed` both write the ledger file; `needs-confirmation` writes nothing.
    const changed: string[] = [this.narrativePath(day)];
    if (result.kind === 'applied') {
      await this.deps.narrative.appendLedgerAnchor(day, p.entity, result.fact.id);
      changed.push(this.ledgerPath(result.fact.type));
      if (result.fact.safetyRelevant) await this.reRenderSafety();
      await this.emitEvent(result.fact);
    } else if (result.kind === 'disputed' && !result.reopened) {
      changed.push(this.ledgerPath(p.type));
      await this.enqueueDisputeCuriosity(result, p.provenance.capturedAt);
    }
    return { result, changed };
  }

  /** A dispute mints a follow-up item so the conflict resurfaces; best-effort. */
  private async enqueueDisputeCuriosity(
    result: Extract<RecordFactResult, { kind: 'disputed' }>,
    capturedAt?: string,
  ): Promise<void> {
    const writer = this.deps.curiosity;
    if (!writer) return;
    const head = result.versions[0];
    try {
      const base = capturedAt && !Number.isNaN(new Date(capturedAt).getTime())
        ? new Date(capturedAt)
        : this.clock.now();
      await writer.add({
        kind: 'follow-up',
        description: `Unresolved conflict about "${sanitizeSingleLine(head.entity)}" — ask the user which value is correct.`,
        critical: head.type === 'medication' || head.type === 'allergy',
        relatedEntity: head.entity,
        dueAt: new Date(base.getTime() + 7 * 24 * 3600 * 1000).toISOString(),
      });
    } catch (e) {
      console.warn(`[capture] dispute curiosity enqueue failed: ${summarizeErrorForLog(e)}`);
    }
  }

  private async ingestNarrativeNote(p: NarrativeNoteInput): Promise<RouteOutcome> {
    const { date } = await this.deps.narrative.append({ text: p.text, language: p.language, verbatim: p.verbatim, date: p.date });
    return { result: undefined, changed: [this.narrativePath(date)] };
  }

  private async ingestMetricPoint(p: MetricPointInput): Promise<RouteOutcome> {
    const day = this.dayOf(p.provenance.capturedAt);
    const { anchor } = await this.deps.narrative.append({
      text: p.note ?? `${p.entity} reading`,
      language: p.language,
      date: day,
    });
    const result = await this.deps.ledger.recordFact({
      entity: p.entity,
      type: 'metric',
      // A metric fact always carries its day-granularity date as a field.
      fields: { ...p.fields, date: p.date },
      provenance: { ...p.provenance, anchor },
      safetyRelevant: p.safetyRelevant,
      language: p.language,
    });
    const changed: string[] = [this.narrativePath(day)];
    if (result.kind === 'applied') {
      await this.deps.narrative.appendLedgerAnchor(day, p.entity, result.fact.id);
      changed.push(this.ledgerPath(result.fact.type));
      if (result.fact.safetyRelevant) await this.reRenderSafety();
      await this.emitEvent(result.fact);
    } else if (result.kind === 'disputed') {
      changed.push(this.ledgerPath('metric'));
    }
    return { result, changed };
  }

  private async ingestCuriosity(p: Omit<CuriosityItem, 'id' | 'profileId' | 'createdAt'>): Promise<RouteOutcome> {
    const writer = this.deps.curiosity;
    if (!writer) {
      console.warn('[capture] curiosity-item dropped: no curiosity writer configured');
      return { result: undefined, changed: [] };
    }
    await writer.add(p);
    // curiosity.md is not a recall lane, so nothing to mirror or reindex.
    return { result: undefined, changed: [] };
  }

  private async ingestCorrection(p: LedgerCorrectionInput): Promise<RouteOutcome> {
    const day = this.dayOf(p.corrected.provenance.capturedAt);
    const { anchor } = await this.deps.narrative.append({ text: p.note, date: day });
    const changed: string[] = [this.narrativePath(day)];

    // Corrected fact first, then retract the mistaken one, all in this queue op.
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
    let pendingRetract: ConfirmationToken | undefined;
    if (corrected.kind === 'applied') {
      await this.deps.narrative.appendLedgerAnchor(day, p.corrected.entity, corrected.fact.id);
      changed.push(this.ledgerPath(corrected.fact.type));
      safetyTouched = corrected.fact.safetyRelevant;
      await this.emitEvent(corrected.fact);
    } else if (corrected.kind === 'disputed') {
      changed.push(this.ledgerPath(p.corrected.type));
    }

    const retract = await this.deps.ledger.retract({
      entity: p.wrong.entity,
      type: p.wrong.type,
      provenance: p.corrected.provenance,
    });
    if (retract.kind === 'applied') {
      safetyTouched = safetyTouched || retract.fact.safetyRelevant;
      changed.push(this.ledgerPath(p.wrong.type));
    } else if (retract.kind === 'needs-confirmation') {
      // The mistaken safety fact stays active until confirmed; PHI: never log the entity name.
      console.warn('[capture] correction retract needs confirmation; corrected fact recorded, mistaken fact retained pending confirmation');
      pendingRetract = retract.token;
    }

    if (safetyTouched) await this.reRenderSafety();
    // The retract token must ride every corrected-arm outcome, or the mistaken fact can never be confirmed.
    const result = pendingRetract
      ? ({ ...corrected, pendingRetract } as RecordFactResult)
      : corrected;
    return { result, changed };
  }
  private async reRenderSafety(): Promise<void> {
    await refreshSafetyView(this.deps.safety);
  }

  /** Best-effort; never throws. */
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

  // Both lanes use the event's capturedAt; the store clock is only a fallback.
  private dayOf(iso?: string): string {
    const parsed = iso ? new Date(iso) : this.clock.now();
    const valid = Number.isNaN(parsed.getTime()) ? this.clock.now() : parsed;
    return valid.toISOString().slice(0, 10);
  }
}
