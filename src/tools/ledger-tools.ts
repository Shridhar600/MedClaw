// src/tools/ledger-tools.ts
//
// Agent-facing ledger surface (Task 12.1–12.3). Records route through the CapturePipeline
// (both lanes + D8 SAFETY re-render); confirmations and queries go straight to the store.
// `src/tools/` is the legacy layer and MAY import memcore/capture concretes.

import type { Tool, ToolResult } from './types';
import type { CapturePipeline, QueuePort, SafetyRenderer } from '../capture';
import type { LedgerStore } from '../memcore';
import type { FactType, LedgerFact, RecordFactResult, Authority, Provenance } from '../memcore';
import type { Clock } from '../ports';
import { systemClock } from '../ports';
import { summarizeErrorForLog } from '../security';

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

  function renderRecordResult(result: RecordFactResult | void, entity: string, type: FactType): ToolResult {
    if (!result) return ok(`Recorded a narrative note for ${entity}.`);
    if (result.kind === 'applied') {
      return ok(`Recorded ${entity} (${type}) as ${result.fact.id}.`);
    }
    if (result.kind === 'needs-confirmation') {
      return ok(
        `This change to ${entity} needs your confirmation. To apply, call ledger_update with tokenId="${result.token.uuid}" and confirm=true; to decline, confirm=false.\n` +
        `current: ${summarizeFields(result.current)}\nproposed: ${summarizeFields(result.proposed)}`,
      );
    }
    return ok(
      `${entity} is now disputed between two versions. Resolve with ledger_update tokenId="${result.disputeToken.uuid}", confirm=true, winningVersion=<n>.\n` +
      result.versions.map(v => `v${v.version}: ${summarizeFields(v)}`).join('\n'),
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

      // DIAB-06 (D1): a medication must never be stored with an ABSENT known_side_effects
      // field. Resolve it once BEFORE enqueue; on failure (or no resolver) fall back to [].
      if (type === 'medication' && fields.known_side_effects === undefined) {
        if (deps.sideEffectLookup) {
          try {
            fields.known_side_effects = await deps.sideEffectLookup(entity, fields);
          } catch (e) {
            console.warn(`[ledger_record] side-effect lookup failed for ${entity}:`, summarizeErrorForLog(e));
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
        return ok(`Change declined — token ${tokenId} was not applied and will expire unused.`);
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
            return applied;
          },
        });
        return ok(`Confirmed: ${fact.entity} (${fact.type}) is now ${fact.status} as ${fact.id}.`);
      } catch (e) {
        return err(`Could not apply confirmation: ${e instanceof Error ? e.message : String(e)}`);
      }
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

  return [ledgerRecord, ledgerUpdate, ledgerQuery];
}
