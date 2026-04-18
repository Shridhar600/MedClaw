// src/memory/search.ts
import type { LLMProvider } from '../providers/types';
import type { SearchResult } from './types';
import type { SqliteStore } from './sqlite-store';

interface HybridWeights {
  vector: number;
  keyword: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
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
  ) {}

  async search(query: string, topK: number): Promise<SearchResult[]> {
    // Vector search: embed query, compute cosine similarity (already [0, 1] for unit-norm embeddings)
    let vectorResults: SearchResult[] = [];
    try {
      const queryEmbedding = await this.embeddingProvider.embed(query);
      const allChunks = this.store.getAllChunksWithEmbeddings();
      const scored = allChunks
        .filter(c => c.embedding)
        .map(c => ({
          chunkId: c.id,
          path: c.path,
          content: c.content,
          // Clamp to [0, 1] for safety — unit-norm dot product should always be in this range
          score: Math.max(0, Math.min(1, cosineSimilarity(queryEmbedding, c.embedding!))),
          startLine: c.startLine,
          endLine: c.endLine,
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK * 2);
      vectorResults = scored;
    } catch (e) {
      console.warn('[search] Vector search failed, falling back to keyword only:', e);
    }

    // Keyword search: raw BM25 scores (unbounded), normalize to [0, 1] before combining
    const rawKeywordResults = this.store.keywordSearch(query, topK * 2);
    const keywordResults = normalizeBm25Scores(rawKeywordResults);

    // Merge by chunk id, combine normalized scores
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
