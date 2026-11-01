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
  // First-class columns recall scoring needs. `authority` = provenance.source (drives authority
  // rank); `confidence` = provenance.confidence. Loose types keep the port decoupled from memcore.
  authority: string;
  confidence: number;
  episodeId?: string;
  createdAt: string;
}

export interface FactMirror {
  upsert(facts: FactRecord[]): Promise<void>;
  /** Replace the complete mirror projection for one ledger type in one transaction. */
  replaceType(type: string, facts: FactRecord[]): Promise<void>;
  /** Replace one type/entity scope in one transaction; optional for legacy adapters. */
  replaceScope?(type: string, entity: string, facts: FactRecord[]): Promise<void>;
  queryActive(type?: string, entity?: string): AsyncIterable<FactRecord>;
  /** Paused facts (recall Stage 1 injects these with their `pre_pause_summary`). */
  queryPaused(type?: string): AsyncIterable<FactRecord>;
  /**
   * The current lifecycle head (active winner preferred, then version, version >= 1) per
   * type/entity across ALL statuses. Recall Stage 2 uses it to suppress chunks whose entity has a
   * newer active version, or a terminal/disputed head (retracted, discontinued, superseded,
   * disputed: stale, fail-closed). Unlike `queryActive`, this surfaces terminal heads, so the engine
   * can tell "entity went stale" from "entity never existed".
   */
  queryEntityHeads(): AsyncIterable<FactRecord>;
  rebuild(all: FactRecord[]): Promise<void>;
}
