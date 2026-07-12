import type { LLMProvider } from '../providers/types';
import type { SearchResult } from './types';
import type { SqliteStore } from './sqlite-store';

interface HybridWeights {
  vector: number;
  keyword: number;
}

/**
 * Min-max normalizes raw BM25 scores (unbounded, from FTS5 rank) to [0, 1].
 * FTS5 rank values are negative; stronger matches are typically more negative.
 * After Math.abs(), stronger matches become larger positive numbers.
 * So we apply (score - min) / (max - min) to map stronger keyword matches closer to 1.0.
 * Returns 0.5 when all scores are equal (no variation).
 */
function normalizeBm25Scores(results: SearchResult[]): SearchResult[] {
  if (results.length === 0) return results;
  const scores = results.map(r => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  if (range === 0) {
    return results.map(r => ({ ...r, score: 0.5 }));
  }
  return results.map(r => ({
    ...r,
    score: (r.score - min) / range,
  }));
}

export class MemorySearch {
  constructor(
    private readonly store: SqliteStore,
    private readonly embeddingProvider: LLMProvider,
    private readonly weights: HybridWeights,
    private readonly profileId: string = 'default',
  ) {}

  async search(query: string, topK: number): Promise<SearchResult[]> {
    let vectorResults: SearchResult[] = [];
    try {
      const queryEmbedding = await this.embeddingProvider.embed(query);
      const float32 = new Float32Array(queryEmbedding);
      vectorResults = this.store.vectorSearch(float32, topK * 2);
    } catch (e) {
      console.warn('[search] Vector search failed, falling back to keyword only:', e);
    }

    const rawKeywordResults = this.store.keywordSearch(query, topK * 2);
    const keywordResults = normalizeBm25Scores(rawKeywordResults);

    const scoreMap = new Map<string, SearchResult>();

    for (const r of vectorResults) {
      scoreMap.set(r.chunkId, {
        chunkId: r.chunkId,
        path: r.path,
        content: r.content,
        score: r.score * this.weights.vector,
        startLine: r.startLine,
        endLine: r.endLine,
      });
    }
    for (const r of keywordResults) {
      const existing = scoreMap.get(r.chunkId);
      const keywordScore = r.score * this.weights.keyword;
      if (existing) {
        existing.score += keywordScore;
      } else {
        scoreMap.set(r.chunkId, {
          chunkId: r.chunkId,
          path: r.path,
          content: r.content,
          score: keywordScore,
          startLine: r.startLine,
          endLine: r.endLine,
        });
      }
    }

    return [...scoreMap.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
