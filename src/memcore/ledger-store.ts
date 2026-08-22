import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  AUTHORITY_RANK, ConfirmationToken, FactStatus, FactType, LedgerFact,
  LedgerMutationResult, PendingOp, Provenance, RecordFactResult, RetractResult, StoredToken, TYPE_TO_FILE,
} from './types';
import { parseLedgerFile, renderLedgerFile, canonicalFields } from './ledger-parser';
import { TokenRejectedError } from './token-errors';
import { secureWriteViaTmp, secureChmodFile, summarizeErrorForLog } from '../security';
import type { Clock } from '../ports';
import { systemClock } from '../ports';

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
  // Cross-entity links a new fact may declare (the tool/capture layer supplies target ids).
  replaces?: string;
  replacedBy?: string;
  corrects?: string;
  correctedBy?: string;
}

export class LedgerStore {
  private tokens = new Map<string, StoredToken>();

  constructor(private rootDir: string, private clock: Clock = systemClock) {}

  private filePath(type: FactType): string {
    const name = TYPE_TO_FILE[type];
    return path.join(this.rootDir, 'ledger', name);
  }

  private async readFacts(type: FactType): Promise<LedgerFact[]> {
    const fp = this.filePath(type);
    let content: string;
    try {
      content = await fs.promises.readFile(fp, 'utf-8');
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return [];
      throw err;
    }
    const facts = parseLedgerFile(content, { type, profileId: path.basename(this.rootDir) });
    // A non-empty file that parses to zero facts is corrupt (e.g. truncated
    // mid-header). Quarantine the raw bytes to a sidecar BEFORE any later write
    // can overwrite them — never treat a failed parse as an empty store.
    if (facts.length === 0 && content.trim() !== '') {
      this.quarantineCorruptFile(fp);
      return [];
    }
    return facts;
  }

  /** Move an unparseable ledger file aside (rename → `*.corrupt-<stamp>`) so a fresh write cannot destroy it. */
  private quarantineCorruptFile(fp: string): void {
    try {
      const sidecar = `${fp}.corrupt-${this.clock.now().getTime()}`;
      fs.renameSync(fp, sidecar);
      secureChmodFile(sidecar);
      // PHI-safe: log the file basename (a type name) only, never the content.
      console.warn(`[ledger-store] quarantined unparseable ledger file ${path.basename(fp)} to a .corrupt sidecar`);
    } catch (err) {
      console.warn(`[ledger-store] ledger quarantine failed: ${summarizeErrorForLog(err)}`);
    }
  }

  private async writeFacts(type: FactType, facts: LedgerFact[]): Promise<void> {
    secureWriteViaTmp(this.filePath(type), renderLedgerFile(facts));
  }

  private nextVersion(facts: LedgerFact[], entity: string): number {
    const entityFacts = facts.filter(f => f.entity === entity);
    if (entityFacts.length === 0) return 1;
    return Math.max(...entityFacts.map(f => f.version)) + 1;
  }

