// src/recall/engine.ts
//
// RecallEngine — the per-turn automatic recall pipeline (P2 Wave B, specs/07 §6 + specs/13 B-series).
// Ports-only (no memcore/legacy imports — arch:check enforces). READ-only except Stage-4 chunk_stats
// (P2-D4). Stages:
//   1 ledger    — active clinical facts + paused facts carrying a pre_pause_summary (KNEE-08)
//   2 narrative — hybrid vec∪keyword, scored (scoreChunk), thresholded on `raw`, suppressed by
//                 ledger head status (CONTRA-10 / KNEE-10), top-K within budget (CHAT-08)
//   3 entity    — deterministic side-effect correlation against active meds (DIAB-05), CHECK: lines
//   4 feedback  — chunk_stats bump + <used> tag (Task B3)
// Every embed call is wrapped in a timeout (v2-BL-2) → keyword-only degrade.

import type { EmbeddingPort } from '../ports/embedding-port';
import type { VectorIndex } from '../ports/vector-index';
import type { KeywordIndex } from '../ports/keyword-index';
import type { FactMirror, FactRecord } from '../ports/fact-mirror';
import type { ChunkStatsWriter } from '../ports/chunk-stats';
import type { Clock } from '../ports/clock';
import { summarizeErrorForLog } from '../security';
import { scoreChunk } from './scoring';

export interface RecallConfig {
  topKNarrative: number;
  topKKeyword: number;
  narrativeBudget: number;
  ledgerBudget: number;
  halfLifeDays: number;
  scoreThreshold: number;
  safetyThreshold: number;
  embedTimeoutMs: number;
  overfetchFactor: number;
  finalTopK: number;
  preDecayFloor: number;
  healthLaneBoost: number;
  /**
   * The "health" lanes — triple-duty (kept as one set because all three uses are the
   * ledger|episode health surface; split into separate keys if Wave E needs to tune them apart):
   *   (1) safety-threshold gate: safety_relevant && lane∈healthLanes → 0.3 threshold (B5);
   *   (2) CHAT-07 post-threshold content-type boost;
   *   (3) B4 auto-mute exemption (ledger|episode never muted).
   */
  healthLanes: string[];
  /** Lanes carrying versioned ledger-fact statements — newer-active suppression is scoped here (F2). */
  ledgerLanes: string[];
  ledgerTypes: string[];
  autoMuteInjectedThreshold: number;
  /** Stage-3 side-effect correlation only considers meds started within this window (specs/07 §6). */
  recentMedDays: number;
}

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  topKNarrative: 24,
  topKKeyword: 24,
  narrativeBudget: 2000,
  ledgerBudget: 600,
  halfLifeDays: 120, // v2-BL-1b (45 falsifies KNEE-06)
  scoreThreshold: 0.5,
  safetyThreshold: 0.3,
  embedTimeoutMs: 500, // v2-BL-2
  overfetchFactor: 3,
  finalTopK: 3,
  preDecayFloor: 0.15, // specs/13 B6 (safety_relevant chunks are exempt — see stage2)
  healthLaneBoost: 1.5, // CHAT-07 content-type bias (post-threshold, H-4)
  healthLanes: ['ledger', 'episode'], // safety-threshold lanes (B5) + CHAT-07 boost + B4 mute-exempt
  ledgerLanes: ['ledger'], // newer-active version suppression is scoped to ledger-fact chunks (F2)
  ledgerTypes: ['medication', 'condition', 'symptom', 'appointment', 'metric', 'goal', 'allergy'],
  autoMuteInjectedThreshold: 20, // specs/13 B7 (never applied to safety_relevant / ledger|episode, B4)
  recentMedDays: 90, // specs/07 §6 Stage 3 "active + recent(90d) meds"
};

export interface RecallDeps {
  embedding: EmbeddingPort;
  vectorIndex: VectorIndex;
  keywordIndex: KeywordIndex;
  factMirror: FactMirror;
  chunkStats: ChunkStatsWriter;
  clock: Clock;
  config: RecallConfig;
}

export interface RecallInput {
  profileId: string;
  userMessage: string;
}

export type IndexStatus = 'full' | 'keyword-only' | 'failed';

export interface RecallHit {
  id: string;
  raw: number;
  ranking: number;
  lane: string;
  content: string;
  safetyRelevant: boolean;
}

