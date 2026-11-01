// Agent-facing ledger surface. Records route through the CapturePipeline (both lanes plus the SAFETY
// re-render); confirmations and queries go straight to the store.

import type { Tool, ToolExecutionContext, ToolResult } from './types';
import type { CapturePipeline, QueuePort, SafetyRenderer } from '../capture';
import { computeIdempotencyKey, refreshSafetyView } from '../capture';
import type { LedgerStore } from '../memcore';
import type { FactType, LedgerFact, RecordFactResult, Authority, Provenance } from '../memcore';
import { TokenRejectedError, sanitizeSingleLine, isStorableFieldKey } from '../memcore';
import { normalizeEntitySlug } from '../memcore/sanitize';
import type { Clock } from '../ports';
import { systemClock } from '../ports';
import { summarizeErrorForLog, contentContainsCredentials } from '../security';
import { LedgerUnreadableError } from '../shared/errors';

const FACT_TYPES: FactType[] = ['medication', 'condition', 'symptom', 'appointment', 'metric', 'goal', 'allergy'];
const AUTHORITIES: Authority[] = ['doctor', 'lab', 'report', 'sensor', 'user', 'inference'];

export interface LedgerToolsDeps {
  pipeline: CapturePipeline;
  ledger: LedgerStore;
  safety: SafetyRenderer;
  queue: QueuePort;
  clock?: Clock;
  /** Resolve a medication's side effects (LLM). Omit to always fall back to []. */
  sideEffectLookup?: (entity: string, fields: Record<string, string | number | string[]>) => Promise<string[]>;
  /**
   * Narrative anchor port. When supplied, the confirm path writes the `## Ledger writes` back-link for the
   * confirmed fact (the initial applied record's anchor comes from the pipeline).
   */
  narrative?: { appendLedgerAnchor(date: string, entity: string, factId: string): Promise<string> };
  /**
   * Re-derive the recall substrate (chunk index bookkeeping and reindex; async, off the write lock) for a
   * fact type after a state-changing confirm or remove. `ledger_record` re-derives via the capture pipeline,
   * but `ledger_update` and `ledger_remove` bypass it; without this hook a confirmed retraction or
   * discontinuation keeps injecting the stale fact into the next turn's context.
   */
  afterLedgerMutation?: (type: FactType) => Promise<void>;
  /**
   * Synchronous FactMirror derivation, called inside the same write-lock op as the confirm/discontinue
   * itself (never `afterLedgerMutation`, which runs outside the lock). It must not enqueue (no re-entrancy).
   * A failure warns and continues; recall's fallback port covers reads.
   */
  tier1Rederive?: (type: FactType) => Promise<void>;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}
function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