  private activeVersion(facts: LedgerFact[], entity: string): LedgerFact | null {
    // M-5: v0 facts are parse-error quarantine sentinels (createParseErrorFact) — never real
    // active facts. Exclude them so a corrupt block cannot surface as a ghost active fact.
    const active = facts.filter(f => f.entity === entity && f.status === 'active' && f.version >= 1);
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
    // Compare CANONICAL forms (INJ-b): a stored number and its re-typed string
    // twin are the same value after one Markdown round-trip — never a conflict.
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
  ): LedgerFact {
    // SB-2 (specs/07 §5 merge-update): a superseding version MERGES the prior active/paused
    // fact's fields with the proposal — a non-conflicting add or a single-key change must never
    // silently DROP carried fields (dose, known_side_effects, started). An explicit fieldsOverride
    // (dispute head A, paused-carry, confirm-write) already carries the intended merged set.
    const fields = fieldsOverride
      ? fieldsOverride
      : (current ? { ...current.fields, ...params.fields } : { ...params.fields });
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
      replaces: params.replaces,
      replacedBy: params.replacedBy,
      corrects: params.corrects,
      correctedBy: params.correctedBy,
      status,
      fields,
      provenance: pf,
      // Medications and allergies are ALWAYS safety-relevant — the SAFETY.md net and
      // the retract/discontinue confirmation must never depend on a caller/model flag
      // (medical-safety). Other types honor the caller's flag as before.
      safetyRelevant: isMedOrAllergy(params.type) ? true : (params.safetyRelevant ?? false),
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
    const now = this.clock.now().toISOString();

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
      const changeHash = hash(`${params.entity}:${params.type}:${JSON.stringify(canonicalFields(params.fields))}`);
      // CH: snapshot the current fact so confirm() can detect state drift.
      const baselineCurHash = hash(`${cur.id}:${JSON.stringify(canonicalFields(cur.fields))}`);
      const token = makeToken(params.entity, changeHash, this.clock.now().getTime());
      this.tokens.set(token.uuid, { token, op: { kind: 'write', ...params, fields, baselineCurHash }, used: false });
      return { kind: 'needs-confirmation', token, current: cur, proposed };
    }