export interface RecallReport {
  ledger: string;
  ledgerTokens: number;
  /** True when the Stage-1 budget dropped one or more active facts (safety rows are prioritized). */
  ledgerTruncated: boolean;
  narrative: string;
  narrativeTokens: number;
  hits: RecallHit[];
  injectedChunkIds: string[];
  indexStatus: IndexStatus;
  /** Stage-3 deterministic correlation output — `CHECK:` lines (was `entity`, F13 rename). */
  checkNotes: string;
}

interface Stage2Result {
  text: string;
  tokens: number;
  hits: RecallHit[];
  injectedChunkIds: string[];
  indexStatus: IndexStatus;
}

// Mirror of src/memcore AUTHORITY_RANK (kept local — the engine is ports-only, cannot import the
// memcore value). Keep in sync with src/memcore/types.ts if the ladder changes.
const AUTHORITY_RANK: Record<string, number> = {
  doctor: 5, lab: 5, report: 4, sensor: 3, user: 2, inference: 1,
};

// A stale/disputed head status → any chunk for that entity is stale and fail-closed dropped (KNEE-10).
const STALE_STATUSES = new Set(['retracted', 'discontinued', 'superseded', 'disputed']);
const MS_PER_DAY = 86_400_000;

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function fmtFieldValue(v: string | number | string[]): string {
  return Array.isArray(v) ? v.join('; ') : String(v);
}

function toWordSet(s: string): Set<string> {
  // Singularize so plural/inflected mentions still match entity words (F4 — "UTIs" → "uti").
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular));
}

/** Heads whose entity words all appear in the chunk content (deterministic, morphology-tolerant). */
function matchEntities(content: string, heads: FactRecord[]): FactRecord[] {
  const words = toWordSet(content);
  return heads.filter(h => {
    const ew = h.entity.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular);
    return ew.length > 0 && ew.every(w => words.has(w));
  });
}

/**
 * True when `content` mentions an entity whose CURRENT HEAD is terminal
 * (retracted/discontinued/superseded). This is the DRY form of the Stage-2 stale-drop
 * ({@link RecallEngine.isSuppressed}), exported so `memory_search`'s `status:active` filter
 * applies the identical rule (E1.1 / CONTRA-06/08). `heads` = `factMirror.queryEntityHeads()`.
 */
export function chunkHasStaleEntity(content: string, heads: FactRecord[]): boolean {
  return matchEntities(content, heads).some(h => STALE_STATUSES.has(h.status));
}

// Stage-1 ledger fill priority when the budget is tight (F3): safety rows first, then a clinical
// ordering, so a critical allergy is never silently evicted by rowid-arbitrary order.
const LEDGER_TYPE_PRIORITY: Record<string, number> = {
  allergy: 0, medication: 1, condition: 2, symptom: 3, appointment: 4, metric: 5, goal: 6,
};
function ledgerRank(f: FactRecord): number {
  const typeRank = LEDGER_TYPE_PRIORITY[f.type] ?? 7;
  return (f.safetyRelevant ? 0 : 100) + typeRank; // safety_relevant always outranks non-safety
}

interface Candidate {
  id: string;
  lane: string;
  content: string;
  createdAt: string;
  cosine: number;
  bm25n: number;
}

/** Naive singularization for deterministic symptom matching ("infections" → "infection"). */
function singular(w: string): string {
  return w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
}

function normalizeMessageWords(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular));
}

/**
 * Deterministic side-effect ↔ symptom match (DIAB-05): the side effect's HEAD word plus at least
 * one qualifier word must appear in the message (single-word effects match on the head alone). This
 * matches "genital-yeast-infection" to "yeast infections" without matching "uti"/"dehydration".
 */
function sideEffectMatches(sideEffect: string, msgWords: Set<string>): boolean {
  const words = sideEffect.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singular);
  if (words.length === 0) return false;
  const head = words[words.length - 1];
  if (!msgWords.has(head)) return false;
  if (words.length === 1) return true;
  return words.slice(0, -1).some(w => msgWords.has(w));
}

function renderCheck(entity: string, started: string, sideEffect: string, now: Date): string {
  const seHuman = sideEffect.replace(/-/g, ' ');
  let windowClause = 'unknown';
  if (started) {
    const t = new Date(started).getTime();
    if (!Number.isNaN(t)) {
      const weeks = Math.round(Math.max(0, (now.getTime() - t) / MS_PER_DAY) / 7);
      windowClause = weeks < 1 ? 'under 1 week' : `~${weeks} weeks`;
    }
  }
  const startedClause = started ? ` (started ${started})` : '';
  return `CHECK: ${entity}${startedClause} lists ${seHuman} as a known side effect. `
    + `Temporal correlation window: ${windowClause}. No diagnostic certainty.`;
}

