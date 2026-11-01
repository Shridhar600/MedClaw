import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Clock } from '../ports';
import { systemClock } from '../ports';
import { AppError } from '../shared/errors';
import { secureWriteViaTmp, summarizeErrorForLog, quarantineToSideFile, QUARANTINE_POINTER_PREFIX } from '../security';
import type { FactType, LedgerFact } from './types';
import { sanitizeSingleLine } from './sanitize';

export class SafetyRemovalRefusedError extends AppError {
  constructor(message: string) {
    super(message);
  }
}

export class SafetyProjectionDirtyError extends AppError {
  constructor() {
    super('SAFETY.md projection is unavailable until it is successfully re-rendered');
  }
}

interface SafetyProjectionState {
  sourceGeneration: string | null;
  contentHash: string;
}

/** `date` is caller bookkeeping only; the render never emits it. */
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

const DAMAGE_HEADING = 'Ledger damage';
const MACHINE_HEADINGS = new Set([DAMAGE_HEADING, ...MACHINE_SECTION_ORDER.map(m => m.heading)]);
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
  constructor(
    private readonly rootDir: string,
    private readonly clock: Clock = systemClock,
    private readonly source?: () => Promise<LedgerFact[]>,
    private readonly damagedFiles: () => readonly string[] = () => [],
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

  /** Regenerates from facts; preserves Critical Events and any other hand-written content. */
  async render(facts: LedgerFact[]): Promise<string> {
    // Mark dirty before publishing so an interrupted render fails closed.
    this.markDirty();
    try {
      const { items } = this.load();
      const preamble = items.find(i => i.kind === 'preamble')?.lines ?? [];
      const rest = items.filter(i => i.kind !== 'preamble');
      const preserved = rest.filter(i => i.kind !== 'section' || !MACHINE_HEADINGS.has(i.heading));
      const damaged = this.damagedFiles();
      const rebuilt: ParsedItem[] = [
        { kind: 'preamble', lines: preamble.length > 0 ? preamble : ['# Safety'] },
        ...this.renderDamageSection(damaged),
        ...this.renderMachineSections(facts),
        ...preserved,
      ];
      const rendered = this.writeItems(rebuilt);
      // If the generation sidecar cannot be written, keep the dirty marker.
      this.writeState(this.generationFor(facts, damaged), rendered);
      this.clearDirtyMarker();
      return rendered;
    } catch (e) {
      this.markDirty();
      throw e;
    }
  }

  /** Appends a Critical Event; its `date` is never written to the file. */
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

  /** Removes a machine-section entry; refused without `userConfirmed`, and the ledger fact must be retracted first. */
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

  /** `null` only when the file does not exist; any other read error fails closed. */
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
          || state.sourceGeneration !== this.generationFor(facts, this.damagedFiles())
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
          // Source unavailable: fail closed below.
        }
        this.markDirty();
        throw new SafetyProjectionDirtyError();
      }
      if (err instanceof SafetyProjectionDirtyError) throw err;
      console.warn(`[safety-view] read failed (failing closed): ${summarizeErrorForLog(err)}`);
      throw err;
    }
  }

  private renderDamageSection(damaged: readonly string[]): ParsedItem[] {
    if (damaged.length === 0) return [];
    return [{
      kind: 'section',
      heading: DAMAGE_HEADING,
      lines: [...damaged].sort().map((file) =>
        `- WARNING: ledger/${file} is damaged and could not be read in full. Entries from it may be missing below; ask the owner before relying on this list.`),
    }];
  }

  private renderMachineSections(facts: LedgerFact[]): ParsedItem[] {
    // Disputed facts stay visible so nothing leaves the safety net while its dispute is open.
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
    // Match the whole entity segment: `penicillin` must not hit `penicillin G`.
    return new RegExp(`^-\\s*${escaped}(?:\\s+—|\\s*$)`);
  }

  /** Corrupt reads fall back to a skeleton, keeping salvageable bytes in a quarantine side file. */
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
      // Salvaged bytes stay in a 0600 side file; only a constant pointer is inlined.
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
    // Blank lines are block separators that assemble re-adds, so trim them per block.
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

  private generationFor(facts: LedgerFact[], damaged: readonly string[]): string {
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
    return crypto.createHash('sha256').update(JSON.stringify({ facts: canonical, damaged: [...damaged].sort() })).digest('hex');
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
