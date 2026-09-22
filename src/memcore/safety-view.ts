// src/memcore/safety-view.ts
//
// SAFETY.md — the Safety Constitution. Always injected, code-enforced, agent add-only.
// This is a rendered VIEW of the ledger: the machine sections (allergies, medications,
// conditions, …) are regenerated on every render from exactly the facts where
// `safetyRelevant && status ∈ {active, resolved}` (specs/03 §3; plan Task 4).
//
// Non-machine content is never touched by the renderer:
//   - `## Critical Events` (agent add-only) is preserved verbatim; there is no API to
//     remove an event (VANI-05).
//   - `## Notes (user)` is preserved verbatim (specs/07 §3).
//   - Any OTHER section (e.g. onboarding-seeded emergency contact) is preserved verbatim
//     too — silently dropping hand-written content on first render would be data loss.
//
// No date token is ever written anywhere in the file (amendment C6a / G3). A Critical
// Event carries a `date` for the caller's bookkeeping, but the render omits it entirely;
// the day-granularity date lives only in the narrative anchor L3 references.
//
// Removal of base allergy/medication entries is refused in code without an explicit
// `userConfirmed` (CONTRA-03/04, DAD-11). Removal is still a view-side strip: the ledger
// fact must be retracted/discontinued first, then the next render keeps it out.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Clock } from '../ports';
import { systemClock } from '../ports';
import { AppError } from '../shared/errors';
import { secureWriteViaTmp, summarizeErrorForLog, quarantineToSideFile, QUARANTINE_POINTER_PREFIX } from '../security';
import type { FactType, LedgerFact } from './types';
import { sanitizeSingleLine } from './sanitize';

/** Thrown when base SAFETY.md entry removal is attempted without user confirmation. */
export class SafetyRemovalRefusedError extends AppError {
  constructor(message: string) {
    super(message);
  }
}

/** A safety projection is known to be stale or could not be durably validated. */
export class SafetyProjectionDirtyError extends AppError {
  constructor() {
    super('SAFETY.md projection is unavailable until it is successfully re-rendered');
  }
}

interface SafetyProjectionState {
  sourceGeneration: string | null;
  contentHash: string;
}

/** A Critical Event. `date` is caller bookkeeping only — the render NEVER emits it (C6a). */
export interface CriticalEvent {
  date: string;
  summary: string;
  action?: string;
}

const MACHINE_SECTION_ORDER: { type: FactType; heading: string }[] = [
  { type: 'allergy', heading: 'Allergies' },
  { type: 'medication', heading: 'Medications' },
  { type: 'condition', heading: 'Conditions' },
  { type: 'symptom', heading: 'Symptoms' },
  { type: 'appointment', heading: 'Appointments' },
  { type: 'metric', heading: 'Metrics' },
  { type: 'goal', heading: 'Goals' },
];

const MACHINE_HEADINGS = new Set(MACHINE_SECTION_ORDER.map(m => m.heading));
const MED_OR_ALLERGY_HEADINGS = new Set(['Allergies', 'Medications']);
const CRITICAL_EVENTS_HEADING = 'Critical Events';

type ParsedItem =
  | { kind: 'preamble'; lines: string[] }
  | { kind: 'quarantine'; lines: string[] }
  | { kind: 'section'; heading: string; lines: string[] };

function isMachineSection(i: ParsedItem): i is { kind: 'section'; heading: string; lines: string[] } {
  return i.kind === 'section' && MACHINE_HEADINGS.has(i.heading);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, stableValue(object[key])]));
  }
  return value;
}

export class SafetyView {
  // The clock is part of the stable constructor contract (mirrors the other memcore
  // stores). P1 renders are date-free by design (C6a), so it is currently reserved.
  constructor(
    private readonly rootDir: string,
    private readonly clock: Clock = systemClock,
    private readonly source?: () => Promise<LedgerFact[]>,
  ) {}

  private filePath(): string {
    return path.join(this.rootDir, 'SAFETY.md');
  }

  private dirtyMarkerPath(): string {
    return path.join(this.rootDir, '.state', 'safety-view.dirty');
  }

  private generationPath(): string {
    return path.join(this.rootDir, '.state', 'safety-view.generation');
  }

  /** Persist a PHI-free signal that the current SAFETY bytes must not be served. */
  markDirty(): void {
    try {
      secureWriteViaTmp(this.dirtyMarkerPath(), 'dirty\n');
    } catch (e) {
      console.warn('[safety-view] could not persist dirty marker:', summarizeErrorForLog(e));
    }
  }

