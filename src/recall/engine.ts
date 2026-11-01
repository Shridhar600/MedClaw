
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
  /** Lanes carrying versioned ledger-fact statements; newer-active suppression is scoped here. */
  ledgerLanes: string[];
  ledgerTypes: string[];
  autoMuteInjectedThreshold: number;
  /** Stage-3 side-effect correlation only considers meds started within this window. */
  recentMedDays: number;
}

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  topKNarrative: 24,
  topKKeyword: 24,
  narrativeBudget: 2000,
  ledgerBudget: 600,
  halfLifeDays: 120,
  scoreThreshold: 0.5,
  safetyThreshold: 0.3,
  embedTimeoutMs: 500,
  overfetchFactor: 3,
  finalTopK: 3,
  preDecayFloor: 0.15, // safety_relevant chunks are exempt (see stage 2)
  healthLaneBoost: 1.5, // content-type bias, applied post-threshold
  healthLanes: ['ledger', 'episode'], // safety-threshold lanes, content-type boost, auto-mute exempt
  ledgerLanes: ['ledger'], // newer-active version suppression is scoped to ledger-fact chunks
  ledgerTypes: ['medication', 'condition', 'symptom', 'appointment', 'metric', 'goal', 'allergy'],
  autoMuteInjectedThreshold: 20, // never applied to safety_relevant or ledger|episode chunks
  recentMedDays: 90, // Stage 3 considers active meds started within this many days
};

export interface RecallDeps {
  embedding: EmbeddingPort;
  vectorIndex: VectorIndex;
  keywordIndex: KeywordIndex;
  factMirror: FactMirror;
  chunkStats: ChunkStatsWriter;
  clock: Clock;
  config: RecallConfig;
  currentFacts: () => Promise<CurrentFacts>;
}

export interface CurrentFacts {
  facts: FactRecord[];
  damagedFiles: string[];
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
  /** Stage-3 deterministic correlation output: `CHECK:` lines. */
  checkNotes: string;
  /** Optional heartbeat-only follow-up surface attached by the composition root. */
  curiosity?: readonly {
    id: string;
    description: string;
    kind?: string;
    critical?: boolean;
    dueAt?: string;
  }[];
  curiosityStatus?: 'unreadable' | 'provider-unavailable';
}

interface Stage2Result {
  text: string;
  tokens: number;
  hits: RecallHit[];
  injectedChunkIds: string[];
  indexStatus: IndexStatus;
}

const AUTHORITY_RANK: Record<string, number> = {
  doctor: 5, lab: 5, report: 4, sensor: 3, user: 2, inference: 1,
};

// A stale/disputed head status means any chunk for that entity is stale and is dropped (fail closed).
const STALE_STATUSES = new Set(['retracted', 'discontinued', 'superseded', 'disputed']);
const MS_PER_DAY = 86_400_000;
const CHECK_BUDGET_TOKENS = 200;

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function fmtFieldValue(v: string | number | string[]): string {
  return Array.isArray(v) ? v.join('; ') : String(v);
}

