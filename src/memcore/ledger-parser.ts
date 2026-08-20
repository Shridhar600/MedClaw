import { Authority, AUTHORITY_RANK, FactStatus, FactType, LedgerFact } from './types';

function detectValue(raw: string): string | number | string[] {
  const trimmed = raw.trim();
  if (/^\[.*\]$/.test(trimmed)) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => s.trim());
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  if (trimmed === 'true') return 'true' as unknown as number;
  if (trimmed === 'false') return 'false' as unknown as number;
  return trimmed;
}

function parseProvenance(rawValue: string): { source: Authority; confidence: number; anchor: string; note?: string } | null {
  // Split on the bare middot and trim each segment. An empty anchor is a legitimate
  // state (a fact recorded before its narrative anchor is known), and the reader trims
  // the renderer's trailing `· ` down to `·` — so tolerate a missing/empty anchor rather
  // than rejecting the line (which silently quarantined the whole block and fabricated a
  // v0 "active" fact on the next read).
  const parts = rawValue.split('·').map(s => s.trim());

  const sourceMatch = parts[0].match(/^([a-zA-Z]+)\s*\(([\d.]+)\)/);
  if (!sourceMatch) return null;

  const source = sourceMatch[1] as Authority;
  const confidence = parseFloat(sourceMatch[2]);
  const anchor = parts[1] ?? '';
  let note: string | undefined;
  if (parts.length > 2) {
    note = parts.slice(2).join(' · ').replace(/^"(.*)"$/, '$1');
  }

  return {
    source: source in AUTHORITY_RANK ? source : 'user',
    confidence,
    anchor,
    note,
  };
}

function parseCombinedMetaValues(firstKey: string, rawValue: string): { safetyRelevant?: boolean; episodeId?: string; language?: string } {
  const result: { safetyRelevant?: boolean; episodeId?: string; language?: string } = {};
  const fullRaw = `${firstKey}: ${rawValue}`;
  const pairs = fullRaw.split(' · ');
  for (const pair of pairs) {
    const colonIdx = pair.indexOf(': ');
    if (colonIdx < 0) continue;
    const k = pair.slice(0, colonIdx).trim();
    const v = pair.slice(colonIdx + 2).trim();
    if (k === 'safety_relevant') result.safetyRelevant = v === 'true';
    else if (k === 'episode') result.episodeId = v;
    else if (k === 'lang') result.language = v;
  }
  return result;
}

export function renderLedgerFile(facts: LedgerFact[]): string {
  const groups = new Map<string, LedgerFact[]>();
  for (const f of facts) {
    if (!groups.has(f.entity)) groups.set(f.entity, []);
    groups.get(f.entity)!.push(f);
  }

  const sortedEntities = Array.from(groups.keys()).sort();
  const blocks: string[] = [];

  for (const entity of sortedEntities) {
    const versions = groups.get(entity)!;
    versions.sort((a, b) => b.version - a.version);
    blocks.push(`## ${entity}`);
    for (const v of versions) {
      const headerDate = v.createdAt ? v.createdAt.slice(0, 10) : '';
      if (v.status === 'active') {
        blocks.push(`### v${v.version} (active)`);
      } else {
        blocks.push(`### v${v.version} (${v.status}${headerDate ? ` ${headerDate}` : ''})`);
      }
      const vLines = flattenFactForRender(v);
      blocks.push(...vLines);
    }
  }

  return blocks.join('\n') + '\n';
}

