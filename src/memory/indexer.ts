import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { LLMProvider } from '../providers/types';
import type { SqliteStore } from './sqlite-store';
import type { Chunk } from './types';
import { summarizeErrorForLog } from '../security';

const CHUNK_SIZE_TOKENS = 400;
const OVERLAP_TOKENS = 80;

export type MemoryIndexerStatus =
  | { status: 'unknown' }
  | { status: 'available'; dimension: number }
  | { status: 'provider-unavailable' }
  | { status: 'unreadable' };

export interface MemoryIndexDeltaChunk {
  id: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface MemoryIndexDeltaFingerprint {
  mtimeMs: number;
  size: number;
  ino: number;
}

export interface MemoryIndexDelta {
  hash: string;
  fingerprint?: MemoryIndexDeltaFingerprint;
  chunks: MemoryIndexDeltaChunk[];
}

export type MemoryIndexDeltaProvider = (relativePath: string) => MemoryIndexDelta | undefined;

export class MemoryIndexer {
  private isIndexing = false;
  private dimensionProbeState: 'unknown' | 'available' | 'unavailable' = 'unknown';
  private embeddingDimension: number | undefined;
  private status: MemoryIndexerStatus = { status: 'unknown' };
  private readonly embeddingModelName: string;

  constructor(
    private readonly store: SqliteStore,
    private readonly embeddingProvider: LLMProvider,
    private readonly workspacePath: string,
    private readonly profileId: string = 'default',
    private readonly deltaProvider?: MemoryIndexDeltaProvider,
  ) {
    this.embeddingModelName = embeddingProvider.modelName ?? 'unknown';
  }

  /** Current dimension-probe state; a failed probe is explicit and is never treated as a dimension. */
  getStatus(): MemoryIndexerStatus {
    return { ...this.status };
  }

  async indexAll(): Promise<void> {
    if (this.isIndexing) {
      console.warn('[indexer] Index already running, skipping');
      return;
    }
    this.isIndexing = true;
    try {
      const dimensionAvailable = await this.ensureDimension();

      const files = this.globMarkdown(this.workspacePath);
      const currentPaths = new Set(files.map(file => path.relative(this.workspacePath, file)));
      for (const indexedPath of this.store.listIndexedPaths()) {
        if (!currentPaths.has(indexedPath)) {
          this.store.deleteIndexedPath(indexedPath);
          console.log(`[indexer] Pruned deleted file from index: ${indexedPath}`);
        }
      }
      for (const file of files) {
        const relativePath = path.relative(this.workspacePath, file);
        await this.indexFileInternal(relativePath, dimensionAvailable);
      }
      // The global identity is informational only. Per-file freshness is checked against the
      // file_hashes row, so it must never be advanced before files have had a chance to re-embed.
      if (dimensionAvailable) this.store.setEmbeddingModel(this.embeddingModelName);
    } finally {
      this.isIndexing = false;
    }
  }

  async indexFile(relativePath: string): Promise<void> {
    const dimensionAvailable = await this.ensureDimension();
    let delta: MemoryIndexDelta | undefined;
    try {
      delta = this.deltaProvider?.(relativePath);
    } catch (e) {
      console.warn(`[indexer] Delta metadata unavailable for ${relativePath}; using full reindex:`, summarizeErrorForLog(e));
    }
    if (delta) {
      await this.indexDelta(relativePath, delta, dimensionAvailable);
      return;
    }
    await this.indexFileInternal(relativePath, dimensionAvailable);
  }