  /** Regenerate SAFETY.md from the given facts; preserve Critical Events, Notes, and any other hand-written content. */
  async render(facts: LedgerFact[]): Promise<string> {
    // Mark before any read/replace so a process interruption during publication leaves a
    // durable fail-closed signal for the next turn.
    this.markDirty();
    try {
      const { items } = this.load();
      const preamble = items.find(i => i.kind === 'preamble')?.lines ?? [];
      const rest = items.filter(i => i.kind !== 'preamble');
      const preserved = rest.filter(i => i.kind !== 'section' || !MACHINE_HEADINGS.has(i.heading));
      const rebuilt: ParsedItem[] = [
        { kind: 'preamble', lines: preamble.length > 0 ? preamble : ['# Safety'] },
        ...this.renderMachineSections(facts),
        ...preserved,
      ];
      const rendered = this.writeItems(rebuilt);
      // The generation sidecar contains no health content. If it cannot be written, keep the
      // dirty marker rather than serving a file whose source generation is unknown.
      this.writeState(this.generationFor(facts), rendered);
      this.clearDirtyMarker();
      return rendered;
    } catch (e) {
      this.markDirty();
      throw e;
    }
  }

  /**
   * Append a Critical Event (agent add-only). The `date` is accepted for the caller's
   * bookkeeping but is NEVER written to SAFETY.md (C6a/G3). Returns the full rendered file.
   */
  async addCriticalEvent(ev: CriticalEvent): Promise<string> {
    const { items } = this.load();
    const bullet = `- ${sanitizeSingleLine(ev.summary)}${ev.action ? ` — ${sanitizeSingleLine(ev.action)}` : ''}`;
    const events = items.find(i => i.kind === 'section' && i.heading === CRITICAL_EVENTS_HEADING);
    if (events) {
      events.lines.push(bullet);
    } else {
      items.push({ kind: 'section', heading: CRITICAL_EVENTS_HEADING, lines: [bullet] });
    }
    return this.writeItems(items);
  }

  /**
   * Remove a base (machine-section) entry from the rendered view. Removal of a
   * med/allergy-class entry — and, conservatively, ANY machine-section entry — is
   * refused in code without an explicit `userConfirmed` (CONTRA-03/04). Critical Events
   * are not machine sections, so no API can remove them. Idempotent no-op when the
   * entity is not present. Returns the full rendered file.
   */
  async removeEntry(entity: string, opts: { userConfirmed: boolean }): Promise<string> {
    const { items } = this.load();
    const machine = items.filter(isMachineSection);
    const re = this.entityRegex(entity);
    const found = machine.find(sec => sec.lines.some(line => re.test(line)));
    if (found) {
      if (!opts.userConfirmed) {
        const message = MED_OR_ALLERGY_HEADINGS.has(found.heading)
          ? 'Removal of allergy/medication entries from SAFETY.md requires user confirmation'
          : 'Removal of SAFETY.md entries requires user confirmation';
        throw new SafetyRemovalRefusedError(message);
      }
      for (const sec of machine) {
        sec.lines = sec.lines.filter(line => !re.test(line));
      }
    }
    return this.writeItems(items);
  }