    if (!active) {
      // cur is paused and resume was requested: supersede the paused version with an active one.
      // H-1: resuming a med/allergy STILL requires confirmation — the resume flag must never
      // bypass the med-class gate (medical-safety), matching every other conflicting med path.
      if (isMedOrAllergy(params.type)) {
        const v = this.nextVersion(allFacts, params.entity);
        const proposed = this.makeFact(params, v, 'active', now, cur);
        const changeHash = hash(`resume:${params.entity}:${params.type}:${JSON.stringify(canonicalFields(params.fields))}`);
        const baselineCurHash = hash(`${cur.id}:${JSON.stringify(canonicalFields(cur.fields))}`);
        const token = makeToken(params.entity, changeHash, this.clock.now().getTime());
        this.tokens.set(token.uuid, { token, op: { kind: 'write', ...params, baselineCurHash }, used: false });
        return { kind: 'needs-confirmation', token, current: cur, proposed };
      }
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

    // AR / C2: authority-rank auto-apply NEVER applies to med/allergy facts — a
    // conflicting change to a safety-class fact routes to needs-confirmation
    // regardless of provenance rank (specs/13 A5/A6 posture; medical-safety).
    if (provRank > curRank && !isMedOrAllergy(params.type)) {
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
      // DS (SB-3): the two heads must carry the two COMPETING values.
      // Head A = the NEW claim, preserving prior fields (known_side_effects etc.).
      const disputeA = this.makeFact(params, vA, 'disputed', now, active, { ...active.fields, ...params.fields });
      // Head B = the OLD active claim re-presented — its OWN fields + provenance,
      // so the user can restore it verbatim.
      const disputeB: LedgerFact = {
        ...active,
        id: `${params.entity}@v${vB}`,
        version: vB,
        status: 'disputed',
        createdAt: now,
        supersedes: active.id,
      };
      allFacts.push(disputeA, disputeB);
      await this.writeFacts(params.type, allFacts);
      const changeHash = hash(`dispute:${params.entity}:${vA}:${vB}`);
      const token = makeToken(params.entity, changeHash, this.clock.now().getTime());
      this.tokens.set(token.uuid, {
        token,
        op: { kind: 'dispute', entity: params.entity, type: params.type, versionA: vA, versionB: vB, originalId: active.id },
        used: false,
      });
      return { kind: 'disputed', versions: [disputeA, disputeB], disputeToken: token };
    }

    {
      const v = this.nextVersion(allFacts, params.entity);
      const proposed = this.makeFact(params, v, 'active', now, active);
      const changeHash = hash(`${params.entity}:${params.type}:${JSON.stringify(canonicalFields(params.fields))}`);
      // CH: snapshot the current fact so confirm() can detect state drift.
      const baselineCurHash = hash(`${active.id}:${JSON.stringify(canonicalFields(active.fields))}`);
      const token = makeToken(params.entity, changeHash, this.clock.now().getTime());
      this.tokens.set(token.uuid, { token, op: { kind: 'write', ...params, fields: params.fields, baselineCurHash }, used: false });
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
      return { kind: 'noop', reason: 'no-active-version' };
    }

    const now = this.clock.now().toISOString();
    // Safety-relevant facts AND all med/allergy facts require confirmation to retract,
    // regardless of the flag (aligns with discontinue's type-based guard).
    if (cur.safetyRelevant || isMedOrAllergy(cur.type)) {
      const changeHash = hash(`retract:${params.entity}:${params.type}`);
      const token = makeToken(params.entity, changeHash, this.clock.now().getTime());
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
    await this.writeFacts(type, allFacts);
    return fact;
  }

  /**
   * Discontinue the active version of an entity. Med/allergy discontinuation is
   * a safety-critical change → NEEDS_CONFIRM (amendment A6 posture). Non-med types
   * apply directly. No active version → idempotent noop.
   */
  async discontinue(
    entity: string, type: FactType, provenance: Provenance,
    opts?: { reason?: string; replacedBy?: string },
  ): Promise<LedgerMutationResult> {
    const allFacts = await this.readFacts(type);
    const cur = this.activeVersion(allFacts, entity);
    if (!cur) return { kind: 'noop', reason: 'no-active-version' };

    if (isMedOrAllergy(type)) {
      const changeHash = hash(`discontinue:${entity}:${type}`);
      const token = makeToken(entity, changeHash, this.clock.now().getTime());
      this.tokens.set(token.uuid, {
        token,
        op: { kind: 'discontinue', entity, type, provenance, reason: opts?.reason, replacedBy: opts?.replacedBy },
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
    await this.writeFacts(type, allFacts);
    return fact;
  }

  /**
   * Restart a previously discontinued entity as a NEW active version carrying
   * `restartOf` = the discontinued version's id (amendment A6). Med/allergy →
   * NEEDS_CONFIRM. Already-active or nothing-discontinued → idempotent noop.
   */
  async restart(
    entity: string, type: FactType, provenance: Provenance,
    fields: Record<string, string | number | string[]>,
  ): Promise<LedgerMutationResult> {
    const allFacts = await this.readFacts(type);
    if (this.activeVersion(allFacts, entity)) return { kind: 'noop', reason: 'already-active' };
    const discontinued = this.latestDiscontinued(allFacts, entity);
    if (!discontinued) return { kind: 'noop', reason: 'no-discontinued-version' };

    if (isMedOrAllergy(type)) {
      const changeHash = hash(`restart:${entity}:${type}`);
      const token = makeToken(entity, changeHash, this.clock.now().getTime());
      this.tokens.set(token.uuid, {
        token,
        op: { kind: 'restart', entity, type, provenance, fields: { ...fields }, restartOf: discontinued.id },
        used: false,
      });
      return { kind: 'needs-confirmation', fact: discontinued, token };
    }

    const fact = await this.applyRestart(allFacts, discontinued, entity, type, provenance, { ...fields }, discontinued.id);
    return { kind: 'applied', fact };
  }

  /**
   * Pause the active version, carrying a `pre_pause_summary` (amendment A2). The
   * A2 supersession-carry (recordFact on a paused entity) already works — this is
   * the missing public entry point. No active version → idempotent noop.
   */
  async pause(
    entity: string, type: FactType, provenance: Provenance,
    opts: { prePauseSummary: string },
  ): Promise<LedgerMutationResult> {
    const allFacts = await this.readFacts(type);
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
    await this.writeFacts(type, allFacts);
    return { kind: 'applied', fact };
  }

  /** All cross-entity link ids for an entity, deduped across its version chain. */
  async getCrossLinks(entity: string, type: FactType): Promise<{
    replaces: string[]; replacedBy: string[]; corrects: string[]; correctedBy: string[];
  }> {
    const allFacts = await this.readFacts(type);
    const entityFacts = allFacts.filter(f => f.entity === entity);
    const collect = (pick: (f: LedgerFact) => string | undefined): string[] =>
      Array.from(new Set(entityFacts.map(pick).filter((x): x is string => Boolean(x))));
    return {
      replaces: collect(f => f.replaces),
      replacedBy: collect(f => f.replacedBy),
      corrects: collect(f => f.corrects),
      correctedBy: collect(f => f.correctedBy),
    };
  }

  /**
   * Explicitly burn a token WITHOUT applying its op (user declined). The token
   * becomes unusable immediately (MED-9/DT) instead of lingering for its full
   * 15-minute window. Idempotent.
   */
  declineToken(tokenId: string): void {
    const stored = this.tokens.get(tokenId);
    if (!stored) return;
    stored.used = true;
  }

  async confirm(tokenId: string, options?: { winningVersion?: number }): Promise<LedgerFact> {
    const stored = this.tokens.get(tokenId);
    if (!stored) throw new TokenRejectedError('token-not-found');
    if (stored.used) throw new TokenRejectedError('token-already-used');
    if (new Date(stored.token.expiresAt) < this.clock.now()) {
      throw new TokenRejectedError('token-expired');
    }

    const op = stored.op;
    // TB (SB-12): the token is marked used only AFTER the op succeeds — a failed
    // apply (transient IO, state drift) leaves it valid so the user can retry.
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
      const allFacts = await this.readFacts(op.type);
      // Resolve the current version as active OR paused (a paused-entity update
      // has no active version — mirrors recordFact). Without this the paused-carry
      // branch below is unreachable and confirm() rejects (A2).
      const cur = this.activeVersion(allFacts, op.entity) ?? this.pausedVersion(allFacts, op.entity);
      if (!cur) throw new TokenRejectedError('no-active-version');
      // CH (M2/M3-sec): reject a stale token whose target state moved since the
      // proposal — confirming blind would clobber a newer legitimate change.
      if (op.baselineCurHash !== undefined
        && hash(`${cur.id}:${JSON.stringify(canonicalFields(cur.fields))}`) !== op.baselineCurHash) {
        throw new TokenRejectedError('state-moved-since-proposal');
      }
      const now = this.clock.now().toISOString();
      const v = this.nextVersion(allFacts, op.entity);
      // A confirmed resume (op.resume) reactivates a paused fact → 'active'; a plain paused-entity
      // update stays 'paused' (H-1: resume is gated for meds but still resumes on confirm).
      const targetStatus: FactStatus = (cur.status === 'paused' && !op.resume) ? 'paused' : 'active';
      // SB-2: merge the confirmed proposal onto the current fact's fields so the applied head
      // retains carried fields (known_side_effects etc.) — the proposal's keys win. This also
      // subsumes the paused pre_pause_summary carry (kept below as belt-and-braces).
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
      };
      const fact = this.makeFact(rp, v, targetStatus, now, cur, writeFields);
      allFacts.push(fact);
      await this.writeFacts(op.type, allFacts);
      return fact;
    }

    if (op.kind === 'retract') {
      const allFacts = await this.readFacts(op.type);
      const cur = this.activeVersion(allFacts, op.entity);
      if (!cur) throw new TokenRejectedError('no-active-version');
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
      await this.writeFacts(op.type, allFacts);
      return fact;
    }

    if (op.kind === 'dispute') {
      const winningVersion = options?.winningVersion;
      if (!winningVersion) throw new TokenRejectedError('dispute-incomplete');
      const allFacts = await this.readFacts(op.type);
      // Self-review IMPORTANT-3: at mint time the pre-dispute fact was flipped to
      // `disputed`, so ANY current active version means a third write landed in
      // the window — resolving now would create a double-active entity.
      if (allFacts.some(f => f.entity === op.entity && f.status === 'active')) {
        throw new TokenRejectedError('state-moved-since-proposal');
      }
      const loserVersion = winningVersion === op.versionA ? op.versionB : op.versionA;
      const winner = allFacts.find(f => f.entity === op.entity && f.version === winningVersion);
      const loser = allFacts.find(f => f.entity === op.entity && f.version === loserVersion);
      if (!winner || !loser) throw new TokenRejectedError('dispute-incomplete');
      winner.status = 'active';
      loser.status = 'superseded';
      // DS (SB-3): retire the ORIGINAL pre-dispute fact too — otherwise it stays
      // a permanent `disputed` zombie in the chain. The dispute heads carry the
      // full competing content, so nothing is lost by superseding it.
      const original = allFacts.find(f => f.id === op.originalId && f.status === 'disputed' && f.version !== winner.version && f.version !== loser.version);
      if (original) original.status = 'superseded';
      await this.writeFacts(op.type, allFacts);
      return winner;
    }

    if (op.kind === 'discontinue') {
      // Re-read current state (the 15-min token window may have seen other writes).
      const allFacts = await this.readFacts(op.type);
      const cur = this.activeVersion(allFacts, op.entity);
      if (!cur) throw new TokenRejectedError('no-active-version');
      return this.applyDiscontinue(allFacts, cur, op.entity, op.type, op.provenance, { reason: op.reason, replacedBy: op.replacedBy });
    }

    if (op.kind === 'restart') {
      const allFacts = await this.readFacts(op.type);
      // Guard against a second restart token confirming into a SECOND active version
      // (two coexisting restart tokens → double-active → the entity can never be retired).
      if (this.activeVersion(allFacts, op.entity)) {
        throw new TokenRejectedError('entity-already-active');
      }
      const discontinued = allFacts.find(f => f.id === op.restartOf) ?? this.latestDiscontinued(allFacts, op.entity);
      if (!discontinued) throw new TokenRejectedError('no-active-version');
      return this.applyRestart(allFacts, discontinued, op.entity, op.type, op.provenance, { ...op.fields }, discontinued.id);
    }

    throw new TokenRejectedError('unknown-op');
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
    // M-5: exclude v0 parse-error quarantine sentinels from active listings.
    return allFacts.filter(f => f.status === 'active' && f.version >= 1);
  }

  /**
   * SB-3 / CONTRA-02: entity names of this type that currently have MORE THAN ONE active
   * version — a dual-active conflict the store did not auto-resolve (e.g. seeded/imported
   * state; the store never auto-produces `disputed` for med-class, A5). Surfaced to the agent
   * so it can ask the user to clarify, rather than silently masking one head via getActive.
   */
  async listActiveConflicts(type: FactType): Promise<string[]> {
    const allFacts = await this.readFacts(type);
    const counts = new Map<string, number>();
    for (const f of allFacts) {
      if (f.status === 'active' && f.version >= 1) counts.set(f.entity, (counts.get(f.entity) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([entity]) => entity);
  }

  /**
   * Every safety-relevant fact currently shown on SAFETY.md — active OR resolved, across
   * all types. This is the source the SafetyRenderer re-renders from on a D8 mutation
   * (broader than listByType, which is active-only). Bounded to one read per type file.
   */
  async listSafetyRelevant(): Promise<LedgerFact[]> {
    const out: LedgerFact[] = [];
    for (const type of Object.keys(TYPE_TO_FILE) as FactType[]) {
      for (const f of await this.readFacts(type)) {
        // DS: `disputed` facts stay visible to the SAFETY renderer (marked as
        // under dispute) so a med/allergy never silently leaves the safety net
        // while its dispute is unresolved.
        if (f.safetyRelevant && (f.status === 'active' || f.status === 'resolved' || f.status === 'disputed')) out.push(f);
      }
    }
    return out;
  }
}
