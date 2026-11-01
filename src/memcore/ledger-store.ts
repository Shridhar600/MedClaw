import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { isUtf8 } from 'node:buffer';
import {
  AUTHORITY_RANK, ConfirmationToken, FactStatus, FactType, LedgerFact,
  ConfirmationContext, LedgerMutationResult, PendingOp, Provenance, RecordFactResult, RetractResult, StoredToken, TYPE_TO_FILE,
} from './types';
import { parseLedgerFile, renderLedgerFile, canonicalFields } from './ledger-parser';
import { normalizeEntitySlug, sanitizeSingleLine } from './sanitize';
import { TokenRejectedError } from './token-errors';
import { LedgerUnreadableError, ParseQuarantineError } from '../shared/errors';
import { secureWrite, secureWriteViaTmp, secureMkdir, secureChmodFile, summarizeErrorForLog, resolveContainedPath } from '../security';
import type { Clock } from '../ports';
import { systemClock } from '../ports';

export interface LedgerIndexChunk {
  id: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface LedgerIndexDelta {
  hash: string;
  fingerprint?: LedgerFileFingerprint;
  entities: string[];
  chunks: LedgerIndexChunk[];
}

export interface LedgerFileFingerprint {
  mtimeMs: number;
  size: number;
  ino: number;
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function makeToken(entity: string, changeHash: string, nowMs: number): ConfirmationToken {
  return {
    uuid: createHash('sha256').update(`${entity}:${changeHash}:${nowMs}:${Math.random()}`).digest('hex').slice(0, 12),
    entityId: entity,
    changeHash,
    expiresAt: new Date(nowMs + 15 * 60 * 1000).toISOString(),
    singleUse: true as const,
  };
}

function isMedOrAllergy(t: FactType): boolean {
  return t === 'medication' || t === 'allergy';
}

function requireEntitySlug(value: unknown): string {
  const entity = normalizeEntitySlug(value);
  if (entity === null) throw new Error('invalid-entity-slug');
  return entity;
}

function normalizeOptionalReference(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const reference = normalizeEntitySlug(value);
  if (reference === null) throw new Error('invalid-cross-link');
  return reference;
}

function factSnapshotHash(fact: LedgerFact): string {
  return hash(`${fact.id}:${JSON.stringify(canonicalFields(fact.fields))}`);
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
  replaces?: string;
  replacedBy?: string;
  corrects?: string;
  correctedBy?: string;
}

interface LedgerFactsCache {
  fingerprint: LedgerFileFingerprint;
  facts: LedgerFact[];
}

export class LedgerStore {
  private tokens = new Map<string, StoredToken>();
  private readonly factsCache = new Map<FactType, LedgerFactsCache>();
  private readonly pendingIndexDeltas = new Map<FactType, LedgerIndexDelta[]>();
  /** Damaged files by type; each fingerprint was preserved as a `.corrupt-` copy. */
  private readonly damaged = new Map<FactType, LedgerFileFingerprint>();

  constructor(private rootDir: string, private clock: Clock = systemClock) {
    secureMkdir(rootDir);
  }

  private filePath(type: FactType): string {
    const name = TYPE_TO_FILE[type];
    return resolveContainedPath(this.rootDir, 'ledger', name);
  }

  private async readFacts(type: FactType): Promise<LedgerFact[]> {
    const fp = this.filePath(type);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fp);
    } catch (err: unknown) {
      this.invalidateFactsCache(type);
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        this.damaged.delete(type);
        return [];
      }
      throw err;
    }
    if (!stat.isFile()) {
      this.invalidateFactsCache(type);
      throw new Error('ledger source is not a regular file');
    }
    const fingerprint = this.fingerprint(stat);
    const cached = this.factsCache.get(type);
    if (cached && this.sameFingerprint(cached.fingerprint, fingerprint)) {
      try {
        const fd = fs.openSync(fp, 'r');
        fs.closeSync(fd);
        return this.cloneFacts(cached.facts);
      } catch (err) {
        this.invalidateFactsCache(type);
        throw err;
      }
    }
    this.invalidateFactsCache(type);