function toWordSet(s: string): Set<string> {
  // Singularize so plural/inflected mentions still match entity words ("UTIs" -> "uti").
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

export function chunkHasStaleEntity(content: string, heads: FactRecord[]): boolean {
  return matchEntities(content, heads).some(h => STALE_STATUSES.has(h.status));
}

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

interface CheckCandidate {
  entity: string;
  started: string;
  sideEffect: string;
  line: string;
}

function checkCandidateOrder(a: CheckCandidate, b: CheckCandidate): number {
  const aTime = Date.parse(a.started);
  const bTime = Date.parse(b.started);
  const aRank = Number.isNaN(aTime) ? Number.NEGATIVE_INFINITY : aTime;
  const bRank = Number.isNaN(bTime) ? Number.NEGATIVE_INFINITY : bTime;
  return bRank - aRank
    || a.entity.localeCompare(b.entity)
    || a.sideEffect.localeCompare(b.sideEffect);
}

function fitCheckLines(lines: string[]): string {
  if (lines.length === 0) return '';
  const markerFor = (omitted: number): string => `… [CHECK truncated: ${omitted} additional checks omitted]`;
  const kept: string[] = [];
  for (const line of lines) {
    const omitted = lines.length - kept.length - 1;
    const candidate = omitted > 0
      ? [...kept, line, markerFor(omitted)].join('\n')
      : [...kept, line].join('\n');
    if (estimateTokens(candidate) > CHECK_BUDGET_TOKENS) break;
    kept.push(line);
  }
  if (kept.length === lines.length) return kept.join('\n');

  const marker = markerFor(lines.length - kept.length);
  while (kept.length > 0 && estimateTokens([...kept, marker].join('\n')) > CHECK_BUDGET_TOKENS) kept.pop();
  if (estimateTokens(marker) > CHECK_BUDGET_TOKENS) return marker.slice(0, CHECK_BUDGET_TOKENS * 4);
  return [...kept, marker].join('\n');
}

export class RecallEngine {
  constructor(private deps: RecallDeps) {}

  async run(input: RecallInput, opts?: { narrative?: boolean }): Promise<RecallReport> {
    const includeNarrative = opts?.narrative ?? true;
    const current = await this.readCurrentFacts();
    const stage1 = this.stage1Ledger(current);
    const stage2: Stage2Result = includeNarrative
      ? await this.stage2Narrative(input)
      : { text: '', tokens: 0, hits: [], injectedChunkIds: [], indexStatus: 'full' };
    const stage3 = includeNarrative && current ? this.stage3Entity(input, current.facts) : '';
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

  async recordUsage(chunkIds: string[], at: string, injectedChunkIds?: readonly string[]): Promise<void> {
    const injected = injectedChunkIds === undefined ? undefined : new Set(injectedChunkIds);
    const accepted = [...new Set(chunkIds)].filter(id => injected === undefined || injected.has(id));
    if (accepted.length === 0) return;
    try {
      await this.deps.chunkStats.bumpUsed(accepted, at);
    } catch (e) {
      console.warn('[recall] recordUsage failed:', summarizeErrorForLog(e));
    }
  }

  /** One ledger read per turn, shared by Stages 1 and 3. `null` means the ledger could not be read. */
  private async readCurrentFacts(): Promise<CurrentFacts | null> {
    try {
      return await this.deps.currentFacts();
    } catch (e) {
      console.warn('[recall] current ledger facts unreadable:', summarizeErrorForLog(e));
      return null;
    }
  }

  private stage1Ledger(current: CurrentFacts | null): { text: string; tokens: number; truncated: boolean } {
    const { config } = this.deps;
    if (!current) {
      return RecallEngine.fitLines(
        ['- WARNING: the health record could not be read this turn. Do not assume any medication, allergy or condition is current; ask the owner.'],
        config.ledgerBudget,
      );
    }
    const warnings = current.damagedFiles.map((file) =>
      `- WARNING: ledger/${file} is damaged and could not be fully read. Facts from it may be missing, and it cannot be changed until the owner repairs it.`);
    const byEntity = new Map<string, FactRecord[]>();
    for (const f of current.facts) {
      if (f.status !== 'active' || !config.ledgerTypes.includes(f.type)) continue;
      const key = `${f.type}::${f.entity}`;
      const group = byEntity.get(key);
      if (group) group.push(f); else byEntity.set(key, [f]);
    }
    const activeGroups = [...byEntity.values()].sort((a, b) =>
      ledgerRank(a[0]) - ledgerRank(b[0]) || a[0].entity.localeCompare(b[0].entity));
    const lines: string[] = [...warnings, ...activeGroups.map((group) => {
      if (group.length === 1) return RecallEngine.renderActive(group[0]);
      const values = [...group]
        .sort((a, b) => a.version - b.version)
        .map((f) => `v${f.version}: ${RecallEngine.renderActive(f).replace(/^- /, '')}`)
        .join(' | ');
      return `- CONFLICT: multiple active ${group[0].type} records for ${group[0].entity} — ${values}`;
    })];
    for (const f of current.facts) {
      if (f.status !== 'paused' || !config.ledgerTypes.includes(f.type)) continue;
      if (byEntity.has(`${f.type}::${f.entity}`)) continue;
      const summary = f.fields['pre_pause_summary'];
      if (summary === undefined) continue;
      lines.push(`- ${f.entity} (${f.type}) paused — ${fmtFieldValue(summary)}`);
    }
    return RecallEngine.fitLines(lines, config.ledgerBudget);
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

  private async stage2Narrative(input: RecallInput): Promise<Stage2Result> {
    const { config, clock } = this.deps;
    try {
      const { candidates, indexStatus } = await this.gatherCandidates(input.userMessage);
      if (candidates.size === 0) {
        return { text: '', tokens: 0, hits: [], injectedChunkIds: [], indexStatus };
      }
      const headRead = await this.loadEntityHeads();
      if (!headRead.available) {
        return { text: '', tokens: 0, hits: [], injectedChunkIds: [], indexStatus: 'failed' };
      }
      const heads = headRead.heads;
      const now = clock.now();

      const scored: RecallHit[] = [];
      for (const c of candidates.values()) {
        const matched = matchEntities(c.content, heads);
        if (RecallEngine.isSuppressed(matched, c, config)) continue;

        const safetyRelevant = matched.some(m => m.safetyRelevant);

        const effectiveCosine = indexStatus === 'keyword-only' ? c.bm25n : c.cosine;
        const base = 0.7 * effectiveCosine + 0.3 * c.bm25n;
        if (!safetyRelevant && base < config.preDecayFloor) continue;

        const inHealthLane = config.healthLanes.includes(c.lane);

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

  private async gatherCandidates(userMessage: string): Promise<{ candidates: Map<string, Candidate>; indexStatus: IndexStatus }> {
    const { config } = this.deps;
    const candidates = new Map<string, Candidate>();
    let embedding: number[] | null = null;
    try {
      const vecs = await this.embedWithTimeout(userMessage);
      const v = vecs[0];
      if (v && v.length > 0) embedding = v;
      else console.warn('[recall] empty embedding → keyword-only');
    } catch (e) {
      // An embed throw or 500ms timeout degrades to keyword-only.
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
      console.warn('[recall] entity-heads load failed:', summarizeErrorForLog(e));
      return { heads: [], available: false };
    }
  }

  private static isSuppressed(matched: FactRecord[], chunk: Candidate, config: RecallConfig): boolean {
    const chunkDay = RecallEngine.dayOf(chunk.createdAt);
    const isLedgerLane = config.ledgerLanes.includes(chunk.lane);
    for (const m of matched) {
      if (STALE_STATUSES.has(m.status)) return true; // stale head status fails closed, all lanes
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
    // Exact restated-content dedupe, keep highest raw.
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

  private stage3Entity(input: RecallInput, facts: FactRecord[]): string {
    const { clock, config } = this.deps;
    try {
      const msgWords = normalizeMessageWords(input.userMessage);
      const now = clock.now();
      const candidates = new Map<string, CheckCandidate>();
      for (const med of facts) {
        if (med.type !== 'medication' || med.status !== 'active') continue;
        const sideEffects = med.fields['known_side_effects'];
        if (!Array.isArray(sideEffects)) continue;
        const started = typeof med.fields['started'] === 'string' ? (med.fields['started'] as string) : '';
        if (!RecallEngine.isRecentMed(started, now, config.recentMedDays)) continue;
        for (const se of sideEffects) {
          if (typeof se !== 'string') continue;
          if (!sideEffectMatches(se, msgWords)) continue;
          const key = `${med.entity.trim().toLowerCase()}::${se.trim().toLowerCase()}`;
          if (!candidates.has(key)) {
            candidates.set(key, {
              entity: med.entity,
              started,
              sideEffect: se,
              line: renderCheck(med.entity, started, se, now),
            });
          }
        }
      }
      return fitCheckLines([...candidates.values()].sort(checkCandidateOrder).map(candidate => candidate.line));
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