export class RecallEngine {
  constructor(private deps: RecallDeps) {}

  async run(input: RecallInput, opts?: { narrative?: boolean }): Promise<RecallReport> {
    // narrative:false (heartbeat/dream/subagent — modes that render no narrative hits) runs Stage-1
    // ledger only: no embed, no Stage-2/3, no bumpInjected. This avoids poisoning B4 auto-mute with
    // injected_count bumps for chunks that were never shown, and skips the embed budget (M-1).
    const includeNarrative = opts?.narrative ?? true;
    const stage1 = await this.stage1Ledger();
    const stage2: Stage2Result = includeNarrative
      ? await this.stage2Narrative(input)
      : { text: '', tokens: 0, hits: [], injectedChunkIds: [], indexStatus: 'full' };
    const stage3 = includeNarrative ? await this.stage3Entity(input) : '';
    // Stage 4a: record that these chunks were injected (used_count bumped later via recordUsage
    // when the model reports the <used> tag). Mirror-connection bookkeeping — never blocks the turn.
    if (stage2.injectedChunkIds.length > 0) {
      try {
        await this.deps.chunkStats.bumpInjected(stage2.injectedChunkIds);
      } catch (e) {
        console.warn('[recall] bumpInjected failed:', summarizeErrorForLog(e));
      }
    }
    return {
      ledger: stage1.text,
      ledgerTokens: stage1.tokens,
      ledgerTruncated: stage1.truncated,
      narrative: stage2.text,
      narrativeTokens: stage2.tokens,
      hits: stage2.hits,
      injectedChunkIds: stage2.injectedChunkIds,
      indexStatus: stage2.indexStatus,
      checkNotes: stage3,
    };
  }

  /**
   * Stage 4b — record that the model used these recall chunks this turn (from the stripped B7
   * `<used>` tag; the AgentLoop parses it via {@link parseUsedTag}). Best-effort; never throws.
   */
  async recordUsage(chunkIds: string[], at: string): Promise<void> {
    if (chunkIds.length === 0) return;
    try {
      await this.deps.chunkStats.bumpUsed(chunkIds, at);
    } catch (e) {
      console.warn('[recall] recordUsage failed:', summarizeErrorForLog(e));
    }
  }

  // ---- Stage 1: active ledger + paused-with-summary --------------------------------------

  private async stage1Ledger(): Promise<{ text: string; tokens: number; truncated: boolean }> {
    const { factMirror, config } = this.deps;
    try {
      const byEntity = new Map<string, FactRecord[]>();
      for await (const f of factMirror.queryActive()) {
        if (!config.ledgerTypes.includes(f.type)) continue;
        const key = `${f.type}::${f.entity}`;
        const group = byEntity.get(key);
        if (group) group.push(f); else byEntity.set(key, [f]);
      }
      // Priority order so a tight budget never silently evicts a safety row (F3): safety/allergy
      // first, then the clinical ordering, stable tiebreak by entity.
      const activeGroups = [...byEntity.values()].sort((a, b) =>
        ledgerRank(a[0]) - ledgerRank(b[0]) || a[0].entity.localeCompare(b[0].entity));
      const lines: string[] = activeGroups.map((group) => {
        if (group.length === 1) return RecallEngine.renderActive(group[0]);
        const values = [...group]
          .sort((a, b) => a.version - b.version)
          .map((f) => `v${f.version}: ${RecallEngine.renderActive(f).replace(/^- /, '')}`)
          .join(' | ');
        return `- CONFLICT: multiple active ${group[0].type} records for ${group[0].entity} — ${values}`;
      });
      // Paused facts that carry a pre_pause_summary (KNEE-08) — skip entities that already have an
      // active head (active wins; no double-render, F15).
      for await (const f of factMirror.queryPaused()) {
        if (!config.ledgerTypes.includes(f.type)) continue;
        if (byEntity.has(`${f.type}::${f.entity}`)) continue;
        const summary = f.fields['pre_pause_summary'];
        if (summary === undefined) continue;
        lines.push(`- ${f.entity} (${f.type}) paused — ${fmtFieldValue(summary)}`);
      }
      return RecallEngine.fitLines(lines, config.ledgerBudget);
    } catch (e) {
      console.warn('[recall] stage1 ledger failed:', summarizeErrorForLog(e));
      return { text: '', tokens: 0, truncated: false };
    }
  }

