// src/memory/embeddings.ts
import type { LLMProvider } from '../providers/types';

export class EmbeddingService {
  constructor(private readonly provider: LLMProvider) {}

  async embed(text: string): Promise<number[]> {
    return this.provider.embed(text);
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.provider.embed(t)));
  }
}
