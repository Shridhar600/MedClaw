import type { Clock } from '../ports';
import { systemClock } from '../ports';
import { assertSafetyInjected } from './safety-invariant';
import { InvariantViolationError } from '../shared/errors';

// The v2 ContextAssembler. Builds the spec-14 §1 injection map (system-message rows 1–9) fresh
// EVERY turn (D9): SAFETY is re-read each assemble so a mid-session safety-relevant mutation reaches
// the running prompt without a restart. History (row 10) stays SessionManager-owned and is NOT
// rendered here (v2-M-5). context2 is ports-only — it never imports legacy modules (providers,
// memory, agent), so `assemble` returns the system-message BODY as a plain string; the caller wraps
// it into a provider `Message[]`.

export type AssemblerMode = 'chat' | 'heartbeat' | 'dream' | 'subagent';

export type ContextReadStatus = 'present' | 'absent' | 'unreadable' | 'provider-unavailable';

export interface ContextReadResult {
  content: string | null;
  status: ContextReadStatus;
  /** The source was readable, but its content was bounded before assembly. */
  truncated?: boolean;
}

export type MemoryBudgetRatios = Partial<Record<'health' | 'life' | 'agent', number>>;

/** Reads workspace skeleton files (SOUL/USER/MEMORY/…). MemoryEngine satisfies this structurally. */
export interface WorkspaceReader {
  readFile(relPath: string): Promise<string | null>;
  /** Optional typed read seam for callers that can distinguish absence from an outage. */
  readFileWithStatus?(relPath: string): Promise<ContextReadResult>;
}

/** Bounded MEMORY.md reader supplied by the composition root. */
export interface CuratedMemoryReader {
  readForContext(maxChars: number, budgetRatios?: MemoryBudgetRatios): Promise<ContextReadResult>;
}

/** Provides the current rendered SAFETY.md. SafetyView satisfies this structurally. */
export interface SafetyReader {
  read(): Promise<string | null>;
}

/**
 * The slice of a RecallEngine `RecallReport` the assembler consumes (structural — no cross-v2
 * import). Recalled hits carry their `id` so the assembler can render them with a citable tag for
 * the B7 `<used>` feedback loop (H-3).
 */
export interface AssemblerRecall {
  /** Stage-1 active-ledger one-liners (all active health facts). */
  ledger: string;
  /** Stage-1 dropped one or more facts at its own budget boundary. */
  ledgerTruncated?: boolean;
  /** Stage-2 hybrid-recall hits, budget-bounded by the engine. */
  hits: readonly { id: string; content: string }[];
  /** Stage-3 deterministic side-effect CHECK: lines. */
  checkNotes: string;
  /** Due curiosity follow-ups for the heartbeat-only surface. */
  curiosity?: readonly {
    id: string;
    description: string;
    kind?: string;
    critical?: boolean;
    dueAt?: string;
  }[];
  /** Read status for the heartbeat curiosity source, when it could not be read. */
  curiosityStatus?: Exclude<ContextReadStatus, 'present' | 'absent'>;
}

export interface ContextSection {
  key: string;
  title: string;
  /** L1 manual = 1, L2 skeleton (persona/user/safety/memory) = 2, L3 volatile (recall/runtime) = 3. */
  layer: number;
  /** Above the cache boundary (prefix-cache-friendly): composed only from file reads, no clock. */
  cacheStable: boolean;
  /** Char allotment this section received (its full length for non-truncatable SAFETY). */
  budget: number;
  /** Content as PLACED in the prompt (post-truncation for truncatable sections). */
  content: string;
  /** SAFETY: emitted in full regardless of budget (PLAT-05). */
  nonTruncatable?: boolean;
  /** Typed degradation status for an optional source. */
  status?: ContextReadStatus;
  /** The source reader bounded this section before assembly. */
  truncated?: boolean;
}

export interface ContextDegraded {
  key: string;
  status: Exclude<ContextReadStatus, 'present' | 'absent'>;
}

