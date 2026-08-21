// src/tools/ledger-tools.ts
//
// Agent-facing ledger surface (Task 12.1–12.3). Records route through the CapturePipeline
// (both lanes + D8 SAFETY re-render); confirmations and queries go straight to the store.
// `src/tools/` is the legacy layer and MAY import memcore/capture concretes.

import type { Tool, ToolResult } from './types';
import type { CapturePipeline, QueuePort, SafetyRenderer } from '../capture';
import type { LedgerStore } from '../memcore';
import type { FactType, LedgerFact, RecordFactResult, Authority, Provenance } from '../memcore';
import { TokenRejectedError, sanitizeSingleLine } from '../memcore';
import type { Clock } from '../ports';
import { systemClock } from '../ports';
import { summarizeErrorForLog, contentContainsCredentials } from '../security';

const FACT_TYPES: FactType[] = ['medication', 'condition', 'symptom', 'appointment', 'metric', 'goal', 'allergy'];
const AUTHORITIES: Authority[] = ['doctor', 'lab', 'report', 'sensor', 'user', 'inference'];

export interface LedgerToolsDeps {
  pipeline: CapturePipeline;
  ledger: LedgerStore;
  safety: SafetyRenderer;
  queue: QueuePort;
  clock?: Clock;
  /** DIAB-06: resolve a medication's side effects (LLM). Omit to always fall back to []. */
  sideEffectLookup?: (entity: string, fields: Record<string, string | number | string[]>) => Promise<string[]>;
  /**
   * BL (SB-11/M6): narrative anchor port — when supplied, the confirm path writes
   * the KNEE-01 `## Ledger writes` back-link for the CONFIRMED fact (the initial
   * applied record's anchor comes from the pipeline; confirms had none).
   */
  narrative?: { appendLedgerAnchor(date: string, entity: string, factId: string): Promise<string> };
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function summarizeFields(f: LedgerFact): string {
  const parts = Object.entries(f.fields).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(',')}]` : v}`);
  return parts.length ? parts.join(', ') : '(no fields)';
}

function renderFact(f: LedgerFact): string {
  return `- ${f.entity} (${f.type}) v${f.version} [${f.status}] ${summarizeFields(f)}`;
}

function renderFacts(facts: LedgerFact[]): string {
  if (facts.length === 0) return 'No matching facts.';
  return facts.map(renderFact).join('\n');
}

