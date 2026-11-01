export interface ChunkStat {
  chunkId: string;
  injectedCount: number;
  usedCount: number;
  lastUsedAt?: string;
}

/**
 * Recall usage telemetry. `injected_count` bumps when a chunk is put in context; `used_count` bumps
 * when the model reports it used the chunk. Drives auto-mute (injected far above used); callers apply
 * any carve-outs, never this port.
 */
export interface ChunkStatsWriter {
  bumpInjected(chunkIds: string[]): Promise<void>;
  bumpUsed(chunkIds: string[], at: string): Promise<void>;
  get(chunkId: string): Promise<ChunkStat | null>;
}
