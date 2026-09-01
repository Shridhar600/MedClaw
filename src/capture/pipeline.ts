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
  /** Persist a PHI-free fail-closed signal when publication cannot complete. */
  markDirty?(): void;
}

/** The durable follow-up queue (consumed P4). Mirrors CuriosityQueue.add. */
export interface CuriosityWriter {
  add(item: Omit<CuriosityItem, 'id' | 'profileId' | 'createdAt'>): Promise<CuriosityItem>;
}

/**
 * Post-write re-derivation seam (P2 A1.4/A2.4). Given the workspace-relative paths a capture
 * op just wrote (ledger files + narrative day files), re-derive the SQLite mirror + reindex the
 * changed chunks. Called OUT of the write-queue op (embeddings run off the single-writer lock —
 * B2). Concrete injected by Gateway. Best-effort: a failure never fails the capture.
 */
export interface Rederiver {
  rederive(relPaths: string[]): Promise<void>;
}

export interface CapturePipelineDeps {
  queue: QueuePort;
  ledger: LedgerWriter;
  narrative: NarrativeWriter;
  safety: SafetyRenderer;
  curiosity?: CuriosityWriter;
  events?: EventSink;
  clock?: Clock;
  rederive?: Rederiver;
}

/** Internal route outcome: the caller-facing result + the workspace paths the op mutated. */
interface RouteOutcome {
  result: RecordFactResult | void;
  changed: string[];
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
    const outcome = await this.deps.queue.enqueue('turn', {
      label: `capture:${event.kind}`,
      run: () => this.route(event),
    });
    // Out-of-op (B2): re-derive the mirror + reindex chunks for the changed files. This runs
    // OUTSIDE the single-writer queue op so embedding latency never wedges the queue. Best-effort
    // — a re-derive failure never fails the capture (the mirror is rebuildable + A4-healed).
    if (this.deps.rederive && outcome.changed.length > 0) {
      try {
        await this.deps.rederive.rederive(outcome.changed);
      } catch (e) {
        console.warn(`[capture] rederive failed (mirror/index may lag until next write or boot): ${summarizeErrorForLog(e)}`);
      }
    }
    return outcome.result;
  }

  private async route(event: CaptureEvent): Promise<RouteOutcome> {
    // CRED (SB-6) defense-in-depth: every capture payload passes the credential
    // bar before ANY lane is touched. Tool paths surface a clean rejection at
    // the tool boundary; non-tool sources (per-turn chat capture) degrade to a
    // sanitized warn + skip — never a crash, never a persisted credential.
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
    // The narrative note always lands → its day file changed. `applied` AND `disputed` both WRITE the
    // ledger file (a dispute mint flips the prior active to disputed + appends both heads), so both must
    // re-derive the recall mirror — otherwise Stage-1 keeps injecting the pre-dispute fact as ACTIVE
    // (H-1 / CONTRA-09 class). `needs-confirmation` writes nothing (only mints a token).
    const changed: string[] = [this.narrativePath(day)];
    if (result.kind === 'applied') {
      await this.deps.narrative.appendLedgerAnchor(day, p.entity, result.fact.id);
      changed.push(this.ledgerPath(result.fact.type));
      if (result.fact.safetyRelevant) await this.reRenderSafety();
      await this.emitEvent(result.fact);
    } else if (result.kind === 'disputed') {
      changed.push(this.ledgerPath(p.type));
      await this.enqueueDisputeCuriosity(result, p.provenance.capturedAt);
    }
    return { result, changed };
  }

  /**
   * A1: a minted dispute creates a durable follow-up item (re-ask ~7d) so the
   * conflict resurfaces until resolved. Critical iff the disputed fact is a
   * med/allergy. Best-effort — a curiosity failure never fails the capture.
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
      // F19 / DIAB-02: a metric fact always carries its day-granularity date as a field.
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
      // H-1: a disputed metric mint also wrote the ledger file → re-derive the mirror.
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
      // H-1: a disputed corrected-fact mint also wrote the ledger file → re-derive the mirror.
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
      // CT (SB-2): the mistaken fact is safety-relevant; it stays active pending
      // user confirmation while the corrected fact is already recorded. Surface
      // the token on the result so the tool layer can ask the user (DAD-10).
      // PHI: never interpolate the entity name into logs.
      console.warn('[capture] correction retract needs confirmation; corrected fact recorded, mistaken fact retained pending confirmation');
      pendingRetract = retract.token;
    }

    if (safetyTouched) await this.reRenderSafety();
    // CT: the retract token rides the result on EVERY corrected-arm outcome —
    // dropping it whenever the corrected fact itself went pending lost the only
    // confirmation path for the mistaken safety-relevant fact.
    const result = pendingRetract
      ? ({ ...corrected, pendingRetract } as RecordFactResult)
      : corrected;
    return { result, changed };
  }
  // ---- helpers -----------------------------------------------------------

  /** Re-render SAFETY.md from the current safety-relevant set (D8). */
  private async reRenderSafety(): Promise<void> {
    try {
      const facts = await this.deps.safety.listSafetyRelevant();
      await this.deps.safety.render(facts);
    } catch (e) {
      try {
        this.deps.safety.markDirty?.();
      } catch (markError) {
        console.warn('[capture] SAFETY dirty marker failed:', summarizeErrorForLog(markError));
      }
      throw e;
    }
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
