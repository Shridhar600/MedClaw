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
  healthLanes: string[];
  ledgerTypes: string[];
  autoMuteInjectedThreshold: number;
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
  preDecayFloor: 0.15, // specs/13 B6
  healthLaneBoost: 1.5, // CHAT-07 content-type bias (post-threshold, H-4)
  healthLanes: ['ledger', 'episode'], // safety-threshold lanes (B5) + CHAT-07 boost + B4 mute-exempt
  ledgerTypes: ['medication', 'condition', 'symptom', 'appointment', 'metric', 'goal', 'allergy'],
  autoMuteInjectedThreshold: 20, // specs/13 B7 (never applied to safety_relevant / ledger|episode, B4)
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
  narrative: string;
  narrativeTokens: number;
  hits: RecallHit[];
  injectedChunkIds: string[];
  indexStatus: IndexStatus;
  entity: string;
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

// A terminal head status → any chunk for that entity is stale and fail-closed dropped (KNEE-10).
const STALE_STATUSES = new Set(['retracted', 'discontinued', 'superseded']);
const MS_PER_DAY = 86_400_000;

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function fmtFieldValue(v: string | number | string[]): string {
  return Array.isArray(v) ? v.join('; ') : String(v);
}

function toWordSet(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

/** Heads whose entity words all appear in the chunk content (deterministic, no embeddings). */
function matchEntities(content: string, heads: FactRecord[]): FactRecord[] {
  const words = toWordSet(content);
  return heads.filter(h => {
    const ew = h.entity.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return ew.length > 0 && ew.every(w => words.has(w));
  });
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
      windowClause = `~${weeks} weeks`;
    }
  }
  const startedClause = started ? ` (started ${started})` : '';
  return `CHECK: ${entity}${startedClause} lists ${seHuman} as a known side effect. `
    + `Temporal correlation window: ${windowClause}. No diagnostic certainty.`;
}

export class RecallEngine {
  constructor(private deps: RecallDeps) {}

