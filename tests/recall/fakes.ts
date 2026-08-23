// In-memory port fakes for RecallEngine unit tests (P2 Wave B). Not a *.test.ts — helpers only.
// Deterministic: the caller supplies exact vec/keyword scores so scoring goldens are reproducible
// (M-4 discipline — no live Ollama, injected clock).

import type {
  FactMirror, FactRecord, VectorIndex, KeywordIndex, ChunkWithScore, VectorStats,
  EmbeddingPort, ChunkStat, ChunkStatsWriter, Clock,
} from '../../src/ports';

export class FakeFactMirror implements FactMirror {
  constructor(private records: FactRecord[] = []) {}

  async upsert(facts: FactRecord[]): Promise<void> {
    for (const f of facts) {
      const i = this.records.findIndex(r => r.id === f.id);
      if (i >= 0) this.records[i] = f;
      else this.records.push(f);
    }
  }

  async *queryActive(type?: string, entity?: string): AsyncIterable<FactRecord> {
    for (const r of this.records) {
      if (r.status !== 'active' || r.version < 1) continue;
      if (type !== undefined && r.type !== type) continue;
      if (entity !== undefined && r.entity !== entity) continue;
      yield r;
    }
  }

  async *queryPaused(type?: string): AsyncIterable<FactRecord> {
    for (const r of this.records) {
      if (r.status !== 'paused' || r.version < 1) continue;
      if (type !== undefined && r.type !== type) continue;
      yield r;
    }
  }

  async *queryEntityHeads(): AsyncIterable<FactRecord> {
    // Deterministic head per entity (F11): version, then later createdAt, then higher id.
    const heads = new Map<string, FactRecord>();
    for (const r of this.records) {
      if (r.version < 1) continue;
      const cur = heads.get(r.entity);
      const wins = !cur || r.version > cur.version
        || (r.version === cur.version && r.createdAt > cur.createdAt)
        || (r.version === cur.version && r.createdAt === cur.createdAt && r.id > cur.id);
      if (wins) heads.set(r.entity, r);
    }
    for (const h of heads.values()) yield h;
  }

  async rebuild(all: FactRecord[]): Promise<void> {
    this.records = [...all];
  }
}

export class FakeVectorIndex implements VectorIndex {
  constructor(private hits: ChunkWithScore[] = []) {}
  async upsert(): Promise<void> {}
  async *queryKnn(_embedding: number[], k: number): AsyncIterable<ChunkWithScore> {
    let n = 0;
    for (const h of this.hits) {
      if (n++ >= k) break;
      yield h;
    }
  }
  async deleteByPath(): Promise<void> {}
  async stats(): Promise<VectorStats> {
    return { totalChunks: this.hits.length, dimension: 3 };
  }
}

export class FakeKeywordIndex implements KeywordIndex {
  constructor(private hits: ChunkWithScore[] = [], private throwOnMatch = false) {}
  async index(): Promise<void> {}
  async *match(_query: string, k: number): AsyncIterable<ChunkWithScore> {
    if (this.throwOnMatch) throw new Error('keyword match failed');
    let n = 0;
    for (const h of this.hits) {
      if (n++ >= k) break;
      yield h;
    }
  }
  async deleteByPath(): Promise<void> {}
}

export class FakeEmbedding implements EmbeddingPort {
  /** delayMs simulates a slow endpoint (for the 500ms timeout test); throwErr forces a throw. */
  constructor(private opts: { vector?: number[]; delayMs?: number; throwErr?: boolean } = {}) {}
  async embed(texts: string[]): Promise<number[][]> {
    if (this.opts.delayMs) await new Promise(r => setTimeout(r, this.opts.delayMs));
    if (this.opts.throwErr) throw new Error('embed failed');
    return texts.map(() => this.opts.vector ?? [0.1, 0.2, 0.3]);
  }
  async dim(): Promise<number> { return (this.opts.vector ?? [0.1, 0.2, 0.3]).length; }
  async modelId(): Promise<string> { return 'fake-embed'; }
}

export class FakeChunkStats implements ChunkStatsWriter {
  injected: string[] = [];
  used: Array<{ ids: string[]; at: string }> = [];
  private store = new Map<string, ChunkStat>();
  async bumpInjected(chunkIds: string[]): Promise<void> {
    this.injected.push(...chunkIds);
    for (const id of chunkIds) {
      const s = this.store.get(id) ?? { chunkId: id, injectedCount: 0, usedCount: 0 };
      s.injectedCount++;
      this.store.set(id, s);
    }
  }
  async bumpUsed(chunkIds: string[], at: string): Promise<void> {
    this.used.push({ ids: chunkIds, at });
    for (const id of chunkIds) {
      const s = this.store.get(id) ?? { chunkId: id, injectedCount: 0, usedCount: 0 };
      s.usedCount++;
      s.lastUsedAt = at;
      this.store.set(id, s);
    }
  }
  async get(chunkId: string): Promise<ChunkStat | null> {
    return this.store.get(chunkId) ?? null;
  }
  /** Pre-seed a chunk's counters (auto-mute tests). */
  seed(chunkId: string, injectedCount: number, usedCount: number): void {
    this.store.set(chunkId, { chunkId, injectedCount, usedCount });
  }
}

/** A ChunkStatsWriter whose reads throw — for the F8 resilience-granularity test. */
export class ThrowingChunkStats implements ChunkStatsWriter {
  async bumpInjected(): Promise<void> {}
  async bumpUsed(): Promise<void> {}
  async get(): Promise<ChunkStat | null> { throw new Error('stats read failed'); }
}

export function chunkHit(over: Partial<ChunkWithScore> & { id: string; score: number }): ChunkWithScore {
  return {
    path: over.path ?? `memory/${over.id}.md`,
    lane: over.lane ?? 'narrative',
    content: over.content ?? over.id,
    startLine: over.startLine ?? 1,
    endLine: over.endLine ?? 1,
    createdAt: over.createdAt ?? '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

export function fixedClock(iso: string): Clock {
  const frozen = new Date(iso);
  return { now: () => new Date(frozen.getTime()) };
}