  /**
   * Current on-disk SAFETY.md, or null when the file does not exist yet (ENOENT — an empty safety
   * constitution is allowed, PLAT-04). ANY OTHER read error (EACCES/EISDIR/I/O) THROWS — this is the
   * always-injected safety constitution, so it fails CLOSED: the caller (assembler) aborts the turn
   * rather than shipping a prompt with no SAFETY (H-1; medical-safety > resilience).
   */
  async read(): Promise<string | null> {
    if (this.dirtyMarkerExists()) {
      throw new SafetyProjectionDirtyError();
    }
    try {
      const content = await fs.promises.readFile(this.filePath(), 'utf-8');
      const state = this.readState();
      if (state && state.contentHash !== this.contentHash(content)) {
        this.markDirty();
        throw new SafetyProjectionDirtyError();
      }
      if (this.source) {
        let facts: LedgerFact[];
        try {
          facts = await this.source();
        } catch {
          this.markDirty();
          throw new SafetyProjectionDirtyError();
        }
        if (
          state === null
          || state.sourceGeneration === null
          || state.sourceGeneration !== this.generationFor(facts)
          || state.contentHash !== this.contentHash(content)
        ) {
          this.markDirty();
          throw new SafetyProjectionDirtyError();
        }
      }
      return content;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        if (!this.source) return null;
        try {
          const facts = await this.source();
          if (facts.length === 0) return null;
        } catch {
          // An unavailable source is also a fail-closed condition below.
        }
        this.markDirty();
        throw new SafetyProjectionDirtyError();
      }
      if (err instanceof SafetyProjectionDirtyError) throw err;
      console.warn(`[safety-view] read failed (failing closed): ${summarizeErrorForLog(err)}`);
      throw err;
    }
  }

  // ---- internals ---------------------------------------------------------

  private renderMachineSections(facts: LedgerFact[]): ParsedItem[] {
    // DS: `disputed` facts stay on SAFETY.md (marked) so a safety-relevant fact
    // never silently leaves the always-injected net while its dispute is open.
    const eligible = facts.filter(f =>
      f.safetyRelevant && (f.status === 'active' || f.status === 'resolved' || f.status === 'disputed'));
    const byEntity = new Map<string, LedgerFact[]>();
    for (const f of eligible) {
      const key = `${f.type}::${f.entity}`;
      const group = byEntity.get(key);
      if (group) group.push(f); else byEntity.set(key, [f]);
    }

    const byType = new Map<FactType, string[]>();
    for (const group of byEntity.values()) {
      const active = group.filter((f) => f.status === 'active').sort((a, b) => a.version - b.version);
      let line: string;
      if (active.length > 1) {
        const values = active.map((f) => {
          const fields = Object.entries(f.fields)
            .map(([key, value]) => `${sanitizeSingleLine(key)}=${sanitizeSingleLine(String(value))}`)
            .join(', ');
          return `v${f.version}${fields ? ` [${fields}]` : ''}`;
        }).join(' | ');
        line = `- ${sanitizeSingleLine(active[0].entity)} — CONFLICT: multiple active ${active[0].type} records: ${values}`;
      } else {
        const settled = group.find((f) => f.status === 'active' || f.status === 'resolved');
        const chosen = settled ?? [...group].sort((a, b) => a.version - b.version)[0];
        line = this.renderFactBullet(chosen);
      }
      const type = group[0].type;
      const lines = byType.get(type);
      if (lines) lines.push(line); else byType.set(type, [line]);
    }
    const items: ParsedItem[] = [];
    for (const { type, heading } of MACHINE_SECTION_ORDER) {
      const list = byType.get(type);
      if (!list || list.length === 0) continue;
      items.push({ kind: 'section', heading, lines: list });
    }
    return items;
  }

  private renderFactBullet(f: LedgerFact): string {
    const dose = f.fields['dose'];
    const disputeMark = f.status === 'disputed' ? ' — value under dispute' : '';
    if (f.type === 'medication' && dose !== undefined && dose !== '') {
      return `- ${sanitizeSingleLine(f.entity)} — ${sanitizeSingleLine(String(dose))}${disputeMark}`;
    }
    return `- ${sanitizeSingleLine(f.entity)}${disputeMark}`;
  }

  private entityRegex(entity: string): RegExp {
    const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match the WHOLE entity segment of a bullet: `- <entity>` end-of-line, or
    // `- <entity> — <dose>`. Must NOT match a longer, distinct entity that merely
    // shares the prefix (`- penicillin` must never hit `- penicillin G`).
    return new RegExp(`^-\\s*${escaped}(?:\\s+—|\\s*$)`);
  }

  /**
   * Load the current file, degrading on corrupt read: warn (sanitized), then build from
   * a fresh skeleton while preserving any salvageable raw bytes in a quarantine note
   * (D2/F24). A corrupt file is one that fails to read as UTF-8 — either a read error or
   * a decode that produced replacement characters. Never crashes.
   */
  private load(): { items: ParsedItem[] } {
    const fp = this.filePath();
    let raw: string;
    try {
      raw = fs.readFileSync(fp, 'utf-8');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return { items: this.freshItems() };
      console.warn(`[safety-view] degraded read: ${summarizeErrorForLog(err)}`);
      return { items: this.quarantinedItems(this.salvageRaw(fp)) };
    }
    if (raw.includes('\uFFFD')) {
      console.warn('[safety-view] degraded read: invalid UTF-8 content');
      return { items: this.quarantinedItems(this.salvageRaw(fp)) };
    }
    return { items: this.parse(raw) };
  }

  private salvageRaw(fp: string): string | null {
    try {
      return fs.readFileSync(fp).toString('latin1');
    } catch {
      return null;
    }
  }

  private freshItems(): ParsedItem[] {
    return [{ kind: 'preamble', lines: ['# Safety'] }];
  }

  private quarantinedItems(salvaged: string | null): ParsedItem[] {
    const items = this.freshItems();
    if (salvaged) {
      // Salvaged bytes go to a 0600 SIDE file; only a constant, date-free pointer is
      // inlined into the always-injected SAFETY.md (no `-->` breakout, no injection
      // surface, no C6a date leak).
      items.push({ kind: 'quarantine', lines: [quarantineToSideFile(this.filePath(), salvaged)] });
    }
    return items;
  }

  private parse(md: string): ParsedItem[] {
    const items: ParsedItem[] = [];
    const lines = md.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    let current: ParsedItem | null = null;
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith(QUARANTINE_POINTER_PREFIX)) {
        // The quarantine pointer is a single self-contained comment line.
        items.push({ kind: 'quarantine', lines: [line] });
        current = null;
        i += 1;
        continue;
      }
      if (line.startsWith('## ')) {
        current = { kind: 'section', heading: line.slice(3).trim(), lines: [] };
        items.push(current);
        i += 1;
        continue;
      }
      if (!current) {
        current = { kind: 'preamble', lines: [] };
        items.push(current);
      }
      current.lines.push(line);
      i += 1;
    }
    // Blank lines between blocks are structural separators (assemble re-adds them) — keep
    // parsed blocks clean so preserved bodies and event appends stay tidy across re-renders.
    for (const item of items) {
      if (item.kind !== 'quarantine') item.lines = this.trimOuterBlank(item.lines);
    }
    return items;
  }

  private writeItems(items: ParsedItem[]): string {
    const text = this.assembleText(items);
    try {
      secureWriteViaTmp(this.filePath(), text);
      const previous = this.readState();
      this.writeState(previous?.sourceGeneration ?? null, text);
      return text;
    } catch (e) {
      this.markDirty();
      throw e;
    }
  }

  private dirtyMarkerExists(): boolean {
    try {
      fs.statSync(this.dirtyMarkerPath());
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      throw e;
    }
  }

  private clearDirtyMarker(): void {
    try {
      fs.rmSync(this.dirtyMarkerPath(), { force: true });
    } catch (e) {
      // A failed clear is safe: the next read remains fail-closed and a later boot can retry.
      console.warn('[safety-view] could not clear dirty marker:', summarizeErrorForLog(e));
    }
  }

  private readState(): SafetyProjectionState | null {
    try {
      const raw = fs.readFileSync(this.generationPath(), 'utf-8').trim();
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object'
        || parsed === null
        || typeof (parsed as { contentHash?: unknown }).contentHash !== 'string'
        || !(
          (parsed as { sourceGeneration?: unknown }).sourceGeneration === null
          || typeof (parsed as { sourceGeneration?: unknown }).sourceGeneration === 'string'
        )
      ) {
        throw new Error('invalid SAFETY projection state');
      }
      return parsed as SafetyProjectionState;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      throw e;
    }
  }

  private writeState(sourceGeneration: string | null, content: string): void {
    const state: SafetyProjectionState = {
      sourceGeneration,
      contentHash: this.contentHash(content),
    };
    secureWriteViaTmp(this.generationPath(), JSON.stringify(state) + '\n');
  }

  private contentHash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private generationFor(facts: LedgerFact[]): string {
    const canonical = facts
      .map(f => ({
        id: f.id,
        entity: f.entity,
        type: f.type,
        version: f.version,
        status: f.status,
        fields: stableValue(f.fields),
        safetyRelevant: f.safetyRelevant,
        provenance: stableValue(f.provenance),
      }))
      .sort((a, b) => `${a.type}::${a.entity}::${a.id}`.localeCompare(`${b.type}::${b.entity}::${b.id}`));
    return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }

  private assembleText(items: ParsedItem[]): string {
    if (items.length === 0) items = this.freshItems();
    if (!items.some(i => i.kind === 'preamble')) {
      items = [{ kind: 'preamble', lines: ['# Safety'] }, ...items];
    }
    const parts: string[] = [];
    for (const item of items) {
      const block = item.kind === 'section' ? [`## ${item.heading}`, ...item.lines] : item.lines;
      const trimmed = this.trimOuterBlank(block);
      if (trimmed.length === 0) continue;
      if (parts.length > 0) parts.push('');
      parts.push(trimmed.join('\n'));
    }
    return parts.join('\n') + '\n';
  }

  private trimOuterBlank(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === '') start += 1;
    while (end > start && lines[end - 1].trim() === '') end -= 1;
    return lines.slice(start, end);
  }
}
