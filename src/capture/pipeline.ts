// src/capture/pipeline.ts
//
// CapturePipeline — the turn-level CaptureEvent router. Given a normalized event, it writes BOTH
// memory lanes (structured ledger + lossless narrative) with cross-anchors and re-renders SAFETY.md
// on safety-relevant facts, all inside one IO-only op on the write queue.
//
// Every dependency is a typed in-module interface (no concrete memcore imports beyond types); the
// gateway injects the concrete stores, which satisfy these ports structurally.

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

/** The single-writer queue seam. Ops MUST be IO-only. */
export interface QueuePort {
  enqueue<T>(priority: 'turn' | 'background', op: {
    label: string;
    scope?: string;
    idempotencyKey?: string;
    run(): Promise<T>;
  }): Promise<T>;
}

export type CaptureEventInput = CaptureEvent & { idempotencyKey?: string };

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

/** The SAFETY.md view. `listSafetyRelevant` sources the full current set to re-render from. */
export interface SafetyRenderer {
  render(safetyRelevantFacts: LedgerFact[]): Promise<string>;
  listSafetyRelevant(): Promise<LedgerFact[]>;
  /** Persist a PHI-free fail-closed signal when publication cannot complete. */
  markDirty?(): void;
}

/** The durable follow-up queue. Mirrors CuriosityQueue.add. */
export interface CuriosityWriter {
  add(item: Omit<CuriosityItem, 'id' | 'profileId' | 'createdAt'>): Promise<CuriosityItem>;
}

/**
 * Post-write re-derivation seam. Given the workspace-relative paths a capture op just wrote, it
 * re-derives a projection. Two instances are injected at different tiers:
 *   - `tier1Rederive`: SYNCHRONOUS, INSIDE the write lock (local-only: SQLite FactMirror writes, no
 *     network or LLM). It runs before the op returns, so a read right after the write sees a
 *     consistent mirror. A failure warns and continues; recall reads current facts from the ledger.
 *   - `rederive` (tier 2): ASYNC, OUTSIDE the write lock, because embeddings must never run inside
 *     the single-writer lock. It reindexes chunks for search. A lag degrades to keyword-only recall.
 * Both are best-effort: a failure never fails the capture itself.
 */
export interface Rederiver {
  rederive(relPaths: string[]): Promise<void>;
}

/**
 * Re-render SAFETY.md after a ledger write. The write has already landed, so a failed render is
 * not a write failure: the view is marked dirty, and the next read repairs it from the ledger or
 * fails closed. Reporting the write as failed would only make the model retry into a duplicate.
 */
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
  /** Tier-1 (sync, IN the write lock). See {@link Rederiver}. Must never itself enqueue; the
   *  coordinator's re-entrancy guard rejects that rather than deadlocking. */
  tier1Rederive?: Rederiver;
  /** Tier-2 (async, OFF the write lock). See {@link Rederiver}. */
  rederive?: Rederiver;
  idempotency?: CaptureIdempotency;
}

