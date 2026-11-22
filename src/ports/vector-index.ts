export interface Chunk {
  id: string;
  path: string;
  lane: string;
  content: string;
  startLine: number;
  endLine: number;
  createdAt: string;
  // Optional: a chunk may be stored as keyword-only metadata. The vector index skips chunks without one.
  embedding?: number[];
}

export interface ChunkWithScore extends Chunk {
  score: number;
}

export interface VectorStats {
  totalChunks: number;
  dimension: number;
}

export interface VectorIndex {
  upsert(chunks: Chunk[]): Promise<void>;
  queryKnn(embedding: number[], k: number, filter?: Record<string, unknown>): AsyncIterable<ChunkWithScore>;
  deleteByPath(path: string): Promise<void>;
  stats(): Promise<VectorStats>;
}
