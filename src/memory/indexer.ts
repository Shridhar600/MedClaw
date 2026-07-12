import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { LLMProvider } from '../providers/types';
import type { SqliteStore } from './sqlite-store';
import type { Chunk } from './types';

const CHUNK_SIZE_TOKENS = 400;
const OVERLAP_TOKENS = 80;

export class MemoryIndexer {
  private isIndexing = false;
  private dimensionProbed = false;
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
      if (!this.dimensionProbed) {
        await this.probeAndEnsureDimension();
        this.store.setEmbeddingModel(this.embeddingModelName);
        this.dimensionProbed = true;
      }

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
        await this.indexFile(relativePath);
      }
    } finally {
      this.isIndexing = false;
    }
  }

  async indexFile(relativePath: string): Promise<void> {
    if (!this.dimensionProbed) {
      await this.probeAndEnsureDimension();
      this.store.setEmbeddingModel(this.embeddingModelName);
      this.dimensionProbed = true;
    }
    const absolutePath = path.join(this.workspacePath, relativePath);
    const content = fs.readFileSync(absolutePath, 'utf-8');
    const hash = this.computeHash(content);

    const storedHash = this.store.getFileHash(relativePath);
    const storedModel = this.store.getEmbeddingModel();
    if (storedHash === hash && storedModel === this.embeddingModelName) {
      return;
    }

    const chunks = this.chunkContent(content, relativePath).filter(chunk => chunk.content.trim().length > 0);
    const preparedChunks: Chunk[] = [];
    let hadEmbeddingFailure = false;
    for (const chunk of chunks) {
      try {
        chunk.embedding = await this.embeddingProvider.embed(chunk.content);
      } catch (e) {
        console.warn(`[indexer] Failed to embed chunk ${chunk.id}:`, e);
        hadEmbeddingFailure = true;
      }
      preparedChunks.push(chunk);
    }

    const indexHash = hadEmbeddingFailure ? `embedding-partial:${hash}` : hash;
    this.store.replaceFileIndex(relativePath, preparedChunks, indexHash, this.embeddingModelName);
    console.log(`[indexer] Indexed ${relativePath} (${chunks.length} chunks)`);
  }

  private async probeAndEnsureDimension(): Promise<void> {
    try {
      const probe = await this.embeddingProvider.embed('test');
      this.store.ensureVecTable(probe.length);
    } catch {
      console.warn('[indexer] Could not probe embedding dimension, using default');
      this.store.ensureVecTable(768);
    }
  }

  private chunkContent(content: string, relativePath: string): Chunk[] {
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
          content: chunkContent,
          startLine: currentChunk.startLine,
          endLine: currentChunk.startLine + currentChunk.lines.length - 1,
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
        content: currentChunk.lines.join('\n'),
        startLine: currentChunk.startLine,
        endLine: currentChunk.startLine + currentChunk.lines.length - 1,
      });
    }

    return chunks;
  }

  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
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
