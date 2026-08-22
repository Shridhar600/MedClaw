// src/recall/scoring.ts
//
// Pure recall scoring (P2 Wave B / Task B1, specs/07 §6 + specs/13 B5 + v2-BL-1a/1b).
// No I/O, no clock: ageDays is passed in (F20 — the engine derives it from an injected clock).
//
//   decay   = safetyRelevant ? 1 : exp(-ageDays / halfLifeDays)   (safety facts never time-decay)
//   raw     = (0.7·cosine + 0.3·bm25n) · decay
//   ranking = raw · (1 + 0.1·authorityRank)
//
// Thresholds (scoreThreshold 0.5 / safetyThreshold 0.3) are applied to `raw` by the engine;
// the authority boost affects RANKING/ordering ONLY (B5). Both values are returned so the engine
// thresholds on `raw` and orders on `ranking`.

export interface ScoreParams {
  cosine: number;
  bm25n: number;
  ageDays: number;
  halfLifeDays: number;
  authorityRank: number;
  safetyRelevant: boolean;
}

export interface ScoreResult {
  raw: number;
  ranking: number;
}

export function scoreChunk(params: ScoreParams): ScoreResult {
  const { cosine, bm25n, ageDays, halfLifeDays, authorityRank, safetyRelevant } = params;
  const decay = safetyRelevant ? 1 : Math.exp(-ageDays / halfLifeDays);
  const raw = (0.7 * cosine + 0.3 * bm25n) * decay;
  const ranking = raw * (1 + 0.1 * authorityRank);
  return { raw, ranking };
}
