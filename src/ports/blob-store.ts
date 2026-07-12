import { Readable } from 'stream';

export interface BlobStore {
  put(key: string, data: Buffer | Readable): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  list(prefix: string): AsyncIterable<string>;
  sweep(olderThan: Date): Promise<number>;
}
