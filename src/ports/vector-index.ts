export interface Chunk {
  id: string;
  path: string;
  lane: string;
  content: string;
  startLine: number;
  endLine: number;
  createdAt: string;
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