    let rawBytes: Buffer;
    try {
      rawBytes = await fs.promises.readFile(fp);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return [];
      throw err;
    }
    if (!isUtf8(rawBytes)) {
      console.warn('[ledger-store] invalid UTF-8 content; preserving bytes in quarantine');
      this.markDamaged(type, fp, rawBytes, fingerprint);
      return [];
    }
    const content = rawBytes.toString('utf8');
    const facts = parseLedgerFile(content, { type, profileId: path.basename(this.rootDir) });
    const hasQuarantineFact = facts.some((fact) => fact.version === 0 && fact.fields._quarantine !== undefined);
    // A damaged file stays readable but read-only until the owner repairs it.
    if ((facts.length === 0 && content.trim() !== '') || hasQuarantineFact) {
      this.markDamaged(type, fp, rawBytes, fingerprint);
      return facts.filter((fact) => fact.version >= 1 && fact.fields._quarantine === undefined);
    }
    this.damaged.delete(type);
    this.factsCache.set(type, { fingerprint, facts: this.cloneFacts(facts) });
    return this.cloneFacts(facts);
  }

  private markDamaged(type: FactType, fp: string, rawBytes: Buffer, fingerprint: LedgerFileFingerprint): void {
    const known = this.damaged.get(type);
    if (known && this.sameFingerprint(known, fingerprint)) return;
    if (!this.quarantineCorruptFile(fp, rawBytes)) {
      throw new ParseQuarantineError('ledger source could not be quarantined safely');
    }
    this.damaged.set(type, fingerprint);
  }

  private async readForChange(type: FactType): Promise<LedgerFact[]> {
    const facts = await this.readFacts(type);
    if (this.damaged.has(type)) throw new LedgerUnreadableError();
    return facts;
  }

  damagedFiles(): string[] {
    return [...this.damaged.keys()].map((type) => TYPE_TO_FILE[type]);
  }

  private quarantineCorruptFile(fp: string, rawBytes: Buffer): boolean {
    try {
      const sidecar = `${fp}.corrupt-${this.clock.now().getTime()}`;
      secureWrite(sidecar, rawBytes);
      secureChmodFile(sidecar);
      // PHI-safe: log the file basename (a type name) only, never the content.
      console.warn(`[ledger-store] quarantined unparseable ledger file ${path.basename(fp)} to a .corrupt sidecar`);
      return true;
    } catch (err) {
      console.warn(`[ledger-store] ledger quarantine failed: ${summarizeErrorForLog(err)}`);
      return false;
    }
  }

  private async writeFacts(type: FactType, facts: LedgerFact[], deltaFacts: LedgerFact[] = []): Promise<void> {
    let rendered: string;
    try {
      LedgerStore.reconcileReverseLinks(facts);
      rendered = renderLedgerFile(facts);
      secureWriteViaTmp(this.filePath(type), rendered);
    } catch (err) {
      this.factsCache.delete(type);
      throw err;
    }

    let fingerprint: LedgerFileFingerprint | undefined;
    try {
      const stat = fs.statSync(this.filePath(type));
      if (!stat.isFile()) throw new Error('ledger source is not a regular file');
      fingerprint = this.fingerprint(stat);
      this.factsCache.set(type, { fingerprint, facts: this.cloneFacts(this.orderFacts(facts)) });
    } catch (err) {
      this.factsCache.delete(type);
      console.warn(`[ledger-store] write metadata unavailable for ${TYPE_TO_FILE[type]}: ${summarizeErrorForLog(err)}`);
    }

    const chunks = deltaFacts.map((fact) => this.indexChunk(type, fact, rendered));
    const delta: LedgerIndexDelta = {
      hash: createHash('sha256').update(rendered).digest('hex'),
      fingerprint,
      entities: [...new Set(deltaFacts.map((fact) => fact.entity))],
      chunks,
    };
    const pending = this.pendingIndexDeltas.get(type) ?? [];
    pending.push(delta);
    this.pendingIndexDeltas.set(type, pending);
  }

  /** One-shot: consuming clears the queued deltas. */
  takeIndexDelta(type: FactType): LedgerIndexDelta | undefined {
    const pending = this.pendingIndexDeltas.get(type);
    if (!pending || pending.length === 0) return undefined;
    this.pendingIndexDeltas.delete(type);
    const last = pending[pending.length - 1];
    return {
      hash: last.hash,
      fingerprint: last.fingerprint,
      entities: [...new Set(pending.flatMap(delta => delta.entities))],
      chunks: pending.flatMap(delta => delta.chunks),
    };
  }

  private indexChunk(type: FactType, fact: LedgerFact, rendered: string): LedgerIndexChunk {
    const content = renderLedgerFile([fact]).trimEnd();
    const entityHeader = `## ${sanitizeSingleLine(fact.entity)}\n`;
    const sectionStart = rendered.indexOf(entityHeader);
    const versionBlock = content.startsWith(entityHeader) ? content.slice(entityHeader.length) : content;
    const versionStart = sectionStart >= 0
      ? rendered.indexOf(versionBlock, sectionStart + entityHeader.length)
      : -1;
    const startOffset = sectionStart >= 0 ? sectionStart : (versionStart >= 0 ? versionStart : 0);
    const startLine = rendered.slice(0, startOffset).split('\n').length;
    return {
      id: `ledger/${TYPE_TO_FILE[type]}:delta:${fact.id}`,
      content,
      startLine,
      endLine: startLine + content.split(/\r\n|\n|\r/).length - 1,
    };
  }

  private fingerprint(stat: fs.Stats): LedgerFileFingerprint {
    return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
  }

  private sameFingerprint(left: LedgerFileFingerprint, right: LedgerFileFingerprint): boolean {
    return left.mtimeMs === right.mtimeMs && left.size === right.size && left.ino === right.ino;
  }

  private cloneFacts(facts: LedgerFact[]): LedgerFact[] {
    return facts.map((fact) => ({
      ...fact,
      fields: Object.fromEntries(Object.entries(fact.fields).map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value] : value,
      ])),
      provenance: { ...fact.provenance },
    }));
  }

  private orderFacts(facts: LedgerFact[]): LedgerFact[] {
    return [...facts].sort((left, right) =>
      left.entity.localeCompare(right.entity) || right.version - left.version,
    );
  }

  private invalidateFactsCache(type: FactType): void {
    this.factsCache.delete(type);
    this.pendingIndexDeltas.delete(type);
  }

  // Anchored at the source fact's createdAt, so a later version never becomes the link target.
  private static resolveByName(facts: LedgerFact[], entity: string, source: LedgerFact): LedgerFact | undefined {
    const byEntity = new Map<string, LedgerFact[]>();
    for (const f of facts) {
      const arr = byEntity.get(f.entity);
      if (arr) arr.push(f); else byEntity.set(f.entity, [f]);
    }
    const versions = byEntity.get(entity);
    if (!versions) return undefined;

    const asOf = new Date(source.createdAt).getTime();
    const eligible = versions.filter((version) => {
      const createdAt = new Date(version.createdAt).getTime();
      return Number.isNaN(asOf) || Number.isNaN(createdAt) || createdAt <= asOf;
    });
    if (eligible.length === 0) return undefined;

    const compare = (left: LedgerFact, right: LedgerFact): number => {
      const leftTime = new Date(left.createdAt).getTime();
      const rightTime = new Date(right.createdAt).getTime();
      if (!Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      if (!Number.isNaN(leftTime) !== !Number.isNaN(rightTime)) {
        return Number.isNaN(leftTime) ? -1 : 1;
      }
      if (left.version !== right.version) return left.version - right.version;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    };

    return eligible.reduce((best, candidate) => compare(candidate, best) > 0 ? candidate : best);
  }

  private static resolveReference(facts: LedgerFact[], reference: string, source: LedgerFact): LedgerFact | undefined {
    return new Map(facts.map((fact) => [fact.id, fact])).get(reference)
      ?? LedgerStore.resolveByName(facts, reference, source);
  }

  // Reverse links are single-valued: the last same-file source in append order wins.
  private static reconcileReverseLinks(facts: LedgerFact[]): void {
    const byId = new Map(facts.map(f => [f.id, f]));
    const stamp = (ref: string | undefined, source: LedgerFact, field: 'replacedBy' | 'correctedBy'): void => {
      if (!ref) return;
      const target = byId.get(ref) ?? LedgerStore.resolveByName(facts, ref, source);
      if (!target || target.id === source.id) throw new Error('unresolved-cross-link');
      target[field] = source.id;
    };
    for (const fact of facts) {
      if (fact.supersedes) {
        const previous = byId.get(fact.supersedes);
        if (previous && previous.id !== fact.id) previous.supersededBy = fact.id;
      }
      stamp(fact.replaces, fact, 'replacedBy');
      stamp(fact.corrects, fact, 'correctedBy');
    }
  }

  private nextVersion(facts: LedgerFact[], entity: string): number {
    const entityFacts = facts.filter(f => f.entity === entity);
    if (entityFacts.length === 0) return 1;
    return Math.max(...entityFacts.map(f => f.version)) + 1;
  }

  private activeVersion(facts: LedgerFact[], entity: string): LedgerFact | null {
    // v0 facts are quarantine sentinels, never active.
    const active = facts.filter(f => f.entity === entity && f.status === 'active' && f.version >= 1);
    if (active.length === 0) return null;
    if (active.length > 1) throw new Error('multiple-active-versions');
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
    // Compare canonical forms: a re-typed number never counts as a conflict.
    const canonicalCur = canonicalFields(cur.fields);
    for (const [key, value] of Object.entries(fields)) {
      if (key in canonicalCur) {
        const oldVal = canonicalCur[key];
        if (JSON.stringify(oldVal) !== JSON.stringify(canonicalFields({ [key]: value })[key])) return true;
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
    preserveCurrentProvenance = false,
  ): LedgerFact {
    // Merge onto the current fields so carried fields are never dropped.
    const fields = fieldsOverride
      ? fieldsOverride
      : (current ? { ...current.fields, ...params.fields } : { ...params.fields });
    const keepProvenance = Boolean(
      preserveCurrentProvenance && current
      && AUTHORITY_RANK[params.provenance.source] < AUTHORITY_RANK[current.provenance.source],
    );
    const pf: Provenance = keepProvenance
      ? { ...current!.provenance }
      : { ...params.provenance, capturedAt: now };

    return {
      id: `${params.entity}@v${version}`,
      profileId: path.basename(this.rootDir),
      entity: params.entity,
      type: params.type,
      version,
      supersedes: current?.id,
      replaces: params.replaces,
      replacedBy: params.replacedBy,
      corrects: params.corrects,
      correctedBy: params.correctedBy,
      status,
      fields,
      provenance: pf,
      // Med/allergy are always safety-relevant, regardless of any caller or model flag.
      safetyRelevant: isMedOrAllergy(params.type) || current?.safetyRelevant === true || params.safetyRelevant === true,
      episodeId: params.episodeId ?? current?.episodeId,
      language: params.language ?? current?.language ?? 'en',
      verbatim: params.verbatim ?? current?.verbatim,
      visibility: (params.visibility as 'private' | 'shareable-summary' | 'shareable-full' | undefined)
        ?? current?.visibility ?? 'private',
      createdAt: now,
    };
  }

  async recordFact(params: RecordFactParams): Promise<RecordFactResult> {
    const p: RecordFactParams = {
      ...params,
      entity: requireEntitySlug(params.entity),
      replaces: normalizeOptionalReference(params.replaces),
      replacedBy: normalizeOptionalReference(params.replacedBy),
      corrects: normalizeOptionalReference(params.corrects),
      correctedBy: normalizeOptionalReference(params.correctedBy),
    };
    const allFacts = await this.readForChange(p.type);
    const active = this.activeVersion(allFacts, p.entity);
    const cur = active || this.pausedVersion(allFacts, p.entity);
    const now = this.clock.now().toISOString();

    if (!cur) {
      const reopened = this.reopenDispute(allFacts, p.entity, p.type);
      if (reopened) return reopened;
      // Only terminal versions remain: start a new active version on the same chain.
      const fact = this.makeFact(p, this.nextVersion(allFacts, p.entity), 'active', now);
      allFacts.push(fact);
      await this.writeFacts(p.type, allFacts, [fact]);
      return { kind: 'applied', fact };
    }

    if (cur.status === 'paused' && !p.resume) {
      const fields = { ...p.fields };
      const pps = cur.fields['pre_pause_summary'];
      if (pps !== undefined) {
        fields.pre_pause_summary = pps;
      }
      const v = this.nextVersion(allFacts, p.entity);
      const proposed = this.makeFact(p, v, 'paused', now, cur, fields);
      const changeHash = hash(`${p.entity}:${p.type}:${JSON.stringify(canonicalFields(p.fields))}`);
      // Snapshot the current fact so confirm() can detect state drift.
      const baselineCurHash = factSnapshotHash(cur);
      const token = makeToken(p.entity, changeHash, this.clock.now().getTime());
      this.tokens.set(token.uuid, { token, op: { kind: 'write', ...p, fields, baselineCurHash }, used: false });
      return { kind: 'needs-confirmation', token, current: cur, proposed };
    }

    if (!active) {
      // The resume flag must never bypass the med/allergy confirmation gate.
      if (isMedOrAllergy(p.type)) {
        const v = this.nextVersion(allFacts, p.entity);
        const proposed = this.makeFact(p, v, 'active', now, cur);
        const changeHash = hash(`resume:${p.entity}:${p.type}:${JSON.stringify(canonicalFields(p.fields))}`);
        const baselineCurHash = factSnapshotHash(cur);
        const token = makeToken(p.entity, changeHash, this.clock.now().getTime());
        this.tokens.set(token.uuid, { token, op: { kind: 'write', ...p, baselineCurHash }, used: false });
        return { kind: 'needs-confirmation', token, current: cur, proposed };
      }
      const v = this.nextVersion(allFacts, p.entity);
      cur.status = 'superseded';
      const fact = this.makeFact(p, v, 'active', now, cur);
      allFacts.push(fact);
      await this.writeFacts(p.type, allFacts, [fact]);
      return { kind: 'applied', fact };
    }

    const hasConflict = this.conflictsWith(active, p.fields);

    if (!hasConflict) {
      const v = this.nextVersion(allFacts, p.entity);
      active.status = 'superseded';
      const fact = this.makeFact(p, v, 'active', now, active, undefined, true);
      allFacts.push(fact);
      await this.writeFacts(p.type, allFacts, [fact]);
      return { kind: 'applied', fact };
    }

    const provRank = AUTHORITY_RANK[p.provenance.source];
    const curRank = AUTHORITY_RANK[active.provenance.source];

    // A conflicting med/allergy change always needs confirmation, whatever the provenance rank.
    if (provRank > curRank && !isMedOrAllergy(p.type)) {
      const v = this.nextVersion(allFacts, p.entity);
      active.status = 'superseded';
      const fact = this.makeFact(p, v, 'active', now, active);
      allFacts.push(fact);
      await this.writeFacts(p.type, allFacts, [fact]);
      return { kind: 'applied', fact };
    }

    if (provRank === curRank && !isMedOrAllergy(p.type)) {
      const vA = this.nextVersion(allFacts, p.entity);
      const vB = vA + 1;
      active.status = 'disputed';
      // Head A carries the new claim; head B preserves the old one verbatim.
      const disputeA = this.makeFact(p, vA, 'disputed', now, active, { ...active.fields, ...p.fields });
      const disputeB: LedgerFact = {
        ...active,
        id: `${p.entity}@v${vB}`,
        version: vB,
        status: 'disputed',
        createdAt: now,
        supersedes: active.id,
      };
      allFacts.push(disputeA, disputeB);
      await this.writeFacts(p.type, allFacts, [disputeA, disputeB]);
      const changeHash = hash(`dispute:${p.entity}:${vA}:${vB}`);
      const token = makeToken(p.entity, changeHash, this.clock.now().getTime());
      this.tokens.set(token.uuid, {
        token,
        op: { kind: 'dispute', entity: p.entity, type: p.type, versionA: vA, versionB: vB, originalId: active.id },
        used: false,
      });
      return { kind: 'disputed', versions: [disputeA, disputeB], disputeToken: token };
    }

    {
      const v = this.nextVersion(allFacts, p.entity);
      const proposed = this.makeFact(p, v, 'active', now, active);
      const changeHash = hash(`${p.entity}:${p.type}:${JSON.stringify(canonicalFields(p.fields))}`);
      // Snapshot the current fact so confirm() can detect state drift.
      const baselineCurHash = factSnapshotHash(active);
      const token = makeToken(p.entity, changeHash, this.clock.now().getTime());
      this.tokens.set(token.uuid, { token, op: { kind: 'write', ...p, fields: p.fields, baselineCurHash }, used: false });
      return { kind: 'needs-confirmation', token, current: active, proposed };
    }
  }

  /** Re-offers an unresolved disputed pair with a fresh token after expiry or restart. */
  private reopenDispute(facts: LedgerFact[], entity: string, type: FactType): RecordFactResult | null {
    const heads = facts
      .filter(f => f.entity === entity && f.status === 'disputed' && f.version >= 1)
      .sort((a, b) => b.version - a.version)
      .slice(0, 2);
    if (heads.length < 2) return null;
    const [headB, headA] = heads;
    const token = makeToken(entity, hash(`dispute:${entity}:${headA.version}:${headB.version}`), this.clock.now().getTime());
    this.tokens.set(token.uuid, {
      token,
      op: { kind: 'dispute', entity, type, versionA: headA.version, versionB: headB.version, originalId: headA.supersedes ?? '' },
      used: false,
    });
    return { kind: 'disputed', versions: [headA, headB], disputeToken: token, reopened: true };
  }

  async retract(params: {
    entity: string;
    type: FactType;
    provenance: Provenance;
  }): Promise<RetractResult> {
    const entity = requireEntitySlug(params.entity);
    const allFacts = await this.readForChange(params.type);
    const cur = this.activeVersion(allFacts, entity);
    if (!cur) {
      return { kind: 'noop', reason: 'no-active-version' };
    }

    const now = this.clock.now().toISOString();
    // Safety-relevant and all med/allergy facts need confirmation to retract.
    if (cur.safetyRelevant || isMedOrAllergy(cur.type)) {
      const changeHash = hash(`retract:${entity}:${params.type}`);
      const baselineCurHash = factSnapshotHash(cur);
      const token = makeToken(entity, changeHash, this.clock.now().getTime());
      this.tokens.set(token.uuid, {
        token,
        op: { kind: 'retract', entity, type: params.type, provenance: params.provenance, baselineCurHash },
        used: false,
      });
      return { kind: 'needs-confirmation', fact: cur, token };
    }

    const v = this.nextVersion(allFacts, entity);
    cur.status = 'superseded';
    const fact: LedgerFact = {
      id: `${entity}@v${v}`,
      profileId: cur.profileId,
      entity,
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
    await this.writeFacts(params.type, allFacts, [fact]);
    return { kind: 'applied', fact };
  }

  private latestDiscontinued(facts: LedgerFact[], entity: string): LedgerFact | null {
    const d = facts.filter(f => f.entity === entity && f.status === 'discontinued');
    if (d.length === 0) return null;
    d.sort((a, b) => b.version - a.version);
    return d[0];
  }

  private async applyDiscontinue(
    allFacts: LedgerFact[], cur: LedgerFact, entity: string, type: FactType,
    provenance: Provenance, opts?: { reason?: string; replacedBy?: string },
  ): Promise<LedgerFact> {
    const now = this.clock.now().toISOString();
    const v = this.nextVersion(allFacts, entity);
    cur.status = 'superseded';
    const fact: LedgerFact = {
      id: `${entity}@v${v}`,
      profileId: cur.profileId,
      entity, type, version: v,
      supersedes: cur.id,
      replacedBy: opts?.replacedBy,
      status: 'discontinued',
      discontinuedReason: opts?.reason,
      fields: { ...cur.fields },
      provenance: { ...provenance, capturedAt: now },
      safetyRelevant: cur.safetyRelevant,
      episodeId: cur.episodeId,
      language: cur.language,
      verbatim: cur.verbatim,
      visibility: cur.visibility,
      createdAt: now,
    };
    allFacts.push(fact);
    await this.writeFacts(type, allFacts, [fact]);
    return fact;
  }

  /** Med/allergy discontinuation needs confirmation. */
  async discontinue(
    entity: string, type: FactType, provenance: Provenance,
    opts?: { reason?: string; replacedBy?: string },
  ): Promise<LedgerMutationResult> {
    entity = requireEntitySlug(entity);
    const allFacts = await this.readForChange(type);
    const cur = this.activeVersion(allFacts, entity);
    if (!cur) return { kind: 'noop', reason: 'no-active-version' };

    if (isMedOrAllergy(type)) {
      const changeHash = hash(`discontinue:${entity}:${type}`);
      const baselineCurHash = factSnapshotHash(cur);
      const token = makeToken(entity, changeHash, this.clock.now().getTime());
      this.tokens.set(token.uuid, {
        token,
        op: { kind: 'discontinue', entity, type, provenance, reason: opts?.reason, replacedBy: opts?.replacedBy, baselineCurHash },
        used: false,
      });
      return { kind: 'needs-confirmation', fact: cur, token };
    }

    const fact = await this.applyDiscontinue(allFacts, cur, entity, type, provenance, opts);
    return { kind: 'applied', fact };
  }

  private async applyRestart(
    allFacts: LedgerFact[], discontinued: LedgerFact, entity: string, type: FactType,
    provenance: Provenance, fields: Record<string, string | number | string[]>, restartOf: string,
  ): Promise<LedgerFact> {
    const now = this.clock.now().toISOString();
    const v = this.nextVersion(allFacts, entity);
    const fact: LedgerFact = {
      id: `${entity}@v${v}`,
      profileId: discontinued.profileId,
      entity, type, version: v,
      supersedes: discontinued.id,
      status: 'active',
      fields: { ...fields, restartOf },
      provenance: { ...provenance, capturedAt: now },
      safetyRelevant: discontinued.safetyRelevant,
      episodeId: discontinued.episodeId,
      language: discontinued.language,
      verbatim: discontinued.verbatim,
      visibility: discontinued.visibility,
      createdAt: now,
    };
    allFacts.push(fact);
    await this.writeFacts(type, allFacts, [fact]);
    return fact;
  }

  /** Med/allergy restarts need confirmation. */
  async restart(
    entity: string, type: FactType, provenance: Provenance,
    fields: Record<string, string | number | string[]>,
  ): Promise<LedgerMutationResult> {
    entity = requireEntitySlug(entity);
    const allFacts = await this.readForChange(type);
    if (this.activeVersion(allFacts, entity)) return { kind: 'noop', reason: 'already-active' };
    const discontinued = this.latestDiscontinued(allFacts, entity);
    if (!discontinued) return { kind: 'noop', reason: 'no-discontinued-version' };

    if (isMedOrAllergy(type)) {
      const changeHash = hash(`restart:${entity}:${type}`);
      const baselineCurHash = factSnapshotHash(discontinued);
      const token = makeToken(entity, changeHash, this.clock.now().getTime());
      this.tokens.set(token.uuid, {
        token,
        op: { kind: 'restart', entity, type, provenance, fields: { ...fields }, restartOf: discontinued.id, baselineCurHash },
        used: false,
      });
      return { kind: 'needs-confirmation', fact: discontinued, token };
    }

    const fact = await this.applyRestart(allFacts, discontinued, entity, type, provenance, { ...fields }, discontinued.id);
    return { kind: 'applied', fact };
  }

  async pause(
    entity: string, type: FactType, provenance: Provenance,
    opts: { prePauseSummary: string },
  ): Promise<LedgerMutationResult> {
    entity = requireEntitySlug(entity);
    const allFacts = await this.readForChange(type);
    const active = this.activeVersion(allFacts, entity);
    if (!active) return { kind: 'noop', reason: 'no-active-version' };

    const now = this.clock.now().toISOString();
    const v = this.nextVersion(allFacts, entity);
    active.status = 'superseded';
    const fact: LedgerFact = {
      id: `${entity}@v${v}`,
      profileId: active.profileId,
      entity, type, version: v,
      supersedes: active.id,
      status: 'paused',
      fields: { ...active.fields, pre_pause_summary: opts.prePauseSummary },
      provenance: { ...provenance, capturedAt: now },
      safetyRelevant: active.safetyRelevant,
      episodeId: active.episodeId,
      language: active.language,
      verbatim: active.verbatim,
      visibility: active.visibility,
      createdAt: now,
    };
    allFacts.push(fact);
    await this.writeFacts(type, allFacts, [fact]);
    return { kind: 'applied', fact };
  }

  async getCrossLinks(entity: string, type: FactType): Promise<{
    replaces: string[]; replacedBy: string[]; corrects: string[]; correctedBy: string[];
  }> {
    entity = requireEntitySlug(entity);
    const allFacts = await this.readFacts(type);
    const entityFacts = allFacts.filter(f => f.entity === entity);
    const byId = new Map(allFacts.map((fact) => [fact.id, fact]));
    const isVerifiedForward = (source: LedgerFact, reference: string | undefined, target?: LedgerFact): boolean => {
      if (!reference) return false;
      const resolved = LedgerStore.resolveReference(allFacts, reference, source);
      return resolved !== undefined && resolved.id !== source.id && (!target || resolved.id === target.id);
    };
    const collectForward = (pick: (f: LedgerFact) => string | undefined): string[] => {
      const values = new Set<string>();
      for (const fact of entityFacts) {
        const reference = pick(fact);
        if (isVerifiedForward(fact, reference)) values.add(reference!);
      }
      return [...values];
    };
    const collectReverse = (
      pick: (f: LedgerFact) => string | undefined,
      forwardField: 'replaces' | 'corrects',
    ): string[] => {
      const values = new Set<string>();
      for (const target of entityFacts) {
        const sourceId = pick(target);
        const source = sourceId ? byId.get(sourceId) : undefined;
        if (source && isVerifiedForward(source, source[forwardField], target)) values.add(source.id);
      }
      return [...values];
    };
    return {
      replaces: collectForward(f => f.replaces),
      replacedBy: collectReverse(f => f.replacedBy, 'replaces'),
      corrects: collectForward(f => f.corrects),
      correctedBy: collectReverse(f => f.correctedBy, 'corrects'),
    };
  }

  /** Burns a declined token immediately instead of letting it linger until expiry. */
  declineToken(tokenId: string): void {
    const stored = this.tokens.get(tokenId);
    if (!stored) return;
    stored.used = true;
  }

  bindTokenContext(tokenId: string, context?: ConfirmationContext): void {
    if (!context) return;
    const stored = this.tokens.get(tokenId);
    if (stored && !stored.confirmationContext) stored.confirmationContext = { ...context };
  }

  async confirm(
    tokenId: string,
    options?: { winningVersion?: number },
    context?: ConfirmationContext,
  ): Promise<LedgerFact> {
    const stored = this.tokens.get(tokenId);
    if (!stored) throw new TokenRejectedError('token-not-found');
    if (stored.used) throw new TokenRejectedError('token-already-used');
    if (new Date(stored.token.expiresAt) < this.clock.now()) {
      throw new TokenRejectedError('token-expired');
    }
    if (stored.confirmationContext && context) {
      if (stored.confirmationContext.chatId && context.chatId
        && stored.confirmationContext.chatId !== context.chatId) {
        throw new TokenRejectedError('confirmation-context-mismatch');
      }
      if (stored.confirmationContext.turnId === context.turnId) {
        throw new TokenRejectedError('same-turn-confirm');
      }
    }

    const op = stored.op;
    // The token is burned only after the op succeeds, so a failed apply leaves it valid for retry.
    try {
      const fact = await this.applyConfirmOp(op, options);
      stored.used = true;
      return fact;
    } catch (e) {
      if (!(e instanceof TokenRejectedError)) {
        // Non-rejection failures are operational: log sanitized, keep token usable.
        console.warn(`[ledger-store] confirm op for token ${tokenId} failed (token remains valid): ${summarizeErrorForLog(e)}`);
      }
      throw e;
    }
  }

  /** Apply a confirmed op. Throws TokenRejectedError with PHI-free reasons on state mismatches. */
  private async applyConfirmOp(op: PendingOp, options?: { winningVersion?: number }): Promise<LedgerFact> {
    if (op.kind === 'write') {
      const allFacts = await this.readForChange(op.type);
      // A paused entity has no active version, so resolve either.
      const cur = this.activeVersion(allFacts, op.entity) ?? this.pausedVersion(allFacts, op.entity);
      if (!cur) throw new TokenRejectedError('no-active-version');
      // Confirming a token whose target moved would clobber a newer change.
      if (op.baselineCurHash !== undefined
        && factSnapshotHash(cur) !== op.baselineCurHash) {
        throw new TokenRejectedError('state-moved-since-proposal');
      }
      const now = this.clock.now().toISOString();
      const v = this.nextVersion(allFacts, op.entity);
      // Only an explicit resume reactivates a paused fact.
      const targetStatus: FactStatus = (cur.status === 'paused' && !op.resume) ? 'paused' : 'active';
      // Proposal keys win, but carried fields are kept.
      const writeFields = { ...cur.fields, ...op.fields };

      if (cur.status === 'paused'
        && cur.fields['pre_pause_summary'] !== undefined
        && writeFields.pre_pause_summary === undefined) {
        writeFields.pre_pause_summary = cur.fields['pre_pause_summary'] as string;
      }
      // Supersede the prior version (active or paused) so the chain stays single-headed.
      cur.status = 'superseded';

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
        // Carry links so the reverse link is stamped on the target.
        replaces: op.replaces,
        corrects: op.corrects,
      };
      const fact = this.makeFact(rp, v, targetStatus, now, cur, writeFields);
      allFacts.push(fact);
      await this.writeFacts(op.type, allFacts, [fact]);
      return fact;
    }

    if (op.kind === 'retract') {
      const allFacts = await this.readForChange(op.type);
      const cur = this.activeVersion(allFacts, op.entity);
      if (!cur) throw new TokenRejectedError('no-active-version');
      if (factSnapshotHash(cur) !== op.baselineCurHash) {
        throw new TokenRejectedError('state-moved-since-proposal');
      }
      const now = this.clock.now().toISOString();
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
      await this.writeFacts(op.type, allFacts, [fact]);
      return fact;
    }

    if (op.kind === 'dispute') {
      const winningVersion = options?.winningVersion;
      if (!winningVersion) throw new TokenRejectedError('dispute-incomplete');
      if (winningVersion !== op.versionA && winningVersion !== op.versionB) {
        throw new TokenRejectedError('dispute-version-not-offered');
      }
      const allFacts = await this.readForChange(op.type);
      // A current active version means a third write landed in the window; resolving now would double-activate.
      if (allFacts.some(f => f.entity === op.entity && f.status === 'active')) {
        throw new TokenRejectedError('state-moved-since-proposal');
      }
      const loserVersion = winningVersion === op.versionA ? op.versionB : op.versionA;
      const winner = allFacts.find(f => f.entity === op.entity && f.version === winningVersion);
      const loser = allFacts.find(f => f.entity === op.entity && f.version === loserVersion);
      if (!winner || !loser) throw new TokenRejectedError('dispute-incomplete');
      winner.status = 'active';
      loser.status = 'superseded';
      // Retire the original pre-dispute fact so it does not stay a `disputed` zombie.
      const original = allFacts.find(f => f.id === op.originalId && f.status === 'disputed' && f.version !== winner.version && f.version !== loser.version);
      if (original) original.status = 'superseded';
      await this.writeFacts(op.type, allFacts, [winner, loser]);
      return winner;
    }

    if (op.kind === 'discontinue') {
      // Re-read current state (the 15-min token window may have seen other writes).
      const allFacts = await this.readForChange(op.type);
      const cur = this.activeVersion(allFacts, op.entity);
      if (!cur) throw new TokenRejectedError('no-active-version');
      if (factSnapshotHash(cur) !== op.baselineCurHash) {
        throw new TokenRejectedError('state-moved-since-proposal');
      }
      return this.applyDiscontinue(allFacts, cur, op.entity, op.type, op.provenance, { reason: op.reason, replacedBy: op.replacedBy });
    }

    if (op.kind === 'restart') {
      const allFacts = await this.readForChange(op.type);
      // A second restart token must not create a second active version.
      if (this.activeVersion(allFacts, op.entity)) {
        throw new TokenRejectedError('entity-already-active');
      }
      const discontinued = this.latestDiscontinued(allFacts, op.entity);
      if (!discontinued) throw new TokenRejectedError('no-active-version');
      if (discontinued.id !== op.restartOf || factSnapshotHash(discontinued) !== op.baselineCurHash) {
        throw new TokenRejectedError('state-moved-since-proposal');
      }
      return this.applyRestart(allFacts, discontinued, op.entity, op.type, op.provenance, { ...op.fields }, discontinued.id);
    }

    throw new TokenRejectedError('unknown-op');
  }

  async getActive(entity: string, type: FactType): Promise<LedgerFact | null> {
    entity = requireEntitySlug(entity);
    const allFacts = await this.readFacts(type);
    return this.activeVersion(allFacts, entity);
  }

  async getChain(entity: string, type: FactType): Promise<LedgerFact[]> {
    entity = requireEntitySlug(entity);
    const allFacts = await this.readFacts(type);
    const chain = allFacts.filter(f => f.entity === entity);
    chain.sort((a, b) => b.version - a.version);
    return chain;
  }

  async listByType(type: FactType): Promise<LedgerFact[]> {
    const allFacts = await this.readFacts(type);
    // Exclude v0 quarantine sentinels.
    return allFacts.filter(f => f.status === 'active' && f.version >= 1);
  }

  async listAllOfType(type: FactType): Promise<LedgerFact[]> {
    return this.readFacts(type);
  }

  async listAllOfEntity(type: FactType, entity: string): Promise<LedgerFact[]> {
    const normalized = requireEntitySlug(entity);
    return (await this.readFacts(type)).filter((fact) => fact.entity === normalized);
  }

  async listActiveConflicts(type: FactType): Promise<string[]> {
    const allFacts = await this.readFacts(type);
    const counts = new Map<string, number>();
    for (const f of allFacts) {
      if (f.status === 'active' && f.version >= 1) counts.set(f.entity, (counts.get(f.entity) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([entity]) => entity);
  }

  async listCurrent(): Promise<LedgerFact[]> {
    const out: LedgerFact[] = [];
    for (const type of Object.keys(TYPE_TO_FILE) as FactType[]) {
      for (const f of await this.readFacts(type)) {
        if (f.version >= 1 && (f.status === 'active' || f.status === 'paused')) out.push(f);
      }
    }
    return out;
  }

  async listSafetyRelevant(): Promise<LedgerFact[]> {
    const out: LedgerFact[] = [];
    for (const type of Object.keys(TYPE_TO_FILE) as FactType[]) {
      for (const f of await this.readFacts(type)) {
        // Disputed safety facts stay on the safety net until resolved.
        if (f.safetyRelevant && (f.status === 'active' || f.status === 'resolved' || f.status === 'disputed')) out.push(f);
      }
    }
    return out;
  }
}
