import type { Chunk, ChunkWithScore } from './vector-index';

export interface KeywordIndex {
  index(chunks: Chunk[]): Promise<void>;
  match(query: string, k: number, filter?: Record<string, unknown>): AsyncIterable<ChunkWithScore>;
  deleteByPath(path: string): Promise<void>;
}
