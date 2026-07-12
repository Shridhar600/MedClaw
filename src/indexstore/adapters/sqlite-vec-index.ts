import { NotImplementedError } from '../../shared/errors';
import type { VectorIndex, Chunk, ChunkWithScore, VectorStats } from '../../ports/vector-index';

export class SqliteVecIndex implements VectorIndex {
  constructor() {
    throw new NotImplementedError('SqliteVecIndex');
  }

  async upsert(chunks: Chunk[]): Promise<void> {
    void chunks;
    throw new NotImplementedError('SqliteVecIndex.upsert');
  }

  queryKnn(
    embedding: number[],
    k: number,
    filter?: Record<string, unknown>,
  ): AsyncIterable<ChunkWithScore> {
    void embedding;
    void k;
    void filter;
    throw new NotImplementedError('SqliteVecIndex.queryKnn');
  }

  async deleteByPath(path: string): Promise<void> {
    void path;
    throw new NotImplementedError('SqliteVecIndex.deleteByPath');
  }

  async stats(): Promise<VectorStats> {
    throw new NotImplementedError('SqliteVecIndex.stats');
  }
}