export interface ContextReport {
  /** The assembled system-message body (a single system message; caller wraps into Message[]). */
  content: string;
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  truncated: boolean;
  /** Optional context sources that were unavailable; absence is deliberately not reported. */
  degraded: ContextDegraded[];
  /** sections[0..cacheBoundaryIndex-1] are cacheStable; [cacheBoundaryIndex..] are volatile. */
  cacheBoundaryIndex: number;
}

export interface AssemblerDeps {
  reader: WorkspaceReader;
  safety: SafetyReader;
  maxChars: number;
  clock?: Clock;
  curatedMemory?: CuratedMemoryReader;
  budgetRatios?: MemoryBudgetRatios;
}

const SEPARATOR = '\n\n---\n\n';

// Skeleton files above the cache boundary, in stable order, per mode (spec 06 §2 / amendment C5a):
//   chat      — full L2 skeleton. HEALTH_PROFILE.md kept as its own section (parity — not folded).
//   heartbeat — L1-lite persona + the HEARTBEAT.md checklist only; no full MEMORY / USER / profile.
//   dream     — NO persona/user (consolidation turn over the user's own memory).
//   subagent  — none (PHI-minimal; task + tool docs are the runner's job, not the assembler — KNEE-05).
const SOUL = { key: 'SOUL.md', title: 'SOUL' };
const HEALTH_PROFILE = { key: 'HEALTH_PROFILE.md', title: 'HEALTH PROFILE' };
const USER = { key: 'USER.md', title: 'USER' };
const HEARTBEAT = { key: 'HEARTBEAT.md', title: 'HEARTBEAT' };
const MEMORY = { key: 'MEMORY.md', title: 'MEMORY' };

const SKELETON_BY_MODE: Record<AssemblerMode, { key: string; title: string }[]> = {
  chat: [SOUL, HEALTH_PROFILE, USER, HEARTBEAT, MEMORY],
  heartbeat: [SOUL, HEARTBEAT],
  dream: [],
  subagent: [],
};

// Which volatile recall sections each mode renders (runtime is always emitted).
//   chat      — full recall (active ledger + hits + CHECK).
//   heartbeat — Stage-1 active-ledger one-liners only (KNEE-02); no user-message recall/CHECK.
//   dream/subagent — none.
const VOLATILE_BY_MODE: Record<AssemblerMode, { ledger: boolean; hits: boolean; check: boolean }> = {
  chat: { ledger: true, hits: true, check: true },
  heartbeat: { ledger: true, hits: false, check: false },
  dream: { ledger: false, hits: false, check: false },
  subagent: { ledger: false, hits: false, check: false },
};

