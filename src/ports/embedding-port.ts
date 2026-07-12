export interface EmbeddingPort {
  embed(texts: string[]): Promise<number[][]>;
  dim(): Promise<number>;
  modelId(): Promise<string>;
}