  async run(input: RecallInput): Promise<RecallReport> {
    const stage1 = await this.stage1Ledger();
    const stage2 = await this.stage2Narrative(input);
    const stage3 = await this.stage3Entity(input);
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
      narrative: stage2.text,
      narrativeTokens: stage2.tokens,
      hits: stage2.hits,
      injectedChunkIds: stage2.injectedChunkIds,
      indexStatus: stage2.indexStatus,
      entity: stage3,
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

  private async stage1Ledger(): Promise<{ text: string; tokens: number }> {
    const { factMirror, config } = this.deps;
    try {
      // Active clinical facts, deduped by entity → highest version (CONTRA-07).
      const byEntity = new Map<string, FactRecord>();
      for await (const f of factMirror.queryActive()) {
        if (!config.ledgerTypes.includes(f.type)) continue;
        const cur = byEntity.get(f.entity);
        if (!cur || f.version > cur.version) byEntity.set(f.entity, f);
      }
      const lines: string[] = [];
      for (const f of byEntity.values()) lines.push(RecallEngine.renderActive(f));
      // Paused facts that carry a pre_pause_summary (KNEE-08).
      for await (const f of factMirror.queryPaused()) {
        if (!config.ledgerTypes.includes(f.type)) continue;
        const summary = f.fields['pre_pause_summary'];
        if (summary === undefined) continue;
        lines.push(`- ${f.entity} (${f.type}) paused — ${fmtFieldValue(summary)}`);
      }
      return RecallEngine.fitLines(lines, config.ledgerBudget);
    } catch (e) {
      console.warn('[recall] stage1 ledger failed:', summarizeErrorForLog(e));
      return { text: '', tokens: 0 };
    }
  }

  private static renderActive(f: FactRecord): string {
    const fields = Object.entries(f.fields)
      .filter(([k]) => k !== 'pre_pause_summary')
      .map(([k, v]) => `${k}: ${fmtFieldValue(v)}`)
      .join(', ');
    return `- ${f.entity} (${f.type}) ${f.status}${fields ? ` — ${fields}` : ''}`;
  }

  private static fitLines(lines: string[], budgetTokens: number): { text: string; tokens: number } {
    const kept: string[] = [];
    for (const line of lines) {
      const candidate = [...kept, line].join('\n');
      if (estimateTokens(candidate) > budgetTokens) break;
      kept.push(line);
    }
    const text = kept.join('\n');
    return { text, tokens: estimateTokens(text) };
  }

  // ---- Stage 2: hybrid narrative recall --------------------------------------------------

  private async stage2Narrative(input: RecallInput): Promise<Stage2Result> {
    const { config, clock } = this.deps;
    try {
      const { candidates, indexStatus } = await this.gatherCandidates(input.userMessage);
      if (candidates.size === 0) {
        return { text: '', tokens: 0, hits: [], injectedChunkIds: [], indexStatus };
      }
      const heads = await this.loadEntityHeads();
      const now = clock.now();

      const scored: RecallHit[] = [];
      for (const c of candidates.values()) {
        const matched = matchEntities(c.content, heads);
        if (RecallEngine.isSuppressed(matched, c.createdAt)) continue;

        // On keyword-only degrade there is no cosine, so the keyword score stands in for the
        // semantic signal (full weight on the only signal we have) — otherwise a bm25-only chunk
        // caps at raw 0.3 and can never clear the 0.5 threshold, and degrade would return nothing.
        const effectiveCosine = indexStatus === 'keyword-only' ? c.bm25n : c.cosine;
        const base = 0.7 * effectiveCosine + 0.3 * c.bm25n;
        if (base < config.preDecayFloor) continue; // B6 pre-decay floor

        const safetyRelevant = matched.some(m => m.safetyRelevant);
        const inHealthLane = config.healthLanes.includes(c.lane);

        // B4 auto-mute: a chunk injected ≫ used is noise — drop it, EXCEPT safety_relevant chunks
        // or ledger|episode lanes, which are NEVER muted (specs/13 B4 / v2-H-1).
        if (!safetyRelevant && !inHealthLane) {
          const stat = await this.deps.chunkStats.get(c.id);
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

  /** Hybrid gather: embed (timeout-guarded) → vec KNN ∪ keyword match, merged by chunk id. */
  private async gatherCandidates(userMessage: string): Promise<{ candidates: Map<string, Candidate>; indexStatus: IndexStatus }> {
    const { config } = this.deps;
    const candidates = new Map<string, Candidate>();
    let indexStatus: IndexStatus = 'full';

    let embedding: number[] | null = null;
    try {
      const vecs = await this.embedWithTimeout(userMessage);
      embedding = vecs[0] ?? null;
    } catch (e) {
      // Embed throw OR 500ms timeout ⇒ keyword-only degrade (PLAT-11, v2-BL-2).
      console.warn('[recall] embed failed → keyword-only:', summarizeErrorForLog(e));
      indexStatus = 'keyword-only';
    }

    if (embedding) {
      const k = config.topKNarrative * config.overfetchFactor;
      for await (const h of this.deps.vectorIndex.queryKnn(embedding, k)) {
        const c = candidates.get(h.id) ?? RecallEngine.emptyCandidate(h);
        c.cosine = Math.max(c.cosine, h.score);
        candidates.set(h.id, c);
      }
    }
    for await (const h of this.deps.keywordIndex.match(userMessage, config.topKKeyword)) {
      const c = candidates.get(h.id) ?? RecallEngine.emptyCandidate(h);
      c.bm25n = Math.max(c.bm25n, h.score);
      candidates.set(h.id, c);
    }
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

  private async loadEntityHeads(): Promise<FactRecord[]> {
    try {
      const heads: FactRecord[] = [];
      for await (const h of this.deps.factMirror.queryEntityHeads()) heads.push(h);
      return heads;
    } catch (e) {
      // No heads ⇒ no suppression this turn (best-effort; never crash the turn).
      console.warn('[recall] entity-heads load failed:', summarizeErrorForLog(e));
      return [];
    }
  }

  private static isSuppressed(matched: FactRecord[], chunkCreatedAt: string): boolean {
    const chunkTs = new Date(chunkCreatedAt).getTime();
    for (const m of matched) {
      if (STALE_STATUSES.has(m.status)) return true; // stale fail-closed (KNEE-10)
      if (m.status === 'active') {
        const headTs = new Date(m.createdAt).getTime();
        if (!Number.isNaN(headTs) && !Number.isNaN(chunkTs) && headTs > chunkTs) return true; // CONTRA-10
      }
    }
    return false;
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
    const { factMirror, clock } = this.deps;
    try {
      const msgWords = normalizeMessageWords(input.userMessage);
      const now = clock.now();
      const lines: string[] = [];
      for await (const med of factMirror.queryActive('medication')) {
        const sideEffects = med.fields['known_side_effects'];
        if (!Array.isArray(sideEffects)) continue;
        for (const se of sideEffects) {
          if (typeof se !== 'string') continue;
          if (!sideEffectMatches(se, msgWords)) continue;
          const started = typeof med.fields['started'] === 'string' ? (med.fields['started'] as string) : '';
          lines.push(renderCheck(med.entity, started, se, now));
        }
      }
      return lines.join('\n');
    } catch (e) {
      console.warn('[recall] stage3 entity correlation failed:', summarizeErrorForLog(e));
      return '';
    }
  }
}
