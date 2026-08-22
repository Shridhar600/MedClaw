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
  rebuild(all: FactRecord[]): Promise<void>;
}