export function createLedgerTools(deps: LedgerToolsDeps): Tool[] {
  const clock = deps.clock ?? systemClock;
  const provenance = (source: Authority, confidence: number): Provenance => ({
    source,
    confidence,
    anchor: '',
    capturedAt: clock.now().toISOString(),
  });

  function renderRetractRelay(result: RecordFactResult): string {
    const token = (result as { pendingRetract?: { uuid: string } }).pendingRetract;
    if (!token) return '';
    return (
      `\nAlso: the mistaken fact could not be auto-retracted and needs confirmation. ` +
      `To finish the correction, call ledger_update with tokenId="${token.uuid}" and confirm=true.`
    );
  }

  function renderRecordResult(result: RecordFactResult | void, entity: string, type: FactType): ToolResult {
    if (!result) return ok(`Recorded a narrative note for ${entity}.`);
    if (result.kind === 'applied') {
      return ok(`Recorded ${entity} (${type}) as ${result.fact.id}.${renderRetractRelay(result)}`);
    }
    if (result.kind === 'needs-confirmation') {
      return ok(
        `This change to ${entity} needs your confirmation. To apply, call ledger_update with tokenId="${result.token.uuid}" and confirm=true; to decline, confirm=false.\n` +
        `current: ${summarizeFields(result.current)}\nproposed: ${summarizeFields(result.proposed)}` +
        renderRetractRelay(result),
      );
    }
    return ok(
      `${entity} is now disputed between two versions. Resolve with ledger_update tokenId="${result.disputeToken.uuid}", confirm=true, winningVersion=<n>.\n` +
      result.versions.map(v => `v${v.version}: ${summarizeFields(v)}`).join('\n') +
      renderRetractRelay(result),
    );
  }

  const ledgerRecord: Tool = {
    name: 'ledger_record',
    group: 'group:ledger',
    description: 'Record a structured health fact (medication, condition, symptom, appointment, metric, goal, allergy) into the versioned ledger. Writes both memory lanes and updates SAFETY.md for safety-relevant facts.',
    parameters: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Canonical entity name, e.g. "metformin"' },
        type: { type: 'string', enum: FACT_TYPES, description: 'Fact type' },
        fields: { type: 'object', description: 'Structured fields, e.g. { "dose": "500mg" }' },
        note: { type: 'string', description: 'Human-readable narrative log line (defaults to the entity)' },
        verbatim: { type: 'string', description: 'Exact user quote to store losslessly' },
        safety_relevant: { type: 'boolean', description: 'Force safety-relevance (meds/allergies are always safety-relevant regardless)' },
        episode_id: { type: 'string', description: 'Link this fact to an episode' },
        language: { type: 'string', description: 'Language of the verbatim quote (default en)' },
        source: { type: 'string', enum: AUTHORITIES, description: 'Provenance authority (default user)' },
        confidence: { type: 'number', description: 'Provenance confidence 0..1 (default 0.9)' },
      },
      required: ['entity', 'type'],
    },
    async execute(params): Promise<ToolResult> {
      const entity = params.entity as string;
      const type = params.type as FactType;
      if (!FACT_TYPES.includes(type)) return err(`Unknown fact type "${type}".`);
      const fields = { ...((params.fields as Record<string, string | number | string[]>) ?? {}) };

      // SBX-1: field keys are model-invented names, never health content. A key carrying
      // newlines/# would forge `## entity` / `### vN (active)` structure into the line-oriented
      // ledger on re-parse (fabricating active meds/allergies onto SAFETY.md with no confirmation).
      // Reject illegal keys at the boundary; flattenFactForRender sanitizes keys as defense-in-depth.
      for (const key of Object.keys(fields)) {
        if (key === '' || /[\r\n\t#]/.test(key)) {
          return err(`Write rejected: field key ${JSON.stringify(key.slice(0, 40))} contains illegal characters (newline, tab, or #). Field names must be simple identifiers.`);
        }
      }

      // CRED (SB-6): the ledger lane carries the SAME credential-rejection bar as
      // memory_write — scan every caller-controlled input before any write.
      const credScan = contentContainsCredentials(
        `${entity}\n${JSON.stringify(fields)}\n${(params.note as string) ?? ''}\n${(params.verbatim as string) ?? ''}`,
      );
      if (credScan.matched) {
        return err(`Write rejected: content matches credential pattern (${credScan.pattern}). Credentials must never be stored in the health memory.`);
      }

      // DIAB-06 (D1): a medication must never be stored with an ABSENT known_side_effects
      // field. Resolve it once BEFORE enqueue; on failure (or no resolver) fall back to [].
      if (type === 'medication' && fields.known_side_effects === undefined) {
        if (deps.sideEffectLookup) {
          try {
            fields.known_side_effects = await deps.sideEffectLookup(entity, fields);
          } catch (e) {
            // PHI: the medication name must never reach logs — sanitized frame only.
            console.warn('[ledger_record] side-effect lookup failed:', summarizeErrorForLog(e));
            fields.known_side_effects = [];
          }
        } else {
          fields.known_side_effects = [];
        }
      }

      const source = (params.source as Authority) ?? 'user';
      const confidence = (params.confidence as number) ?? 0.9;
      const result = await deps.pipeline.ingest({
        profileId: 'default',
        source: 'tool:ledger_record',
        kind: 'ledger-fact',
        payload: {
          entity,
          type,
          fields,
          provenance: provenance(source, confidence),
          safetyRelevant: params.safety_relevant as boolean | undefined,
          episodeId: params.episode_id as string | undefined,
          language: params.language as string | undefined,
          verbatim: params.verbatim as string | undefined,
          text: params.note as string | undefined,
        },
      });
      return renderRecordResult(result, entity, type);
    },
  };

  const ledgerUpdate: Tool = {
    name: 'ledger_update',
    group: 'group:ledger',
    description: 'Confirm (or decline) a pending ledger change previously surfaced by ledger_record — a supersession, dispute resolution, retraction, or discontinuation.',
    parameters: {
      type: 'object',
      properties: {
        tokenId: { type: 'string', description: 'The confirmation token id from ledger_record' },
        confirm: { type: 'boolean', description: 'true to apply the change, false to decline' },
        winningVersion: { type: 'number', description: 'For a disputed pair, the version number to keep' },
        reason: { type: 'string', description: 'Optional note for the change' },
      },
      required: ['tokenId', 'confirm'],
    },
    async execute(params): Promise<ToolResult> {
      const tokenId = params.tokenId as string;
      const confirm = params.confirm as boolean;
      const winningVersion = params.winningVersion as number | undefined;

      if (confirm === false) {
        // MED-9/DT: a decline BURNS the token — it can no longer be applied
        // later in its window by a replayed or hallucinated confirm.
        deps.ledger.declineToken(tokenId);
        return ok(`Change declined — token ${tokenId} was burned and can no longer be applied.`);
      }

      try {
        const fact = await deps.queue.enqueue('turn', {
          label: 'ledger_update:confirm',
          run: async () => {
            const applied = await deps.ledger.confirm(
              tokenId,
              winningVersion !== undefined ? { winningVersion } : undefined,
            );
            // D8: a confirmed safety-relevant change must re-render SAFETY.md in the same op.
            if (applied.safetyRelevant) {
              await deps.safety.render(await deps.safety.listSafetyRelevant());
            }
            // BL: KNEE-01 back-link for the CONFIRMED fact — dispute resolutions
            // and confirmed writes otherwise never appear in the daily log index.
            if (deps.narrative) {
              try {
                const day = new Date(applied.provenance.capturedAt);
                const dayStr = Number.isNaN(day.getTime())
                  ? clock.now().toISOString().slice(0, 10)
                  : day.toISOString().slice(0, 10);
                await deps.narrative.appendLedgerAnchor(dayStr, applied.entity, applied.id);
              } catch (anchorError) {
                console.warn('[ledger_update] ledger-writes anchor failed (continuing):', summarizeErrorForLog(anchorError));
              }
            }
            return applied;
          },
        });
        return ok(`Confirmed: ${fact.entity} (${fact.type}) is now ${fact.status} as ${fact.id}.`);
      } catch (e) {
        // PPHI: raw provider/store errors can echo entity names (health content).
        // Token rejections carry a fixed PHI-free reason; everything else is logged
        // sanitized and reported generically.
        if (e instanceof TokenRejectedError) {
          return err(`Could not apply confirmation: ${e.message}`);
        }
        console.warn('[ledger_update] confirm failed:', summarizeErrorForLog(e));
        return err('Could not apply confirmation. Please re-state the change to get a fresh proposal.');
      }
    },
  };

  const ledgerRemove: Tool = {
    name: 'ledger_remove',
    group: 'group:ledger',
    description: 'Remove a health fact (e.g. discontinue a medication the user no longer takes). Meds and allergies ALWAYS ask the user for confirmation before applying; SAFETY.md updates on confirm (D8/DAD-11).',
    parameters: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity to remove, e.g. "metformin"' },
        type: { type: 'string', enum: FACT_TYPES, description: 'Fact type' },
        reason: { type: 'string', description: 'Why it is being removed (stored on the discontinued version)' },
      },
      required: ['entity', 'type'],
    },
    async execute(params): Promise<ToolResult> {
      const entity = params.entity as string;
      const type = params.type as FactType;
      if (!FACT_TYPES.includes(type)) return err(`Unknown fact type "${type}".`);
      // CRED + INJ (self-review CRITICAL-1): the reason persists into a ledger
      // type file — it passes the SAME credential bar and single-line discipline
      // as every other caller-controlled input. A multi-line reason could
      // otherwise forge version blocks (fake ACTIVE med facts) on re-parse.
      let reason = (params.reason as string | undefined) ?? undefined;
      if (reason !== undefined) {
        const credScan = contentContainsCredentials(reason);
        if (credScan.matched) {
          return err(`Write rejected: content matches credential pattern (${credScan.pattern}). Credentials must never be stored in the health memory.`);
        }
        reason = sanitizeSingleLine(reason);
        if (reason === '') reason = undefined;
      }

      // RM (H1/C1-arch): the agent-facing removal surface — routes through the
      // ledger's discontinuation flow so med-class removal is user-confirmed
      // and every version stays preserved (soft-delete law).
      const result = await deps.queue.enqueue('turn', {
        label: 'ledger_remove:discontinue',
        run: () => deps.ledger.discontinue(entity, type, provenance('user', 0.9), { reason }),
      });

      if (result.kind === 'noop') {
        return ok(`Nothing to remove: ${result.reason.replace(/-/g, ' ')}.`);
      }
      if (result.kind === 'needs-confirmation') {
        return ok(
          `Removing ${entity} needs your confirmation. To apply, call ledger_update with tokenId="${result.token.uuid}" and confirm=true; to decline, confirm=false.\n` +
          `current: ${summarizeFields(result.fact)}`,
        );
      }
      if (result.fact.safetyRelevant) {
        await deps.safety.render(await deps.safety.listSafetyRelevant());
      }
      return ok(`Removed ${entity} (${type}) — now ${result.fact.status} as ${result.fact.id}.`);
    },
  };

  const ledgerQuery: Tool = {
    name: 'ledger_query',
    group: 'group:ledger',
    description: 'Read structured facts from the ledger by entity and/or type. status="active" (default) shows current facts; status="all" shows the full version chain for an entity.',
    parameters: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity name (optional)' },
        type: { type: 'string', enum: FACT_TYPES, description: 'Fact type' },
        status: { type: 'string', enum: ['active', 'all'], description: 'active (default) or all (full chain, needs entity+type)' },
      },
    },
    async execute(params): Promise<ToolResult> {
      const entity = params.entity as string | undefined;
      const type = params.type as FactType | undefined;
      const status = (params.status as string) ?? 'active';
      if (type && !FACT_TYPES.includes(type)) return err(`Unknown fact type "${type}".`);

      if (entity && type) {
        const facts = status === 'all'
          ? await deps.ledger.getChain(entity, type)
          : ((f): LedgerFact[] => (f ? [f] : []))(await deps.ledger.getActive(entity, type));
        const links = await deps.ledger.getCrossLinks(entity, type);
        const linkLines: string[] = [];
        if (links.replaces.length) linkLines.push(`replaces: ${links.replaces.join(', ')}`);
        if (links.replacedBy.length) linkLines.push(`replacedBy: ${links.replacedBy.join(', ')}`);
        if (links.corrects.length) linkLines.push(`corrects: ${links.corrects.join(', ')}`);
        if (links.correctedBy.length) linkLines.push(`correctedBy: ${links.correctedBy.join(', ')}`);
        const linkText = linkLines.length ? `\ncross-links → ${linkLines.join(' · ')}` : '';
        return ok(renderFacts(facts) + linkText);
      }

      if (type) {
        return ok(renderFacts(await deps.ledger.listByType(type)));
      }

      return err('ledger_query needs at least a type (optionally with an entity).');
    },
  };

  return [ledgerRecord, ledgerRemove, ledgerUpdate, ledgerQuery];
}
