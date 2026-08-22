export interface FactRecord {
  id: string;
  profileId: string;
  entity: string;
  type: string;
  version: number;
  supersedes?: string;
  supersededBy?: string;
  status: string;
  fields: Record<string, string | number | string[]>;
  safetyRelevant: boolean;
  // v2-M-2 (specs/07 §4 DDL): first-class columns recall scoring needs.
  // `authority` = provenance.source (drives D7 authorityRank); `confidence` = provenance.confidence.
  // Kept as loose strings/number so the port stays decoupled from memcore's Authority enum.
  authority: string;
  confidence: number;
  episodeId?: string;
  createdAt: string;
}

export interface FactMirror {
  upsert(facts: FactRecord[]): Promise<void>;
  queryActive(type?: string, entity?: string): AsyncIterable<FactRecord>;
  /** Paused facts (recall Stage 1 injects these with their `pre_pause_summary` — KNEE-08). */
  queryPaused(type?: string): AsyncIterable<FactRecord>;
  /**
   * The current head (max version, version >= 1) per entity across ALL statuses — the substrate
   * recall Stage 2 uses to suppress chunks whose entity has a newer active version (CONTRA-10)
   * or a terminal head (retracted/discontinued/superseded → stale fail-closed, KNEE-10). Unlike
   * `queryActive`, this surfaces terminal heads, so the engine can tell "entity went stale" from
   * "entity never existed" (a discontinued naproxen head vs a pure-narrative mention).
   */
  queryEntityHeads(): AsyncIterable<FactRecord>;
  rebuild(all: FactRecord[]): Promise<void>;
}