// Shape-check model-supplied ledger_record args: a missing or mistyped field is a clean,
// self-correctable tool error, never a deep TypeError.
function validateRecordArgs(params: Record<string, unknown>): string | null {
  const entity = params.entity;
  if (normalizeEntitySlug(entity) === null) {
    return 'Missing or invalid required field "entity" (a non-empty string naming the fact, e.g. "metformin").';
  }
  if (params.fields !== undefined) {
    if (typeof params.fields !== 'object' || params.fields === null || Array.isArray(params.fields)) {
      return 'Invalid field "fields": expected an object of simple values.';
    }
    for (const [key, value] of Object.entries(params.fields as Record<string, unknown>)) {
      const ok = typeof value === 'string' || typeof value === 'number' ||
        (Array.isArray(value) && value.every((v) => typeof v === 'string'));
      if (!ok) {
        return `Invalid field value for "${key}": expected a string, number, or array of strings.`;
      }
    }
  }
  for (const key of ['note', 'verbatim', 'language', 'replaces', 'corrects', 'episode_id'] as const) {
    const v = params[key];
    if (v !== undefined && typeof v !== 'string') {
      return `Invalid field "${key}": expected a string.`;
    }
    if ((key === 'replaces' || key === 'corrects') && v !== undefined && normalizeEntitySlug(v) === null) {
      return `Invalid field "${key}": expected a non-empty ledger reference without control or heading characters.`;
    }
  }
  if (params.confidence !== undefined && (typeof params.confidence !== 'number' || !Number.isFinite(params.confidence))) {
    return 'Invalid field "confidence": expected a number between 0 and 1.';
  }
  if (params.source !== undefined && !AUTHORITIES.includes(params.source as Authority)) {
    return `Invalid field "source": must be one of ${AUTHORITIES.join(', ')}.`;
  }
  if (params.safety_relevant !== undefined && typeof params.safety_relevant !== 'boolean') {
    return 'Invalid field "safety_relevant": expected true or false.';
  }
  return null;
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
  // Best-effort recall re-derive after a state-changing confirm/remove (mirror rebuilds at boot, so a
  // failure degrades the next turn's recall, never the turn itself).
  const afterMutation = async (type: FactType): Promise<void> => {
    if (!deps.afterLedgerMutation) return;
    try {
      await deps.afterLedgerMutation(type);
    } catch (e) {
      console.warn('[ledger-tools] post-mutation recall re-derive failed (rebuilds at boot):', summarizeErrorForLog(e));
    }
  };
  // Tier-1: called from WITHIN the write-lock `run()` closure (never after `queue.enqueue()`
  // resolves) so the FactMirror update lands atomically with the confirm/discontinue itself.
  const afterTier1 = async (type: FactType): Promise<void> => {
    if (!deps.tier1Rederive) return;
    try {
      await deps.tier1Rederive(type);
    } catch (e) {
      console.warn('[ledger-tools] Tier-1 fact-mirror derivation failed (recall reads the ledger):', summarizeErrorForLog(e));
    }
  };
  const clock = deps.clock ?? systemClock;
  const confirmationContext = (context?: ToolExecutionContext) => context?.turnId
    ? { chatId: context.chatId, turnId: context.turnId }
    : undefined;
  const bindRecordTokens = (result: RecordFactResult | void, context?: ToolExecutionContext): void => {
    if (!result) return;
    if (result.kind === 'needs-confirmation') deps.ledger.bindTokenContext(result.token.uuid, confirmationContext(context));
    if (result.kind === 'disputed') deps.ledger.bindTokenContext(result.disputeToken.uuid, confirmationContext(context));
    if (result.pendingRetract) deps.ledger.bindTokenContext(result.pendingRetract.uuid, confirmationContext(context));
  };
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
    const lead = result.reopened
      ? `${entity} already has an open dispute, so the new value was not recorded. Ask which version is correct, resolve it, then record the new value if neither is right. Resolve with ledger_update tokenId="${result.disputeToken.uuid}", confirm=true, winningVersion=<n>.\n`
      : `${entity} is now disputed between two versions. Resolve with ledger_update tokenId="${result.disputeToken.uuid}", confirm=true, winningVersion=<n>.\n`;
    return ok(
      lead +
      result.versions.map(v => `v${v.version}: ${summarizeFields(v)}`).join('\n') +
      renderRetractRelay(result),
    );
  }

  const ledgerRecord: Tool = {
    name: 'ledger_record',
    group: 'group:ledger',
    ownerTurnOnly: true,
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
        replaces: { type: 'string', description: 'Fact id or entity name this fact clinically REPLACES (e.g. a new medication superseding an old one). The reverse replacedBy link is stamped automatically.' },
        corrects: { type: 'string', description: 'Fact id or entity name this fact CORRECTS (a mistaken-entity fix). The reverse correctedBy link is stamped automatically.' },
      },
      required: ['entity', 'type'],
    },
    async execute(params, context): Promise<ToolResult> {
      // Model-supplied args are untrusted: validate shapes here and return a clean, self-correctable error.
      const argErr = validateRecordArgs(params);
      if (argErr) return err(argErr);
      const entity = normalizeEntitySlug(params.entity);
      if (entity === null) {
        return err('Missing or invalid required field "entity" (a non-empty string naming the fact, e.g. "metformin").');
      }
      const type = params.type as FactType;
      if (!FACT_TYPES.includes(type)) return err(`Unknown fact type "${type}".`);
      const fields = { ...((params.fields as Record<string, string | number | string[]>) ?? {}) };

      // Field keys are model-invented names. A key that does not survive the Markdown round-trip
      // would be silently dropped, renamed, or corrupt its block (or forge ledger structure).
      for (const key of Object.keys(fields)) {
        if (!isStorableFieldKey(key)) {
          return err(`Write rejected: field key ${JSON.stringify(key.slice(0, 40))} is reserved or contains ":", "#", control characters, or edge spaces. Use a simple name such as "dose".`);
        }
      }

      // The ledger lane carries the same credential-rejection bar as memory_write: scan every
      // caller-controlled input before any write.
      const credScan = contentContainsCredentials(
        `${entity}\n${JSON.stringify(fields)}\n${(params.note as string) ?? ''}\n${(params.verbatim as string) ?? ''}`,
      );
      if (credScan.matched) {
        return err(`Write rejected: content matches credential pattern (${credScan.pattern}). Credentials must never be stored in the health memory.`);
      }

      // A medication must never be stored with an absent known_side_effects field. Resolve it once before
      // enqueue; on failure (or no resolver) fall back to [].
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
      // A deterministic idempotency key, so a replayed delivery of the same tool call returns the cached
      // original result instead of double-writing. Built from the caller-scoped identity
      // (chatId/turnId/toolCallId), NOT `provenance.capturedAt`, which is stamped fresh per call and would
      // defeat replay detection. No key when the caller supplies no chatId/turnId.
      const idempotencyKey = context?.chatId && context?.turnId
        ? computeIdempotencyKey({
          chatId: context.chatId,
          turnMessageId: context.turnId,
          toolCallId: context.toolCallId,
          canonicalParams: {
            entity, type, fields, source, confidence,
            safetyRelevant: params.safety_relevant,
            episodeId: params.episode_id,
            language: params.language,
            verbatim: params.verbatim,
            note: params.note,
            replaces: params.replaces,
            corrects: params.corrects,
          },
        })
        : undefined;
      let result: RecordFactResult | void;
      try {
        result = await deps.pipeline.ingest({
          kind: 'ledger-fact',
          idempotencyKey,
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
            replaces: normalizeEntitySlug(params.replaces) ?? undefined,
            corrects: normalizeEntitySlug(params.corrects) ?? undefined,
          },
        });
      } catch (e) {
        const message = e !== null && typeof e === 'object' && 'message' in e
          ? String((e as { message?: unknown }).message)
          : '';
        if (message === 'invalid-cross-link' || message === 'unresolved-cross-link') {
          return err('Write rejected: cross-link target could not be resolved.');
        }
        if (e instanceof LedgerUnreadableError) return err(e.message);
        console.warn('[ledger_record] write failed:', summarizeErrorForLog(e));
        return err('Could not record this ledger fact. Please try again.');
      }
      bindRecordTokens(result, context);
      return renderRecordResult(result, entity, type);
    },
  };

  const ledgerUpdate: Tool = {
    name: 'ledger_update',
    group: 'group:ledger',
    ownerTurnOnly: true,
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
    async execute(params, context): Promise<ToolResult> {
      // Same boundary rule as ledger_record: clean, self-correctable errors.
      if (typeof params.tokenId !== 'string' || params.tokenId.trim() === '') {
        return err('Missing or invalid required field "tokenId" (the confirmation token id string from ledger_record).');
      }
      if (typeof params.confirm !== 'boolean') {
        return err('Missing or invalid required field "confirm" (must be true or false).');
      }
      if (params.winningVersion !== undefined && typeof params.winningVersion !== 'number') {
        return err('Invalid field "winningVersion": expected a number.');
      }
      if (params.reason !== undefined && typeof params.reason !== 'string') {
        return err('Invalid field "reason": expected a string.');
      }
      const tokenId = params.tokenId as string;
      const confirm = params.confirm as boolean;
      const winningVersion = params.winningVersion as number | undefined;

      if (confirm === false) {
        // A decline burns the token: a replayed or hallucinated confirm cannot apply it later in its window.
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
              confirmationContext(context),
            );
            // A confirmed safety-relevant change must re-render SAFETY.md in the same op.
            if (applied.safetyRelevant) await refreshSafetyView(deps.safety);
            // Back-link for the confirmed fact: dispute resolutions and confirmed writes otherwise never
            // appear in the daily log index.
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
            // In-lock: the FactMirror update lands atomically with this confirm.
            await afterTier1(applied.type);
            return applied;
          },
        });
        // Off-lock: re-derive chunk index bookkeeping so the confirmed change (supersession, retraction,
        // discontinuation, dispute resolution) reaches the next turn's context.
        await afterMutation(fact.type);
        return ok(`Confirmed: ${fact.entity} (${fact.type}) is now ${fact.status} as ${fact.id}.`);
      } catch (e) {
        // Raw provider/store errors can echo entity names (health content). Token rejections carry a fixed
        // PHI-free reason; everything else is logged sanitized and reported generically.
        if (e instanceof TokenRejectedError) {
          return err(`Could not apply confirmation: ${e.message}`);
        }
        if (e instanceof LedgerUnreadableError) return err(e.message);
        console.warn('[ledger_update] confirm failed:', summarizeErrorForLog(e));
        return err('Could not apply confirmation. Please re-state the change to get a fresh proposal.');
      }
    },
  };

  const ledgerRemove: Tool = {
    name: 'ledger_remove',
    group: 'group:ledger',
    ownerTurnOnly: true,
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
    async execute(params, context): Promise<ToolResult> {
      // Boundary validation: a non-string entity/reason would otherwise TypeError deep in sanitize/parse.
      const entity = normalizeEntitySlug(params.entity);
      if (entity === null) {
        return err('Missing or invalid required field "entity" (a non-empty string naming the fact to remove).');
      }
      const type = params.type as FactType;
      if (!FACT_TYPES.includes(type)) return err(`Unknown fact type "${type}".`);
      if (params.reason !== undefined && typeof params.reason !== 'string') {
        return err('Invalid field "reason": expected a string.');
      }
      // The reason persists into a ledger type file, so it passes the same credential bar and single-line
      // discipline as every other caller-controlled input. A multi-line reason could forge version blocks
      // (fake ACTIVE med facts) on re-parse.
      let reason = (params.reason as string | undefined) ?? undefined;
      if (reason !== undefined) {
        const credScan = contentContainsCredentials(reason);
        if (credScan.matched) {
          return err(`Write rejected: content matches credential pattern (${credScan.pattern}). Credentials must never be stored in the health memory.`);
        }
        reason = sanitizeSingleLine(reason);
        if (reason === '') reason = undefined;
      }

      // The agent-facing removal surface. It routes through the ledger's discontinuation flow so medication
      // removal is user-confirmed and every version stays preserved (soft delete). The SAFETY re-render and
      // FactMirror derivation run inside the write lock, like `ledger_update`'s confirm path.
      const result = await deps.queue.enqueue('turn', {
        label: 'ledger_remove:discontinue',
        run: async () => {
          const outcome = await deps.ledger.discontinue(entity, type, provenance('user', 0.9), { reason });
          if (outcome.kind === 'applied') {
            if (outcome.fact.safetyRelevant) await refreshSafetyView(deps.safety);
            await afterTier1(outcome.fact.type);
          }
          return outcome;
        },
      });

      if (result.kind === 'noop') {
        return ok(`Nothing to remove: ${result.reason.replace(/-/g, ' ')}.`);
      }
      if (result.kind === 'needs-confirmation') {
        if (result.token) deps.ledger.bindTokenContext(result.token.uuid, confirmationContext(context));
        return ok(
          `Removing ${entity} needs your confirmation. To apply, call ledger_update with tokenId="${result.token.uuid}" and confirm=true; to decline, confirm=false.\n` +
          `current: ${summarizeFields(result.fact)}`,
        );
      }
      // Off-lock: a direct-applied (non-medication) removal also bypasses the pipeline, so re-derive chunk
      // index bookkeeping so recall drops it.
      await afterMutation(result.fact.type);
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
      const entity = params.entity === undefined ? undefined : normalizeEntitySlug(params.entity);
      if (params.entity !== undefined && entity === null) {
        return err('Invalid field "entity": expected a non-empty name without control or heading characters.');
      }
      const type = params.type as FactType | undefined;
      const status = (params.status as string) ?? 'active';
      if (type && !FACT_TYPES.includes(type)) return err(`Unknown fact type "${type}".`);

      // Surface any dual-active conflict so the agent asks the user to clarify, instead of silently masking
      // a head (getActive returns only the max version).
      const conflicts = type ? await deps.ledger.listActiveConflicts(type) : [];

      if (entity && type) {
        const hasConflict = conflicts.includes(entity);
        const facts = status === 'all'
          ? await deps.ledger.getChain(entity, type)
          : hasConflict
            ? (await deps.ledger.listByType(type)).filter((f) => f.entity === entity)
            : ((f): LedgerFact[] => (f ? [f] : []))(await deps.ledger.getActive(entity, type));
        const links = await deps.ledger.getCrossLinks(entity, type);
        const linkLines: string[] = [];
        if (links.replaces.length) linkLines.push(`replaces: ${links.replaces.join(', ')}`);
        if (links.replacedBy.length) linkLines.push(`replacedBy: ${links.replacedBy.join(', ')}`);
        if (links.corrects.length) linkLines.push(`corrects: ${links.corrects.join(', ')}`);
        if (links.correctedBy.length) linkLines.push(`correctedBy: ${links.correctedBy.join(', ')}`);
        const linkText = linkLines.length ? `\ncross-links → ${linkLines.join(' · ')}` : '';
        const warn = hasConflict
          ? `⚠️ CONFLICT: ${entity} has multiple active records — ask the user which is current.\n`
          : '';
        return ok(warn + renderFacts(facts) + linkText);
      }

      if (type) {
        const warn = conflicts.length
          ? `⚠️ CONFLICT: multiple active records exist for ${conflicts.join(', ')} — ask the user to clarify which is current.\n`
          : '';
        return ok(warn + renderFacts(await deps.ledger.listByType(type)));
      }

      return err('ledger_query needs at least a type (optionally with an entity).');
    },
  };

  return [ledgerRecord, ledgerRemove, ledgerUpdate, ledgerQuery];
}
