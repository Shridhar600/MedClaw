import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  AUTHORITY_RANK, ConfirmationToken, FactStatus, FactType, LedgerFact,
  Provenance, RecordFactResult, RetractResult, StoredToken, TYPE_TO_FILE,
} from './types';
import { parseLedgerFile, renderLedgerFile } from './ledger-parser';

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function makeToken(entity: string, changeHash: string): ConfirmationToken {
  return {
    uuid: createHash('sha256').update(`${entity}:${changeHash}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12),
    entityId: entity,
    changeHash,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    singleUse: true as const,
  };
}

function isMedOrAllergy(t: FactType): boolean {
  return t === 'medication' || t === 'allergy';
}

interface RecordFactParams {
  entity: string;
  type: FactType;
  fields: Record<string, string | number | string[]>;
  provenance: Provenance;
  safetyRelevant?: boolean;
  episodeId?: string;
  language?: string;
  verbatim?: string;
  visibility?: string;
  resume?: boolean;
}

export class LedgerStore {
  private tokens = new Map<string, StoredToken>();

  constructor(private rootDir: string) {}

  private filePath(type: FactType): string {
    const name = TYPE_TO_FILE[type];
    return path.join(this.rootDir, 'ledger', name);
  }

  private async readFacts(type: FactType): Promise<LedgerFact[]> {
    const fp = this.filePath(type);
    try {
      const content = await fs.promises.readFile(fp, 'utf-8');
      return parseLedgerFile(content, { type, profileId: path.basename(this.rootDir) });
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return [];
      throw err;
    }
  }

  private async writeFacts(type: FactType, facts: LedgerFact[]): Promise<void> {
    const fp = this.filePath(type);
    await fs.promises.mkdir(path.dirname(fp), { recursive: true });
    const content = renderLedgerFile(facts);
    const tmpPath = fp + '.tmp';
    await fs.promises.writeFile(tmpPath, content, 'utf-8');
    await fs.promises.rename(tmpPath, fp);
  }

  private nextVersion(facts: LedgerFact[], entity: string): number {
    const entityFacts = facts.filter(f => f.entity === entity);
    if (entityFacts.length === 0) return 1;
    return Math.max(...entityFacts.map(f => f.version)) + 1;
  }

  private activeVersion(facts: LedgerFact[], entity: string): LedgerFact | null {
    const active = facts.filter(f => f.entity === entity && f.status === 'active');
    if (active.length === 0) return null;
    active.sort((a, b) => b.version - a.version);
    return active[0];
  }

  private pausedVersion(facts: LedgerFact[], entity: string): LedgerFact | null {
    const paused = facts.filter(f => f.entity === entity && f.status === 'paused');
    if (paused.length === 0) return null;
    paused.sort((a, b) => b.version - a.version);
    return paused[0];
  }

  private conflictsWith(cur: LedgerFact, fields: Record<string, string | number | string[]>): boolean {
    for (const [key, value] of Object.entries(fields)) {
      if (key in cur.fields) {
        const oldVal = cur.fields[key];
        if (JSON.stringify(oldVal) !== JSON.stringify(value)) return true;
      }
    }
    return false;
  }

  private makeFact(
    params: RecordFactParams,
    version: number,
    status: FactStatus,
    now: string,
    current?: LedgerFact,
    fieldsOverride?: Record<string, string | number | string[]>,
  ): LedgerFact {
    const fields = fieldsOverride || { ...params.fields };
    const pf: Provenance = {
      source: params.provenance.source,
      confidence: params.provenance.confidence,
      anchor: params.provenance.anchor,
      capturedAt: now,
      note: params.provenance.note,
    };

    return {
      id: `${params.entity}@v${version}`,
      profileId: path.basename(this.rootDir),
      entity: params.entity,
      type: params.type,
      version,
      supersedes: current?.id,
      status,
      fields,
      provenance: pf,
      safetyRelevant: params.safetyRelevant ?? false,
      episodeId: params.episodeId,
      language: params.language || 'en',
      verbatim: params.verbatim,
      visibility: (params.visibility as 'private' | 'shareable-summary' | 'shareable-full') || 'private',
      createdAt: now,
    };
  }

  async recordFact(params: RecordFactParams): Promise<RecordFactResult> {
    const allFacts = await this.readFacts(params.type);
    const active = this.activeVersion(allFacts, params.entity);
    const cur = active || this.pausedVersion(allFacts, params.entity);
    const now = new Date().toISOString();

    if (!cur) {
      const fact = this.makeFact(params, 1, 'active', now);
      allFacts.push(fact);
      await this.writeFacts(params.type, allFacts);
      return { kind: 'applied', fact };
    }

    if (cur.status === 'paused' && !params.resume) {
      const fields = { ...params.fields };
      const pps = cur.fields['pre_pause_summary'];
      if (pps !== undefined) {
        fields.pre_pause_summary = pps;
      }
      const v = this.nextVersion(allFacts, params.entity);
      const proposed = this.makeFact(params, v, 'paused', now, cur, fields);
      const changeHash = hash(`${params.entity}:${params.type}:${JSON.stringify(params.fields)}`);
      const token = makeToken(params.entity, changeHash);
      this.tokens.set(token.uuid, { token, op: { kind: 'write', ...params, fields }, used: false });
      return { kind: 'needs-confirmation', token, current: cur, proposed };
    }

    if (!active) {
      // cur is paused and resume was requested: supersede the paused version with an active one
      const v = this.nextVersion(allFacts, params.entity);
      cur.status = 'superseded';
      const fact = this.makeFact(params, v, 'active', now, cur);
      allFacts.push(fact);
      await this.writeFacts(params.type, allFacts);
      return { kind: 'applied', fact };
    }

    const hasConflict = this.conflictsWith(active, params.fields);

    if (!hasConflict) {
      const v = this.nextVersion(allFacts, params.entity);
      active.status = 'superseded';
      const fact = this.makeFact(params, v, 'active', now, active);
      allFacts.push(fact);
      await this.writeFacts(params.type, allFacts);
      return { kind: 'applied', fact };
    }

    const provRank = AUTHORITY_RANK[params.provenance.source];
    const curRank = AUTHORITY_RANK[active.provenance.source];

    if (provRank > curRank) {
      const v = this.nextVersion(allFacts, params.entity);
      active.status = 'superseded';
      const fact = this.makeFact(params, v, 'active', now, active);
      allFacts.push(fact);
      await this.writeFacts(params.type, allFacts);
      return { kind: 'applied', fact };
    }

    if (provRank === curRank && !isMedOrAllergy(params.type)) {
      const vA = this.nextVersion(allFacts, params.entity);
      const vB = vA + 1;
      active.status = 'disputed';
      const disputeA = this.makeFact(params, vA, 'disputed', now, active);
      const disputeB: LedgerFact = {
        ...active,
        id: `${params.entity}@v${vB}`,
        version: vB,
        status: 'disputed',
        fields: { ...params.fields },
        provenance: { ...params.provenance, capturedAt: now },
        createdAt: now,
        supersedes: active.id,
      };
      allFacts.push(disputeA, disputeB);
      await this.writeFacts(params.type, allFacts);
      const changeHash = hash(`dispute:${params.entity}:${vA}:${vB}`);
      const token = makeToken(params.entity, changeHash);
      this.tokens.set(token.uuid, {
        token,
        op: { kind: 'dispute', entity: params.entity, type: params.type, versionA: vA, versionB: vB },
        used: false,
      });
      return { kind: 'disputed', versions: [disputeA, disputeB], disputeToken: token };
    }

    {
      const v = this.nextVersion(allFacts, params.entity);
      const proposed = this.makeFact(params, v, 'active', now, active);
      const changeHash = hash(`${params.entity}:${params.type}:${JSON.stringify(params.fields)}`);
      const token = makeToken(params.entity, changeHash);
      this.tokens.set(token.uuid, { token, op: { kind: 'write', ...params, fields: params.fields }, used: false });
      return { kind: 'needs-confirmation', token, current: active, proposed };
    }
  }

  async retract(params: {
    entity: string;
    type: FactType;
    provenance: Provenance;
  }): Promise<RetractResult> {
    const allFacts = await this.readFacts(params.type);
    const cur = this.activeVersion(allFacts, params.entity);
    if (!cur) {
      return { kind: 'applied', fact: null as unknown as LedgerFact };
    }

    const now = new Date().toISOString();
    if (cur.safetyRelevant) {
      const changeHash = hash(`retract:${params.entity}:${params.type}`);
      const token = makeToken(params.entity, changeHash);
      this.tokens.set(token.uuid, {
        token, op: { kind: 'retract', entity: params.entity, type: params.type, provenance: params.provenance }, used: false,
      });
      return { kind: 'needs-confirmation', fact: cur, token };
    }

    const v = this.nextVersion(allFacts, params.entity);
    cur.status = 'superseded';
    const fact: LedgerFact = {
      id: `${params.entity}@v${v}`,
      profileId: cur.profileId,
      entity: params.entity,
      type: params.type,
      version: v,
      supersedes: cur.id,
      status: 'retracted',
      fields: { ...cur.fields },
      provenance: { ...params.provenance, capturedAt: now },
      safetyRelevant: cur.safetyRelevant,
      episodeId: cur.episodeId,
      language: cur.language,
      verbatim: cur.verbatim,
      visibility: cur.visibility,
      createdAt: now,
    };
    allFacts.push(fact);
    await this.writeFacts(params.type, allFacts);
    return { kind: 'applied', fact };
  }

  async confirm(tokenId: string, options?: { winningVersion?: number }): Promise<LedgerFact> {
    const stored = this.tokens.get(tokenId);
    if (!stored) throw new Error(`CONFIRM_REJECTED: token ${tokenId} not found`);
    if (stored.used) throw new Error(`CONFIRM_REJECTED: token ${tokenId} already used`);
    if (new Date(stored.token.expiresAt) < new Date()) {
      throw new Error(`CONFIRM_REJECTED: token ${tokenId} expired at ${stored.token.expiresAt}`);
    }

    const op = stored.op;
    stored.used = true;

    if (op.kind === 'write') {
      const allFacts = await this.readFacts(op.type);
      const cur = this.activeVersion(allFacts, op.entity);
      if (!cur) throw new Error(`CONFIRM_REJECTED: no active version for ${op.entity}`);
      const now = new Date().toISOString();
      const v = this.nextVersion(allFacts, op.entity);
      let targetStatus: FactStatus = 'active';
      const writeFields = { ...op.fields };

      if (cur.status === 'paused') {
        targetStatus = 'paused';
        if (cur.fields['pre_pause_summary'] !== undefined && !(writeFields.pre_pause_summary !== undefined)) {
          writeFields.pre_pause_summary = cur.fields['pre_pause_summary'] as string;
        }
      } else {
        cur.status = 'superseded';
      }

      const rp: RecordFactParams = {
        entity: op.entity,
        type: op.type,
        fields: writeFields,
        provenance: op.provenance,
        safetyRelevant: op.safetyRelevant,
        episodeId: op.episodeId,
        language: op.language,
        verbatim: op.verbatim,
        visibility: op.visibility,
        resume: op.resume,
      };
      const fact = this.makeFact(rp, v, targetStatus, now, cur, writeFields);
      allFacts.push(fact);
      await this.writeFacts(op.type, allFacts);
      return fact;
    }

    if (op.kind === 'retract') {
      const allFacts = await this.readFacts(op.type);
      const cur = this.activeVersion(allFacts, op.entity);
      if (!cur) throw new Error(`CONFIRM_REJECTED: no active version for ${op.entity}`);
      const now = new Date().toISOString();
      const v = this.nextVersion(allFacts, op.entity);
      cur.status = 'superseded';
      const fact: LedgerFact = {
        id: `${op.entity}@v${v}`,
        profileId: cur.profileId,
        entity: op.entity,
        type: op.type,
        version: v,
        supersedes: cur.id,
        status: 'retracted',
        fields: { ...cur.fields },
        provenance: { ...op.provenance, capturedAt: now },
        safetyRelevant: cur.safetyRelevant,
        episodeId: cur.episodeId,
        language: cur.language,
        verbatim: cur.verbatim,
        visibility: cur.visibility,
        createdAt: now,
      };
      allFacts.push(fact);
      await this.writeFacts(op.type, allFacts);
      return fact;
    }

    if (op.kind === 'dispute') {
      const winningVersion = options?.winningVersion;
      if (!winningVersion) throw new Error(`CONFIRM_REJECTED: dispute requires winningVersion`);
      const allFacts = await this.readFacts(op.type);
      const loserVersion = winningVersion === op.versionA ? op.versionB : op.versionA;
      const winner = allFacts.find(f => f.entity === op.entity && f.version === winningVersion);
      const loser = allFacts.find(f => f.entity === op.entity && f.version === loserVersion);
      if (!winner || !loser) throw new Error(`CONFIRM_REJECTED: dispute versions not found`);
      winner.status = 'active';
      loser.status = 'superseded';
      await this.writeFacts(op.type, allFacts);
      return winner;
    }

    throw new Error(`CONFIRM_REJECTED: unknown op kind`);
  }

  async getActive(entity: string, type: FactType): Promise<LedgerFact | null> {
    const allFacts = await this.readFacts(type);
    return this.activeVersion(allFacts, entity);
  }

  async getChain(entity: string, type: FactType): Promise<LedgerFact[]> {
    const allFacts = await this.readFacts(type);
    const chain = allFacts.filter(f => f.entity === entity);
    chain.sort((a, b) => b.version - a.version);
    return chain;
  }

  async listByType(type: FactType): Promise<LedgerFact[]> {
    const allFacts = await this.readFacts(type);
    return allFacts.filter(f => f.status === 'active');
  }
}