const MAX_HEARTBEAT_CURIOSITY_ITEMS = 5;
const MAX_HEARTBEAT_CURIOSITY_ID_CHARS = 128;
const MAX_HEARTBEAT_CURIOSITY_DESCRIPTION_CHARS = 512;

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Structural cache-boundary guard (C1.3 / H-2): the cacheStable partition must be contiguous at the
 * front — once a volatile section appears, no later section may be cacheStable. A violation is an
 * assembler bug (it would poison prefix caching), so it throws. This checks ORDERING only; it never
 * regexes file bytes (a user's own MEMORY.md date must never abort the turn).
 */
export function assertCacheDiscipline(sections: ContextSection[]): void {
  let seenVolatile = false;
  for (const s of sections) {
    if (!s.cacheStable) {
      seenVolatile = true;
      continue;
    }
    if (seenVolatile) {
      throw new InvariantViolationError(
        `cache-boundary violation: cacheStable section "${s.key}" follows a volatile section`,
      );
    }
  }
}

interface RawSection {
  key: string;
  title: string;
  layer: number;
  cacheStable: boolean;
  content: string;
  nonTruncatable?: boolean;
  status?: ContextReadStatus;
  truncated?: boolean;
}

export class ContextAssembler {
  private readonly clock: Clock;

  constructor(private readonly deps: AssemblerDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  async assemble(
    profileId: string,
    mode: AssemblerMode,
    recall: AssemblerRecall | null,
  ): Promise<ContextReport> {
    // The reader/safety ports are already profile-scoped by the Gateway (one assembler per profile);
    // profileId is retained in the signature for the injection-map contract (v2-H-4).
    void profileId;

    const raw: RawSection[] = [];
    const degraded: ContextDegraded[] = [];
    const vol = VOLATILE_BY_MODE[mode];

    // 1. SAFETY first, in full, non-truncatable, above the boundary (KNEE-07 SAFETY-first mechanism).
    //    Re-read every turn (D9). Empty / whitespace-only => skipped (PLAT-04). Dream and subagent
    //    turns are PHI-minimal: they must not even read SAFETY (spec 03 §3 / PLAT-21).
    const safetyContent = mode === 'chat' || mode === 'heartbeat' ? await this.readSafety() : null;
    if (safetyContent && safetyContent.trim() !== '') {
      raw.push({ key: 'SAFETY.md', title: 'SAFETY', layer: 1, cacheStable: true, content: safetyContent, nonTruncatable: true });
    }

    // 2. Build volatile sections before reading optional stable prose. Their complete framed size
    //    is reserved so a large MEMORY.md cannot consume the ledger/recall allocation.
    const volatile = this.volatileSections(mode, recall, vol);
    const reservedVolatile = this.reserveVolatile(volatile);

    // 3. Skeleton files (cacheStable), narrowed by mode. Missing / empty files are skipped.
    for (const { key, title } of this.skeletonFor(mode)) {
      const result = key === MEMORY.key && this.deps.curatedMemory
        ? await this.readCuratedMemory(Math.max(0, this.deps.maxChars - reservedVolatile))
        : await this.readFile(key);
      if (result.status === 'present' && result.content && result.content.trim() !== '') {
        raw.push({
          key,
          title,
          layer: 2,
          cacheStable: true,
          content: result.content,
          truncated: result.truncated,
        });
      } else if (result.status !== 'present' && result.status !== 'absent') {
        degraded.push({ key, status: result.status });
        raw.push({
          key,
          title: `${title} STATUS`,
          layer: 2,
          cacheStable: true,
          content: `[context-degraded: ${key} ${result.status}]`,
          nonTruncatable: true,
          status: result.status,
        });
      }
    }

    // 4. Volatile recall sections are below the boundary. Today's/yesterday's blanket daily-log dump
    //    is RETIRED in favor of RECALL (parity
    //    decision, recorded — active facts still injected via SAFETY + Stage-1 ledger; recent turns
    //    live in the SessionManager-owned history row).
    raw.push(...volatile);

    const { sections, content, truncated } = this.compose(raw, reservedVolatile);

    // Cache discipline + SAFETY non-omission, per turn (D9 / PLAT-04/05). medical-safety > resilience.
    assertCacheDiscipline(sections);
    assertSafetyInjected(content, safetyContent);

    const cacheBoundaryIndex = (() => {
      const idx = sections.findIndex(s => !s.cacheStable);
      return idx === -1 ? sections.length : idx;
    })();

    return {
      content,
      sections,
      totalChars: content.length,
      totalTokens: estimateTokens(content),
      truncated,
      degraded,
      cacheBoundaryIndex,
    };
  }

  // ---- mode-specific section sets (C2 narrows these) --------------------------------------

  private skeletonFor(mode: AssemblerMode): { key: string; title: string }[] {
    return SKELETON_BY_MODE[mode];
  }

  // ---- rendering helpers -----------------------------------------------------------------

  private runtimeLine(hitsShown: boolean): string {
    const day = this.clock.now().toISOString().slice(0, 10);
    let line = `Today is ${day}.`;
    if (hitsShown) {
      line += '\n\nWhen you use a recalled item above, end your reply with a single line: '
        + '<used>id1,id2</used> listing the ids you used (omit the line if you used none).';
    }
    return line;
  }

  private compose(raw: RawSection[], reservedVolatile = 0): { sections: ContextSection[]; content: string; truncated: boolean } {
    const sections: ContextSection[] = [];
    const parts: string[] = [];
    let used = 0;
    let truncated = raw.some(cand => cand.truncated === true);

    for (const cand of raw) {
      const separator = parts.length > 0 ? SEPARATOR : '';
      const header = `## ${cand.title}\n\n`;

      if (cand.nonTruncatable) {
        const chunk = `${separator}${header}${cand.content}`;
        parts.push(chunk);
        used += chunk.length;
        sections.push(this.toSection(cand, cand.content, cand.content.length));
        continue;
      }

      const remaining = cand.cacheStable && reservedVolatile > 0
        ? Math.min(this.deps.maxChars - used, this.deps.maxChars - used - reservedVolatile)
        : this.deps.maxChars - used;
      const framing = separator.length + header.length;
      if (remaining <= 0 || framing >= remaining) {
        truncated = true;
        continue;
      }
      const contentBudget = remaining - framing;
      const body = this.fitContent(cand.key, cand.content, contentBudget);
      if (body.length === 0) {
        truncated = true;
        continue;
      }
      if (body.length < cand.content.length) truncated = true;
      const chunk = `${separator}${header}${body}`;
      parts.push(chunk);
      used += chunk.length;
      sections.push(this.toSection(cand, body, contentBudget));
    }

    return { sections, content: parts.join(''), truncated };
  }

  private toSection(cand: RawSection, content: string, budget: number): ContextSection {
    return {
      key: cand.key,
      title: cand.title,
      layer: cand.layer,
      cacheStable: cand.cacheStable,
      budget,
      content,
      ...(cand.nonTruncatable ? { nonTruncatable: true } : {}),
      ...(cand.status ? { status: cand.status } : {}),
      ...(cand.truncated ? { truncated: true } : {}),
    };
  }

  private async readSafety(): Promise<string | null> {
    // NO swallow (H-1): the SafetyReader returns null only for a genuinely absent/empty SAFETY
    // (PLAT-04). A read error (EACCES/EISDIR/I/O) THROWS and must propagate — it aborts the turn to
    // the caller's safe fallback rather than silently shipping a prompt with no safety constitution
    // (medical-safety > resilience). This is the ONE place resilience does not apply.
    return this.deps.safety.read();
  }

  private async readFile(relPath: string): Promise<ContextReadResult> {
    try {
      if (this.deps.reader.readFileWithStatus) {
        return this.normalizeReadResult(await this.deps.reader.readFileWithStatus(relPath));
      }
      const content = await this.deps.reader.readFile(relPath);
      return { content, status: content === null ? 'absent' : 'present' };
    } catch (error) {
      return { content: null, status: this.classifyReadError(error) };
    }
  }

  private async readCuratedMemory(maxChars: number): Promise<ContextReadResult> {
    try {
      return this.normalizeReadResult(
        await this.deps.curatedMemory!.readForContext(maxChars, this.deps.budgetRatios),
      );
    } catch (error) {
      return { content: null, status: this.classifyReadError(error) };
    }
  }

  private normalizeReadResult(result: ContextReadResult): ContextReadResult {
    if (result.status === 'absent') return { ...result, content: null };
    if (result.status === 'present' && (result.content === null || result.content === undefined)) {
      return { ...result, content: null, status: 'absent' };
    }
    return result;
  }

  private classifyReadError(error: unknown): Exclude<ContextReadStatus, 'present' | 'absent'> {
    if (typeof error === 'object' && error !== null) {
      const status = (error as { status?: unknown }).status;
      if (status === 'provider-unavailable' || status === 'unreadable') return status;
      const code = (error as { code?: unknown }).code;
      if (code === 'ERR_PROVIDER_UNAVAILABLE' || code === 'PROVIDER_UNAVAILABLE') return 'provider-unavailable';
    }
    return 'unreadable';
  }

  private volatileSections(
    mode: AssemblerMode,
    recall: AssemblerRecall | null,
    vol: { ledger: boolean; hits: boolean; check: boolean },
  ): RawSection[] {
    const sections: RawSection[] = [];
    let hitsShown = false;
    if (recall) {
      if (vol.ledger && (recall.ledger.trim() !== '' || recall.ledgerTruncated)) {
        const ledger = recall.ledgerTruncated
          ? (recall.ledger.trim() !== '' ? `${recall.ledger}\n… (truncated)` : '… (truncated)')
          : recall.ledger;
        sections.push({ key: 'active-ledger', title: 'ACTIVE HEALTH FACTS', layer: 3, cacheStable: false, content: ledger });
      }
      if (vol.hits && recall.hits.length > 0) {
        const body = recall.hits.map(h => `- [${h.id}] ${h.content}`).join('\n');
        sections.push({ key: 'recall', title: 'RECALL', layer: 3, cacheStable: false, content: body });
        hitsShown = true;
      }
      if (vol.check && recall.checkNotes && recall.checkNotes.trim() !== '') {
        sections.push({ key: 'check', title: 'CHECK', layer: 3, cacheStable: false, content: recall.checkNotes });
      }
      if (mode === 'heartbeat' && recall.curiosityStatus) {
        sections.push({
          key: 'curiosity-status',
          title: 'FOLLOW-UP STATUS',
          layer: 3,
          cacheStable: false,
          content: `[context-degraded: curiosity ${recall.curiosityStatus}]`,
          status: recall.curiosityStatus,
        });
      } else if (mode === 'heartbeat' && recall.curiosity && recall.curiosity.length > 0) {
        const items = recall.curiosity.slice(0, MAX_HEARTBEAT_CURIOSITY_ITEMS);
        const body = items.map(item => {
          const id = this.safeSlice(item.id, MAX_HEARTBEAT_CURIOSITY_ID_CHARS);
          const description = item.description.length > MAX_HEARTBEAT_CURIOSITY_DESCRIPTION_CHARS
            ? `${this.safeSlice(item.description, MAX_HEARTBEAT_CURIOSITY_DESCRIPTION_CHARS)}… (truncated)`
            : item.description;
          return `- [${id}] ${description}`;
        }).join('\n');
        sections.push({ key: 'curiosity', title: 'DUE FOLLOW-UPS', layer: 3, cacheStable: false, content: body });
      }
    }

    // Runtime line (volatile) — the ONLY place a clock/date value is composed in (H-2). Marked
    // non-truncatable (L-1): the day date grounds health advice and must never be evicted by
    // budget pressure (it is tiny). Still below the cache boundary (cacheStable:false).
    sections.push({
      key: 'runtime',
      title: 'RUNTIME',
      layer: 3,
      cacheStable: false,
      content: this.runtimeLine(hitsShown),
      nonTruncatable: true,
    });
    return sections;
  }

  private reserveVolatile(sections: RawSection[]): number {
    if (sections.length === 0) return 0;
    const framed = sections.reduce((sum, section) => {
      const header = `## ${section.title}\n\n`;
      return sum + header.length + section.content.length;
    }, 0);
    // One separator per volatile section is conservative: the first one separates it from the
    // stable prefix and every later one separates it from its predecessor.
    return framed + sections.length * SEPARATOR.length;
  }

  private fitContent(sectionKey: string, content: string, contentBudget: number): string {
    if (contentBudget <= 0) return '';
    if (content.length <= contentBudget) return content;

    const markerFor = (omitted: number): string => `\n\n[TRUNCATED ${sectionKey}: ${omitted} chars omitted]`;
    let marker = markerFor(0);
    if (marker.length >= contentBudget) {
      return this.safeSlice(markerFor(content.length), contentBudget);
    }

    const allowed = Math.max(0, contentBudget - marker.length);
    let truncated = this.safeSlice(content, allowed);
    let omitted = content.length - truncated.length;
    marker = markerFor(omitted);

    while (truncated.length + marker.length > contentBudget && truncated.length > 0) {
      truncated = this.safeSlice(truncated, truncated.length - 1);
      omitted = content.length - truncated.length;
      marker = markerFor(omitted);
    }

    return `${truncated}${marker}`;
  }

  private safeSlice(value: string, maxChars: number): string {
    if (maxChars <= 0) return '';
    if (value.length <= maxChars) return value;
    let sliced = value.slice(0, maxChars);
    const last = sliced.charCodeAt(sliced.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) sliced = sliced.slice(0, -1);
    return sliced;
  }
}
