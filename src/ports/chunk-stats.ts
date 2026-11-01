export interface ChunkStat {
  chunkId: string;
  injectedCount: number;
  usedCount: number;
  lastUsedAt?: string;
}

export interface ChunkStatsWriter {
  bumpInjected(chunkIds: string[]): Promise<void>;
  bumpUsed(chunkIds: string[], at: string): Promise<void>;
  get(chunkId: string): Promise<ChunkStat | null>;
}
