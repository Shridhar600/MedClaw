export interface ChunkStat {
  chunkId: string;
  injectedCount: number;
  usedCount: number;
  lastUsedAt?: string;
}

/**
 * Recall usage telemetry (specs/07 §6 Stage 4). `injected_count` bumps when a chunk is put in
 * context; `used_count` bumps when the model reports it used the chunk (B7 `<used>` tag). Drives
 * auto-mute (injected ≫ used) — with the B4 carve-out applied by the caller, never here.
 */
export interface ChunkStatsWriter {
  bumpInjected(chunkIds: string[]): Promise<void>;
  bumpUsed(chunkIds: string[], at: string): Promise<void>;
  get(chunkId: string): Promise<ChunkStat | null>;
}
