export interface Chunk {
  id: string;
  path: string;
  lane: string;
  content: string;
  startLine: number;
  endLine: number;
  createdAt: string;
  // The dense embedding to index. Optional so a chunk may be stored as searchable
  // metadata (e.g. keyword-only) without a vector; the vector index skips vec rows for
  // chunks without one.
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
