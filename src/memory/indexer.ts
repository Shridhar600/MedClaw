import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { LLMProvider } from '../providers/types';
import type { SqliteStore } from './sqlite-store';
import type { Chunk } from './types';
import { summarizeErrorForLog } from '../security';

const CHUNK_SIZE_TOKENS = 400;
const OVERLAP_TOKENS = 80;

export class MemoryIndexer {
  private isIndexing = false;
  private dimensionProbeState: 'unknown' | 'available' | 'unavailable' = 'unknown';
  private embeddingDimension: number | undefined;
  private readonly embeddingModelName: string;

  constructor(
    private readonly store: SqliteStore,
    private readonly embeddingProvider: LLMProvider,
    private readonly workspacePath: string,
    private readonly profileId: string = 'default',
  ) {
    this.embeddingModelName = embeddingProvider.modelName ?? 'unknown';
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
    await this.indexFileInternal(relativePath, dimensionAvailable);
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
    let hadEmbeddingFailure = false;
    const expectedDimension = _dimensionAvailable ? this.embeddingDimension : undefined;
    for (const chunk of chunks) {
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
    try {
      const probe = await this.embeddingProvider.embed('test');
      if (!this.isUsableEmbedding(probe, undefined)) throw new Error('invalid embedding dimension probe');
      this.store.ensureVecTable(probe.length);
      this.embeddingDimension = probe.length;
      this.dimensionProbeState = 'available';
      return true;
    } catch (e) {
      // A failed probe must not guess a dimension or mutate an existing vec table. The file
      // path can still be indexed for keyword recall, but its freshness checkpoint remains dirty.
      this.dimensionProbeState = 'unavailable';
      this.embeddingDimension = undefined;
      console.warn('[indexer] Could not probe embedding dimension; vector indexing deferred:', summarizeErrorForLog(e));
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
