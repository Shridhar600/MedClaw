
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
