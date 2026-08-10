// src/memory/types.ts

export interface MemoryFile {
  path: string;      // Relative to workspace root, e.g. "conditions/diabetes.md"
  content: string;
  updatedAt: Date;
}

export interface Chunk {
  id: string;        // "<path>:<chunk_index>"
  path: string;      // Relative to workspace root
  content: string;
  startLine: number; // First line number in source file (1-indexed)
  endLine: number;   // Last line number in source file (1-indexed)
  embedding?: number[];
}

export type SearchStatus = 'full' | 'keyword-only' | 'failed';

export interface SearchResult {
  chunkId: string;
  path: string;
  content: string;
  score: number;
  startLine: number;
  endLine: number;
  status?: SearchStatus;
}