  private static renderActive(f: FactRecord): string {
    const fields = Object.entries(f.fields)
      .filter(([k]) => k !== 'pre_pause_summary')
      .map(([k, v]) => `${k}: ${fmtFieldValue(v)}`)
      .join(', ');
    return `- ${f.entity} (${f.type}) ${f.status}${fields ? ` — ${fields}` : ''}`;
  }

  private static fitLines(lines: string[], budgetTokens: number): { text: string; tokens: number; truncated: boolean } {
    const kept: string[] = [];
    let truncated = false;
    for (const line of lines) {
      const candidate = [...kept, line].join('\n');
      if (estimateTokens(candidate) > budgetTokens) { truncated = true; break; }
      kept.push(line);
    }
    const text = kept.join('\n');
    return { text, tokens: estimateTokens(text), truncated };
  }

  // ---- Stage 2: hybrid narrative recall --------------------------------------------------

  private async stage2Narrative(input: RecallInput): Promise<Stage2Result> {
    const { config, clock } = this.deps;
    try {
      const { candidates, indexStatus } = await this.gatherCandidates(input.userMessage);
      if (candidates.size === 0) {
        return { text: '', tokens: 0, hits: [], injectedChunkIds: [], indexStatus };
      }
      const headRead = await this.loadEntityHeads();
      if (!headRead.available) {
        // Head status is the safety filter. An unavailable mirror is not an empty mirror:
        // suppress every candidate rather than allowing stale clinical narrative through.
        return { text: '', tokens: 0, hits: [], injectedChunkIds: [], indexStatus: 'failed' };
      }
      const heads = headRead.heads;
      const now = clock.now();

      const scored: RecallHit[] = [];
      for (const c of candidates.values()) {
        const matched = matchEntities(c.content, heads);
        if (RecallEngine.isSuppressed(matched, c, config)) continue;

        const safetyRelevant = matched.some(m => m.safetyRelevant);

        // On keyword-only degrade there is no cosine, so the keyword score stands in for the
        // semantic signal (full weight on the only signal we have) — otherwise a bm25-only chunk
        // caps at raw 0.3 and can never clear the 0.5 threshold, and degrade would return nothing.
        const effectiveCosine = indexStatus === 'keyword-only' ? c.bm25n : c.cosine;
        const base = 0.7 * effectiveCosine + 0.3 * c.bm25n;
        // B6 pre-decay floor — safety_relevant chunks are EXEMPT (specs/13 B6 "OR safety_relevant",
        // v2-BL-1b: safety facts must stay surface-able). The floor must not run before this carve-out.
        if (!safetyRelevant && base < config.preDecayFloor) continue;

        const inHealthLane = config.healthLanes.includes(c.lane);

        // B4 auto-mute: a chunk injected ≫ used is noise — drop it, EXCEPT safety_relevant chunks
        // or ledger|episode lanes, which are NEVER muted (specs/13 B4 / v2-H-1). The stat read is
        // best-effort: a corrupt stats row must degrade to no-mute, never sink the turn (F8).
        if (!safetyRelevant && !inHealthLane) {
          let stat = null;
          try {
            stat = await this.deps.chunkStats.get(c.id);
          } catch (e) {
            console.warn('[recall] chunkStats read failed (no-mute):', summarizeErrorForLog(e));
          }
          if (stat && stat.injectedCount >= config.autoMuteInjectedThreshold && stat.usedCount === 0) continue;
        }

        const authorityRank = matched.reduce((mx, m) => Math.max(mx, AUTHORITY_RANK[m.authority] ?? 0), 0);
        const ageDays = RecallEngine.ageDays(c.createdAt, now);
        const { raw, ranking } = scoreChunk({
          cosine: effectiveCosine, bm25n: c.bm25n, ageDays,
          halfLifeDays: config.halfLifeDays, authorityRank, safetyRelevant,
        });

        const threshold = safetyRelevant && inHealthLane ? config.safetyThreshold : config.scoreThreshold;
        if (raw < threshold) continue;

        // Content-type bias is a post-threshold ranking multiplier (H-4 — cannot smuggle a
        // sub-threshold chunk in; only reorders survivors so health outranks rants, CHAT-07).
        const boosted = inHealthLane ? ranking * config.healthLaneBoost : ranking;
        scored.push({ id: c.id, raw, ranking: boosted, lane: c.lane, content: c.content, safetyRelevant });
      }

      const deduped = RecallEngine.dedupeByContent(scored);
      deduped.sort((a, b) => b.ranking - a.ranking);
      const top = deduped.slice(0, config.finalTopK);
      const { kept, text, tokens } = RecallEngine.fitHits(top, config.narrativeBudget);
      return { text, tokens, hits: kept, injectedChunkIds: kept.map(h => h.id), indexStatus };
    } catch (e) {
      console.warn('[recall] stage2 narrative failed:', summarizeErrorForLog(e));
      return { text: '', tokens: 0, hits: [], injectedChunkIds: [], indexStatus: 'failed' };
    }
  }

