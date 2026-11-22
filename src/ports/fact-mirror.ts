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
  queryEntityHeads(): AsyncIterable<FactRecord>;
  rebuild(all: FactRecord[]): Promise<void>;
}
