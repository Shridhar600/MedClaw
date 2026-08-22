// src/indexstore/fact-record.ts
//
// Pure mapping LedgerFact (memcore domain) -> FactRecord (ports). Used by both the live
// write-path mirror population and the rebuild-from-Markdown path. Type-only memcore import
// keeps the sqlite adapter itself decoupled from the domain (D5 carve-out — type contracts only).

import type { LedgerFact } from '../memcore';
import type { FactRecord } from '../ports';

/** Flatten a LedgerFact into the mirror's FactRecord shape (v2-M-2: authority/confidence/episodeId first-class). */
export function ledgerFactToRecord(f: LedgerFact): FactRecord {
  return {
    id: f.id,
    profileId: f.profileId,
    entity: f.entity,
    type: f.type,
    version: f.version,
    supersedes: f.supersedes,
    supersededBy: f.supersededBy,
    status: f.status,
    fields: f.fields,
    safetyRelevant: f.safetyRelevant,
    authority: f.provenance.source,
    confidence: f.provenance.confidence,
    episodeId: f.episodeId,
    createdAt: f.createdAt,
  };
}