  /**
   * Hybrid gather: embed (timeout-guarded) → vec KNN ∪ keyword match, merged by chunk id. Each arm
   * is isolated (F8b) so one arm's failure never discards the other's candidates. PLAT-11 status:
   * 'failed' only when BOTH arms are down; 'keyword-only' when the vector arm is unavailable.
   */
  private async gatherCandidates(userMessage: string): Promise<{ candidates: Map<string, Candidate>; indexStatus: IndexStatus }> {
    const { config } = this.deps;
    const candidates = new Map<string, Candidate>();

    // --- vector arm: embed (timeout-guarded); empty or failed embedding ⇒ vec unavailable ---
    let embedding: number[] | null = null;
    try {
      const vecs = await this.embedWithTimeout(userMessage);
      const v = vecs[0];
      if (v && v.length > 0) embedding = v;
      else console.warn('[recall] empty embedding → keyword-only (specs/13 B3)'); // F6
    } catch (e) {
      // Embed throw OR 500ms timeout ⇒ keyword-only degrade (PLAT-11, v2-BL-2).
      console.warn('[recall] embed failed → keyword-only:', summarizeErrorForLog(e));
    }

    let vecAvailable = false;
    if (embedding) {
      try {
        const k = config.topKNarrative * config.overfetchFactor;
        for await (const h of this.deps.vectorIndex.queryKnn(embedding, k)) {
          const c = candidates.get(h.id) ?? RecallEngine.emptyCandidate(h);
          c.cosine = Math.max(c.cosine, h.score);
          candidates.set(h.id, c);
        }
        vecAvailable = true;
      } catch (e) {
        console.warn('[recall] vector query failed:', summarizeErrorForLog(e)); // keep the keyword arm
      }
    }

    // --- keyword arm: independent try so a throw here preserves already-gathered vec candidates ---
    let keywordAvailable = false;
    try {
      for await (const h of this.deps.keywordIndex.match(userMessage, config.topKKeyword)) {
        const c = candidates.get(h.id) ?? RecallEngine.emptyCandidate(h);
        c.bm25n = Math.max(c.bm25n, h.score);
        candidates.set(h.id, c);
      }
      keywordAvailable = true;
    } catch (e) {
      console.warn('[recall] keyword query failed:', summarizeErrorForLog(e)); // keep vec candidates
    }

    const indexStatus: IndexStatus = (!vecAvailable && !keywordAvailable) ? 'failed'
      : (!vecAvailable ? 'keyword-only' : 'full');
    return { candidates, indexStatus };
  }

