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
  createdAt: string;
}

export interface FactMirror {
  upsert(facts: FactRecord[]): Promise<void>;
  queryActive(type?: string, entity?: string): AsyncIterable<FactRecord>;
  rebuild(all: FactRecord[]): Promise<void>;
}