function flattenFactForRender(fact: LedgerFact): string[] {
  const lines: string[] = [];

  lines.push(`- provenance: ${fact.provenance.source} (${fact.provenance.confidence.toFixed(2)}) · ${fact.provenance.anchor}${fact.provenance.note ? ` · "${fact.provenance.note}"` : ''}`);

  if (fact.provenance.capturedAt) {
    lines.push(`- captured_at: ${fact.provenance.capturedAt}`);
  }

  const metaParts: string[] = [];
  metaParts.push(`safety_relevant: ${fact.safetyRelevant}`);
  if (fact.episodeId) metaParts.push(`episode: ${fact.episodeId}`);
  if (fact.language && fact.language !== 'en') metaParts.push(`lang: ${fact.language}`);
  if (metaParts.length > 0) {
    lines.push(`- ${metaParts.join(' · ')}`);
  }

  if (fact.verbatim !== undefined && fact.verbatim !== '') {
    lines.push(`- verbatim: "${fact.verbatim}"`);
  }
  if (fact.visibility) {
    lines.push(`- visibility: ${fact.visibility}`);
  }
  if (fact.supersedes) {
    lines.push(`- supersedes: ${fact.supersedes}`);
  }
  if (fact.supersededBy) {
    lines.push(`- supersededBy: ${fact.supersededBy}`);
  }
  // Cross-entity links + discontinue reason are top-level fields, so they need
  // explicit render/parse (the generic `fields` fallback only covers `fields` keys).
  if (fact.replaces) {
    lines.push(`- replaces: ${fact.replaces}`);
  }
  if (fact.replacedBy) {
    lines.push(`- replacedBy: ${fact.replacedBy}`);
  }
  if (fact.corrects) {
    lines.push(`- corrects: ${fact.corrects}`);
  }
  if (fact.correctedBy) {
    lines.push(`- correctedBy: ${fact.correctedBy}`);
  }
  if (fact.discontinuedReason) {
    lines.push(`- discontinuedReason: ${fact.discontinuedReason}`);
  }

  if (fact.createdAt) {
    lines.push(`- created_at: ${fact.createdAt}`);
  }

  for (const [key, value] of Object.entries(fact.fields)) {
    if (key === 'pre_pause_summary' || key === 'restartOf' || key === 'created_at') {
      if (key === 'pre_pause_summary') {
        lines.push(`- pre_pause_summary: ${value}`);
      }
      if (key === 'restartOf') {
        lines.push(`- restartOf: ${value}`);
      }
      continue;
    }
    // Reserved names are rendered from their top-level `fact.*` field above; a
    // `fields` entry with the same name must NOT also render (it would re-parse
    // into the top-level slot and corrupt the round-trip). These names are
    // therefore reserved and cannot be used as generic field keys.
    if (RESERVED_TOP_LEVEL_FIELD_KEYS.has(key)) {
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`- ${key}: [${value.join(', ')}]`);
    } else {
      lines.push(`- ${key}: ${value}`);
    }
  }

  return lines;
}

/** Field-key names that render as top-level `- key:` lines and re-parse into `fact.*`, never `fields`. */
const RESERVED_TOP_LEVEL_FIELD_KEYS = new Set<string>([
  'provenance', 'captured_at', 'safety_relevant', 'episode', 'lang',
  'verbatim', 'visibility', 'supersedes', 'supersededBy',
  'replaces', 'replacedBy', 'corrects', 'correctedBy', 'discontinuedReason', 'created_at',
]);

