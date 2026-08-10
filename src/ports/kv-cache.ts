export interface KVCache {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  ttl(key: string): Promise<number | null>;
}
