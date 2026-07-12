export interface ScoreParams {
  cosine: number;
  bm25n: number;
  ageDays: number;
  halfLifeDays: number;
  authorityRank: number;
}

export function scoreChunk(params: ScoreParams): number {
  void params;
  return 0;
}