  private async indexDelta(relativePath: string, delta: MemoryIndexDelta, dimensionAvailable: boolean): Promise<void> {
    const absolutePath = path.join(this.workspacePath, relativePath);
    if (!delta.fingerprint || delta.chunks.length === 0) {
      await this.indexFileInternal(relativePath, dimensionAvailable);
      return;
    }

    const initialStat = fs.statSync(absolutePath);
    if (!this.sameFingerprint(initialStat, delta.fingerprint)) {
      console.warn(`[indexer] Source changed before delta indexing ${relativePath}; using full reindex`);
      await this.indexFileInternal(relativePath, dimensionAvailable);
      return;
    }

    const lane = this.laneFor(relativePath);
    const createdAt = this.createdAtFor(relativePath, absolutePath);
    const chunks: Chunk[] = delta.chunks.map((chunk) => ({
      id: chunk.id,
      path: relativePath,
      lane,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      createdAt,
    }));
    const preparedChunks: Chunk[] = [];
    let hadEmbeddingFailure = !dimensionAvailable;
    const expectedDimension = dimensionAvailable ? this.embeddingDimension : undefined;
    for (const chunk of chunks) {
      if (!dimensionAvailable) {
        preparedChunks.push(chunk);
        continue;
      }
      try {
        const embedding = await this.embeddingProvider.embed(chunk.content);
        if (!this.isUsableEmbedding(embedding, expectedDimension)) {
          console.warn(`[indexer] Empty or invalid embedding for ${chunk.id}`);
          hadEmbeddingFailure = true;
        } else {
          chunk.embedding = embedding;
        }
      } catch (e) {
        console.warn(`[indexer] Failed to embed chunk ${chunk.id}:`, summarizeErrorForLog(e));
        hadEmbeddingFailure = true;
      }
      preparedChunks.push(chunk);
    }

    const finalStat = fs.statSync(absolutePath);
    if (!this.sameFingerprint(finalStat, delta.fingerprint)) {
      console.warn(`[indexer] Source changed while delta indexing ${relativePath}; stale delta discarded`);
      await this.indexFileInternal(relativePath, dimensionAvailable);
      return;
    }

    const nextHash = hadEmbeddingFailure ? `embedding-partial:${delta.hash}` : delta.hash;
    const existingHash = this.store.getFileHash(relativePath);
    const existingModel = this.store.getFileEmbeddingModel(relativePath);
    if (existingHash !== undefined && existingModel !== undefined && existingModel !== this.embeddingModelName) {
      await this.indexFileInternal(relativePath, dimensionAvailable);
      return;
    }
    if (existingHash !== undefined && existingModel === undefined && this.store.getChunksByPath(relativePath).length > 0) {
      await this.indexFileInternal(relativePath, dimensionAvailable);
      return;
    }
    if (existingHash !== undefined && existingModel === this.embeddingModelName) {
      for (const chunk of preparedChunks) this.store.upsertChunk(chunk);
      this.store.upsertFileHash(relativePath, nextHash);
    } else {
      // A newly-created source has no prior chunks. The full replacement API is
      // safe here and also records the per-file model identity for future deltas.
      this.store.replaceFileIndex(relativePath, preparedChunks, nextHash, this.embeddingModelName);
    }
    if (!hadEmbeddingFailure && !this.store.isFileIndexCurrent(relativePath, delta.hash, this.embeddingModelName)) {
      this.store.upsertFileHash(relativePath, `embedding-partial:${delta.hash}`);
    }
    console.log(`[indexer] Indexed ${relativePath} (${preparedChunks.length} delta chunks)`);
  }