  private async embedWithTimeout(text: string): Promise<number[][]> {
    const { embedTimeoutMs } = this.deps.config;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error('embed timeout')), embedTimeoutMs);
    });
    try {
      return await Promise.race([this.deps.embedding.embed([text]), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async loadEntityHeads(): Promise<{ heads: FactRecord[]; available: boolean }> {
    try {
      const heads: FactRecord[] = [];
      for await (const h of this.deps.factMirror.queryEntityHeads()) heads.push(h);
      return { heads, available: true };
    } catch (e) {
      // No heads is not an empty working mirror. A safety filter that cannot read its source
      // must fail closed for this turn.
      console.warn('[recall] entity-heads load failed:', summarizeErrorForLog(e));
      return { heads: [], available: false };
    }
  }

  private static isSuppressed(matched: FactRecord[], chunk: Candidate, config: RecallConfig): boolean {
    const chunkDay = RecallEngine.dayOf(chunk.createdAt);
    const isLedgerLane = config.ledgerLanes.includes(chunk.lane);
    for (const m of matched) {
      if (STALE_STATUSES.has(m.status)) return true; // stale fail-closed (KNEE-10) — all lanes
      // Newer-active version suppression (CONTRA-10) is scoped to ledger-fact chunks (F2): a
      // narrative adverse-event mention of an active med must NOT be dropped by a later dose update.
      // Compared at DAY granularity so sub-day serialization drift can't flip the boundary (F5).
      if (m.status === 'active' && isLedgerLane) {
        const headDay = RecallEngine.dayOf(m.createdAt);
        if (headDay !== null && chunkDay !== null && headDay > chunkDay) return true;
      }
    }
    return false;
  }

  private static dayOf(iso: string): number | null {
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? null : Math.floor(t / MS_PER_DAY);
  }

  private static emptyCandidate(h: { id: string; lane: string; content: string; createdAt: string }): Candidate {
    return { id: h.id, lane: h.lane, content: h.content, createdAt: h.createdAt, cosine: 0, bm25n: 0 };
  }

  private static ageDays(createdAt: string, now: Date): number {
    const t = new Date(createdAt).getTime();
    if (Number.isNaN(t)) return 0;
    return Math.max(0, (now.getTime() - t) / MS_PER_DAY);
  }

  private static dedupeByContent(hits: RecallHit[]): RecallHit[] {
    // Exact restated-content dedupe, keep highest raw. (Pairwise cosine>0.92 semantic dedupe needs
    // per-candidate embeddings in the result set — deferred to a later refinement; documented.)
    const best = new Map<string, RecallHit>();
    for (const h of hits) {
      const key = h.content.trim().toLowerCase();
      const cur = best.get(key);
      if (!cur || h.raw > cur.raw) best.set(key, h);
    }
    return [...best.values()];
  }

  private static fitHits(hits: RecallHit[], budgetTokens: number): { kept: RecallHit[]; text: string; tokens: number } {
    const kept: RecallHit[] = [];
    for (const h of hits) {
      const candidate = [...kept, h].map(x => `- ${x.content}`).join('\n');
      if (estimateTokens(candidate) > budgetTokens) break;
      kept.push(h);
    }
    const text = kept.map(x => `- ${x.content}`).join('\n');
    return { kept, text, tokens: estimateTokens(text) };
  }

  // ---- Stage 3: deterministic side-effect correlation ------------------------------------
  //
  // Data-driven from active meds' known_side_effects (no embeddings, no LLM). Surfaces a CHECK:
  // line phrased as a possibility, never an alarm (DIAB-05). Findings are context-only here;
  // persisting them to the inferences/ sandbox (graduation substrate) is P5 — not wired in P2.
  // New-med→active-condition contraindication and event-lag windows (DIAB-07) need a med lexicon /
  // the event store consumer respectively and are deferred (documented in the P2 plan).

  private async stage3Entity(input: RecallInput): Promise<string> {
    const { factMirror, clock, config } = this.deps;
    try {
      const msgWords = normalizeMessageWords(input.userMessage);
      const now = clock.now();
      const lines: string[] = [];
      for await (const med of factMirror.queryActive('medication')) {
        const sideEffects = med.fields['known_side_effects'];
        if (!Array.isArray(sideEffects)) continue;
        const started = typeof med.fields['started'] === 'string' ? (med.fields['started'] as string) : '';
        // Only recent(90d) meds correlate (specs/07 §6) — a long-standing med would fire CHECK on
        // every mention and erode signal (F7). Fail-open for undated/unparseable starts.
        if (!RecallEngine.isRecentMed(started, now, config.recentMedDays)) continue;
        for (const se of sideEffects) {
          if (typeof se !== 'string') continue;
          if (!sideEffectMatches(se, msgWords)) continue;
          lines.push(renderCheck(med.entity, started, se, now));
        }
      }
      return lines.join('\n');
    } catch (e) {
      console.warn('[recall] stage3 entity correlation failed:', summarizeErrorForLog(e));
      return '';
    }
  }

  private static isRecentMed(started: string, now: Date, windowDays: number): boolean {
    if (!started) return true; // undated → fail-open (recency unknown, correlate anyway)
    const t = new Date(started).getTime();
    if (Number.isNaN(t)) return true; // unparseable → fail-open
    return (now.getTime() - t) / MS_PER_DAY <= windowDays;
  }
}