/** Internal route outcome: the caller-facing result + the workspace paths the op mutated. */
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

  /**
   * Route one capture event. The whole per-event work runs inside ONE turn-priority
   * queue op so both lanes and the SAFETY re-render land atomically relative to other
   * writes. Returns the ledger result for fact-bearing kinds (so the tool layer can relay
   * a needs-confirmation / disputed question); void for narrative-only kinds.
   */
  async ingest(event: CaptureEventInput): Promise<RecordFactResult | void> {
    const idempotencyKey = this.idempotencyKeyFor(event);
    const outcome = await this.deps.queue.enqueue('turn', {
      label: `capture:${event.kind}`,
      scope: `capture:${event.kind}`,
      idempotencyKey,
      run: async () => {
        // A matched-committed key returns the cached original result, so a replayed delivery still
        // gives callers like `ledger_record` their `RecordFactResult` (e.g. a confirmation token).
        const cached = this.cachedResult(idempotencyKey);
        if (cached.found) {
          return { result: cached.result as RecordFactResult | void, changed: [] };
        }
        const routed = await this.route(event);
        // Tier-1 (in-lock, sync, local-only): derive the FactMirror before this op returns, so the
        // write and its projection land atomically relative to any read.
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
    // Tier-2 runs OUTSIDE the single-writer queue op so embedding latency never wedges the queue.
    // Best-effort (chunks are rebuildable). Skipped on an idempotent replay, where `changed` is empty.
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
      // The source lanes have already committed. A marker outage is a durable-recovery degradation,
      // never a reason to reject the health-data write or the caller's turn.
      console.warn(`[capture] idempotency commit failed; source operation succeeded: ${summarizeErrorForLog(e)}`);
    }
  }

  private async route(event: CaptureEvent): Promise<RouteOutcome> {
    // Defense in depth: every capture payload passes the credential check before ANY lane is
    // touched. Tool paths surface a clean rejection at the tool boundary; non-tool sources (per-turn
    // chat capture) warn with a sanitized message and skip, never persisting a credential.
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
        // Defensive: an untyped source could deliver an unknown kind. Warn, never throw.
        console.warn(`[capture] ignoring unknown event kind: ${String((event as { kind?: unknown }).kind)}`);
        return { result: undefined, changed: [] };
      }
    }
  }

  /** Workspace-relative path of the ledger file for a fact type. */
  private ledgerPath(type: FactType): string {
    return `ledger/${TYPE_TO_FILE[type]}`;
  }

  /** Workspace-relative path of a narrative day log. */
  private narrativePath(day: string): string {
    return `memory/${day}.md`;
  }

  // ---- kinds -------------------------------------------------------------

  private async ingestLedgerFact(p: LedgerFactInput): Promise<RouteOutcome> {
    const day = this.dayOf(p.provenance.capturedAt);
    // Lossless narrative first, so the structured fact can anchor back to it.
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
    // The narrative note always lands, so its day file changed. `applied` and `disputed` both write
    // the ledger file (a dispute flips the prior active fact to disputed), so both must re-derive the
    // recall mirror or recall keeps injecting the pre-dispute fact as active. `needs-confirmation`
    // writes nothing (it only mints a token).
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

  /**
   * A minted dispute creates a durable follow-up item (re-ask in ~7 days) so the conflict
   * resurfaces until resolved. Critical iff the disputed fact is a medication or allergy.
   * Best-effort: a curiosity failure never fails the capture.
   */
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
      // A disputed metric mint also wrote the ledger file, so re-derive the mirror.
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
    // curiosity.md is not a recall lane — nothing to mirror or reindex.
    return { result: undefined, changed: [] };
  }

  private async ingestCorrection(p: LedgerCorrectionInput): Promise<RouteOutcome> {
    const day = this.dayOf(p.corrected.provenance.capturedAt);
    const { anchor } = await this.deps.narrative.append({ text: p.note, date: day });
    const changed: string[] = [this.narrativePath(day)];

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
    let pendingRetract: ConfirmationToken | undefined;
    if (corrected.kind === 'applied') {
      await this.deps.narrative.appendLedgerAnchor(day, p.corrected.entity, corrected.fact.id);
      changed.push(this.ledgerPath(corrected.fact.type));
      safetyTouched = corrected.fact.safetyRelevant;
      await this.emitEvent(corrected.fact);
    } else if (corrected.kind === 'disputed') {
      // A disputed corrected-fact mint also wrote the ledger file, so re-derive the mirror.
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
      // The mistaken fact is safety-relevant, so it stays active pending user confirmation while the
      // corrected fact is already recorded. The token goes on the result so the tool layer can ask.
      // PHI: never interpolate the entity name into logs.
      console.warn('[capture] correction retract needs confirmation; corrected fact recorded, mistaken fact retained pending confirmation');
      pendingRetract = retract.token;
    }

    if (safetyTouched) await this.reRenderSafety();
    // The retract token rides the result on EVERY corrected-arm outcome; dropping it when the
    // corrected fact itself went pending would lose the only confirmation path for the mistaken fact.
    const result = pendingRetract
      ? ({ ...corrected, pendingRetract } as RecordFactResult)
      : corrected;
    return { result, changed };
  }
  // ---- helpers -----------------------------------------------------------

  /** Re-render SAFETY.md from the current safety-relevant set. */
  private async reRenderSafety(): Promise<void> {
    await refreshSafetyView(this.deps.safety);
  }

  /** Best-effort event mirror (no-op when no sink is injected). Never throws. */
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
   * Both lanes agree on the same day, derived from the event's capturedAt rather than a divergent
   * store clock. The injected clock is only a fallback for a missing or invalid capturedAt.
   */
  private dayOf(iso?: string): string {
    const parsed = iso ? new Date(iso) : this.clock.now();
    const valid = Number.isNaN(parsed.getTime()) ? this.clock.now() : parsed;
    return valid.toISOString().slice(0, 10);
  }
}