  private async indexFileInternal(relativePath: string, _dimensionAvailable: boolean): Promise<void> {
    const absolutePath = path.join(this.workspacePath, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const hash = this.computeHash(content);

    if (this.store.isFileIndexCurrent(relativePath, hash, this.embeddingModelName)) {
      return;
    }

    const createdAt = this.createdAtFor(relativePath, absolutePath);
    const lane = this.laneFor(relativePath);
    const chunks = this.chunkContent(content, relativePath, lane, createdAt).filter(chunk => chunk.content.trim().length > 0);
    const preparedChunks: Chunk[] = [];
    let hadEmbeddingFailure = !_dimensionAvailable;
    const expectedDimension = _dimensionAvailable ? this.embeddingDimension : undefined;
    for (const chunk of chunks) {
      if (!_dimensionAvailable) {
        preparedChunks.push(chunk);
        continue;
      }
      try {
        const embedding = await this.embeddingProvider.embed(chunk.content);
        if (!this.isUsableEmbedding(embedding, expectedDimension)) {
          console.warn(`[indexer] Empty or invalid embedding for ${chunk.id}`);
          hadEmbeddingFailure = true;
        } else {
          chunk.embedding = embedding;
        }
      } catch (e) {
        // Embed failure messages can echo chunk PHI — sanitized frame only.
        console.warn(`[indexer] Failed to embed chunk ${chunk.id}:`, summarizeErrorForLog(e));
        hadEmbeddingFailure = true;
      }
      preparedChunks.push(chunk);
    }

    // Do not publish a completed snapshot if the source changed while embeddings were in flight.
    // A later index call will read and publish the newer generation.
    const currentContent = fs.readFileSync(absolutePath, 'utf-8');
    if (this.computeHash(currentContent) !== hash) {
      console.warn(`[indexer] Source changed while indexing ${relativePath}; stale result discarded`);
      return;
    }

    this.store.replaceFileIndex(relativePath, preparedChunks, hadEmbeddingFailure ? `embedding-partial:${hash}` : hash, this.embeddingModelName);
    console.log(`[indexer] Indexed ${relativePath} (${chunks.length} chunks)`);
  }

  private async ensureDimension(): Promise<boolean> {
    if (this.dimensionProbeState === 'available') return true;
    let probe: number[];
    try {
      probe = await this.embeddingProvider.embed('test');
    } catch (e) {
      this.dimensionProbeState = 'unavailable';
      this.embeddingDimension = undefined;
      this.status = { status: 'provider-unavailable' };
      console.warn('[indexer] Could not probe embedding dimension; vector indexing deferred:', summarizeErrorForLog(e));
      return false;
    }
    if (!this.isUsableEmbedding(probe, undefined)) {
      this.dimensionProbeState = 'unavailable';
      this.embeddingDimension = undefined;
      this.status = { status: 'provider-unavailable' };
      console.warn('[indexer] Could not probe embedding dimension; vector indexing deferred: invalid probe');
      return false;
    }
    try {
      // A failed store operation is different from an embedding outage. Do not publish either
      // state as a valid dimension, and let the next call retry the probe.
      this.store.ensureVecTable(probe.length);
      this.embeddingDimension = probe.length;
      this.dimensionProbeState = 'available';
      this.status = { status: 'available', dimension: probe.length };
      return true;
    } catch (e) {
      this.dimensionProbeState = 'unavailable';
      this.embeddingDimension = undefined;
      this.status = { status: 'unreadable' };
      console.warn('[indexer] Could not prepare vector index; vector indexing deferred:', summarizeErrorForLog(e));
      return false;
    }
  }

  private chunkContent(content: string, relativePath: string, lane: string, createdAt: string): Chunk[] {
    const chunks: Chunk[] = [];
    const lines = content.split('\n');
    let currentChunk: { lines: string[]; startLine: number; tokenCount: number } = {
      lines: [],
      startLine: 1,
      tokenCount: 0,
    };
    let chunkIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineTokens = line.split(/\s+/).filter(Boolean).length;
      if (currentChunk.tokenCount + lineTokens > CHUNK_SIZE_TOKENS && currentChunk.lines.length > 0) {
        const chunkContent = currentChunk.lines.join('\n');
        chunks.push({
          id: `${relativePath}:${chunkIndex}`,
          path: relativePath,
          lane,
          content: chunkContent,
          startLine: currentChunk.startLine,
          endLine: currentChunk.startLine + currentChunk.lines.length - 1,
          createdAt,
        });
        chunkIndex++;

        const overlapTokenCount = OVERLAP_TOKENS;
        let overlapAcc = 0;
        let overlapStartIdx = currentChunk.lines.length - 1;
        while (overlapStartIdx >= 0 && overlapAcc < overlapTokenCount) {
          overlapAcc += currentChunk.lines[overlapStartIdx].split(/\s+/).filter(Boolean).length;
          overlapStartIdx--;
        }
        const overlapLineCount = currentChunk.lines.length - 1 - overlapStartIdx;
        const overlapLines = currentChunk.lines.slice(-overlapLineCount);
        currentChunk = {
          lines: [...overlapLines, line],
          startLine: currentChunk.startLine + currentChunk.lines.length - overlapLineCount,
          tokenCount: overlapLines.reduce((acc, l) => acc + l.split(/\s+/).filter(Boolean).length, 0) + lineTokens,
        };
      } else {
        currentChunk.lines.push(line);
        currentChunk.tokenCount += lineTokens;
      }
    }

    if (currentChunk.lines.length > 0) {
      chunks.push({
        id: `${relativePath}:${chunkIndex}`,
        path: relativePath,
        lane,
        content: currentChunk.lines.join('\n'),
        startLine: currentChunk.startLine,
        endLine: currentChunk.startLine + currentChunk.lines.length - 1,
        createdAt,
      });
    }

    return chunks;
  }

  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private isUsableEmbedding(values: number[] | undefined, expectedDimension?: number): boolean {
    return values !== undefined
      && values.length > 0
      && values.every(value => Number.isFinite(value))
      && (expectedDimension === undefined || values.length === expectedDimension);
  }

  private sameFingerprint(stat: fs.Stats, expected: MemoryIndexDeltaFingerprint): boolean {
    return stat.mtimeMs === expected.mtimeMs && stat.size === expected.size && stat.ino === expected.ino;
  }

  private laneFor(relativePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/');
    if (normalized.startsWith('ledger/')) return 'ledger';
    if (normalized.startsWith('episodes/')) return 'episode';
    if (normalized.startsWith('digest/') || normalized.startsWith('digests/')) return 'digest';
    if (normalized.startsWith('archive/')) return 'archive';
    return 'narrative';
  }

  private createdAtFor(relativePath: string, absolutePath: string): string {
    const normalized = relativePath.replace(/\\/g, '/');
    const match = normalized.match(/^memory\/(\d{4}-\d{2}-\d{2})\.md$/);
    if (match) return `${match[1]}T00:00:00.000Z`;
    return fs.statSync(absolutePath).mtime.toISOString();
  }

  private globMarkdown(dir: string): string[] {
    const result: string[] = [];
    if (!fs.existsSync(dir)) return result;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...this.globMarkdown(full));
      } else if (entry.name.endsWith('.md')) {
        result.push(full);
      }
    }
    return result;
  }
}