export function parseLedgerFile(md: string, options: { type: FactType; profileId: string }): LedgerFact[] {
  const facts: LedgerFact[] = [];

  const entityMatches = Array.from(md.matchAll(/^## (.+)$/gm));
  if (entityMatches.length === 0) return facts;

  for (let i = 0; i < entityMatches.length; i++) {
    const entityName = entityMatches[i][1];
    const sectionStart = entityMatches[i].index!;
    const sectionEnd = i + 1 < entityMatches.length ? entityMatches[i + 1].index! : md.length;
    const sectionContent = md.slice(sectionStart, sectionEnd);

    const versionMatches = Array.from(sectionContent.matchAll(/^### v(\d+) \((\w+)(?: ([^)]+))?\)$/gm));
    if (versionMatches.length === 0) continue;

    for (let j = 0; j < versionMatches.length; j++) {
      const vm = versionMatches[j];
      const version = parseInt(vm[1]);
      const rawStatus = vm[2] as string;
      const status = rawStatus as FactStatus;
      const headerEnd = vm.index! + vm[0].length;
      const blockEnd = j + 1 < versionMatches.length ? versionMatches[j + 1].index! : sectionContent.length;
      const blockBody = sectionContent.slice(headerEnd, blockEnd);

      try {
        const fact = parseSingleVersionBlock(entityName, version, status, blockBody, options);
        if (fact) facts.push(fact);
      } catch {
        const errorId = `${entityName}@v${version}`;
        facts.push(createParseErrorFact(entityName, options, `PARSE-ERROR block for ${errorId}: unparsable content`));
      }
    }
  }

  return facts;
}

function createParseErrorFact(entity: string, options: { type: FactType; profileId: string }, body: string): LedgerFact {
  return {
    id: `${entity}@v0`,
    profileId: options.profileId,
    entity: entity || '__quarantine__',
    type: options.type,
    version: 0,
    status: 'active',
    fields: { _quarantine: body },
    provenance: { source: 'user', confidence: 1, anchor: '', capturedAt: new Date().toISOString() },
    safetyRelevant: false,
    language: 'en',
    visibility: 'private',
    createdAt: new Date().toISOString(),
  };
}

function parseSingleVersionBlock(
  entity: string,
  version: number,
  status: FactStatus,
  body: string,
  options: { type: FactType; profileId: string },
): LedgerFact | null {
  const lines = body.split('\n').filter(l => l.startsWith('- '));
  const fields: Record<string, string | number | string[]> = {};

  let provSource: Authority = 'user';
  let provConfidence = 1;
  let provAnchor = '';
  let provNote: string | undefined;
  let capturedAt = '';
  let safetyRelevant = false;
  let episodeId: string | undefined;
  let language = 'en';
  let verbatim: string | undefined;
  let visibility: 'private' | 'shareable-summary' | 'shareable-full' = 'private';
  let supersedes: string | undefined;
  let supersededByVal: string | undefined;
  let replaces: string | undefined;
  let replacedBy: string | undefined;
  let corrects: string | undefined;
  let correctedBy: string | undefined;
  let discontinuedReason: string | undefined;
  let createdAt = new Date().toISOString();
  let sawProvenance = false;

  for (const line of lines) {
    const colonIdx = line.indexOf(': ');
    if (colonIdx < 0) continue;
    const key = line.slice(2, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 2).trim();

    if (key === 'provenance') {
      const parsed = parseProvenance(rawVal);
      if (parsed) {
        provSource = parsed.source;
        provConfidence = parsed.confidence;
        provAnchor = parsed.anchor;
        provNote = parsed.note;
        sawProvenance = true;
      }
    } else if (key === 'captured_at') {
      capturedAt = rawVal;
    } else if (key === 'safety_relevant' || key === 'episode' || key === 'lang') {
      const meta = parseCombinedMetaValues(key, rawVal);
      if (meta.safetyRelevant !== undefined) safetyRelevant = meta.safetyRelevant;
      if (meta.episodeId !== undefined) episodeId = meta.episodeId;
      if (meta.language !== undefined) language = meta.language;
    } else if (key === 'verbatim') {
      verbatim = rawVal.replace(/^"(.*)"$/, '$1');
    } else if (key === 'visibility') {
      visibility = rawVal as 'private' | 'shareable-summary' | 'shareable-full';
    } else if (key === 'supersedes') {
      supersedes = rawVal;
    } else if (key === 'supersededBy') {
      supersededByVal = rawVal;
    } else if (key === 'replaces') {
      replaces = rawVal;
    } else if (key === 'replacedBy') {
      replacedBy = rawVal;
    } else if (key === 'corrects') {
      corrects = rawVal;
    } else if (key === 'correctedBy') {
      correctedBy = rawVal;
    } else if (key === 'discontinuedReason') {
      discontinuedReason = rawVal;
    } else if (key === 'restartOf') {
      fields.restartOf = rawVal;
    } else if (key === 'created_at') {
      createdAt = rawVal;
    } else if (key === 'pre_pause_summary') {
      fields.pre_pause_summary = rawVal;
    } else {
      fields[key] = detectValue(rawVal);
    }
  }

  // A real version block always carries a valid `- provenance:` line (the renderer
  // always emits one). Its absence means the block is corrupt → throw so the caller
  // quarantines it instead of FABRICATING an active fact from defaulted values.
  if (!sawProvenance) {
    throw new Error(`missing provenance in ${entity}@v${version}`);
  }

  const finalCreatedAt = createdAt;
  const finalCapturedAt = capturedAt || finalCreatedAt;

  const cleanFields: Record<string, string | number | string[]> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k !== 'created_at') cleanFields[k] = v;
  }

  return {
    id: `${entity}@v${version}`,
    profileId: options.profileId,
    entity,
    type: options.type,
    version,
    supersedes,
    supersededBy: supersededByVal,
    replaces,
    replacedBy,
    corrects,
    correctedBy,
    discontinuedReason,
    status,
    fields: cleanFields,
    provenance: {
      source: provSource,
      confidence: provConfidence,
      anchor: provAnchor,
      capturedAt: finalCapturedAt,
      note: provNote,
    },
    safetyRelevant,
    episodeId,
    language,
    verbatim,
    visibility,
    createdAt: finalCreatedAt,
  };
}
