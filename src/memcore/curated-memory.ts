// src/memcore/curated-memory.ts
//
// MEMORY.md — the curated narrative memory with a hard character budget (specs/07 §7;
// plan Task 6). Category budgets are independent: Health 60% / Life 20% / Agent notes 20%
// of the injected `budgetChars`. Writes are FAIL-LOUD: an over-budget append throws
// `BudgetExceededError{section, gauge, currentEntries}` and writes nothing — the engine
// NEVER auto-evicts across categories and NEVER evicts a health entry to fit a non-health
// one (CHAT-02/CHAT-05). The model merges in-turn via `replace()` after the tool relays
// `currentEntries` (D6). "Clinical merged last" ordering is a P3 L1-manual instruction —
// P1 asserts only engine properties (D6/F11).
//
// The gauge line is auto-maintained in each section heading:
//   ## Health <!-- 1320/1320 chars used (100%) -->
//
// Corrupt-file reads degrade to empty sections + sanitized warn, preserving any salvageable
// raw bytes in a <!-- PARSE-ERROR --> quarantine note (D2/F24). Never crashes.

import * as fs from 'fs';
import * as path from 'path';
import { BudgetExceededError } from '../shared/errors';
import { secureWriteViaTmp, summarizeErrorForLog, quarantineToSideFile, QUARANTINE_POINTER_PREFIX } from '../security';

/** Collapse newlines so an entry can never open a new `## ` section on re-parse. */
function sanitizeEntry(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

export type MemorySection = 'health' | 'life' | 'agent';

export interface CuratedMemoryOptions {
  /** Total MEMORY.md budget in characters; split 60/20/20 across the three sections. */
  budgetChars: number;
}

const SECTION_SHARE: Record<MemorySection, number> = { health: 0.6, life: 0.2, agent: 0.2 };
const SECTION_HEADING: Record<MemorySection, string> = { health: 'Health', life: 'Life', agent: 'Agent notes' };
const SECTION_DISPLAY: Record<MemorySection, string> = { health: 'Health', life: 'Life', agent: 'Agent notes' };
const SECTION_ORDER: MemorySection[] = ['health', 'life', 'agent'];

type ParsedItem =
  | { kind: 'preamble'; lines: string[] }
  | { kind: 'quarantine'; lines: string[] }
  | { kind: 'section'; heading: string; comment?: string; lines: string[] };

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export class CuratedMemory {
  constructor(
    private readonly rootDir: string,
    private readonly opts: CuratedMemoryOptions,
  ) {}

  private filePath(): string {
    return path.join(this.rootDir, 'MEMORY.md');
  }

  private sectionBudget(section: MemorySection): number {
    return Math.floor(this.opts.budgetChars * SECTION_SHARE[section]);
  }

  /**
   * Append an entry to a section's budget. Fails loudly (nothing written) when the section
   * would exceed its own budget. Returns the section's entry texts after the write.
   */
  async write(section: MemorySection, text: string): Promise<string[]> {
    const { items } = this.load();
    this.ensureSkeleton(items);
    const sec = this.sectionItem(items, section)!;
    const newLines = [...sec.lines, `- ${sanitizeEntry(text)}`];
    this.assertFits(section, newLines, sec.lines);
    sec.lines = newLines;
    this.refreshGauges(items);
    this.writeItems(items);
    return this.entriesOf(sec);
  }

  /**
   * Replace a section's entries wholesale with the given set (the D6 in-turn merge path).
   * Also fail-loud when the merged set still exceeds the budget.
   */
  async replace(section: MemorySection, entries: string[]): Promise<string[]> {
    const { items } = this.load();
    this.ensureSkeleton(items);
    const sec = this.sectionItem(items, section)!;
    const newLines = entries.map(e => `- ${sanitizeEntry(e)}`);
    this.assertFits(section, newLines, sec.lines);
    sec.lines = newLines;
    this.refreshGauges(items);
    this.writeItems(items);
    return this.entriesOf(sec); // normalized on-disk entries (symmetry with write()/entries())
  }

  /** Current entry texts for a section (empty when the section has none). */
  async entries(section: MemorySection): Promise<string[]> {
    const { items } = this.load();
    const sec = this.sectionItem(items, section);
    return sec ? this.entriesOf(sec) : [];
  }

  /** Current on-disk content, or null when no MEMORY.md exists yet. */
  async read(): Promise<string | null> {
    try {
      return await fs.promises.readFile(this.filePath(), 'utf-8');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return null;
      console.warn(`[curated-memory] read failed: ${summarizeErrorForLog(err)}`);
      return null;
    }
  }

  // ---- internals ---------------------------------------------------------

  private assertFits(section: MemorySection, newLines: string[], currentLines: string[]): void {
    const budget = this.sectionBudget(section);
    if (this.sectionSize(newLines) <= budget) return;
    const used = this.sectionSize(currentLines);
    throw new BudgetExceededError(
      `${SECTION_DISPLAY[section]} budget exceeded (${fmt(used)}/${fmt(budget)} chars used). Merge required.`,
      section,
      budget > 0 ? used / budget : 0,
      this.entriesOf({ heading: SECTION_HEADING[section], lines: currentLines } as ParsedItem),
    );
  }

  private sectionItem(items: ParsedItem[], section: MemorySection): ParsedItem | undefined {
    return items.find(i => i.kind === 'section' && i.heading === SECTION_HEADING[section]);
  }

  private entriesOf(sec: { lines: string[] }): string[] {
    return sec.lines.map(l => (l.startsWith('- ') ? l.slice(2) : l));
  }

  /** The rendered section body size in chars (bullet prefix + text + newline separators). */
  private sectionSize(lines: string[]): number {
    if (lines.length === 0) return 0;
    return lines.join('\n').length + 1;
  }

  private gaugeComment(section: MemorySection, lines: string[]): string {
    const budget = this.sectionBudget(section);
    const used = this.sectionSize(lines);
    const pct = budget > 0 ? Math.round((used / budget) * 100) : 0;
    // Inner text only — the `<!-- … -->` wrapper is added at assemble time.
    return `${fmt(used)}/${fmt(budget)} chars used (${pct}%)`;
  }

  /** Ensure the fixed section skeleton exists after the preamble, in canonical order. */
  private ensureSkeleton(items: ParsedItem[]): void {
    const preambleEnd = items.findIndex(i => i.kind !== 'preamble');
    const insertAt = preambleEnd === -1 ? items.length : preambleEnd;
    const missing = SECTION_ORDER.filter(s => !this.sectionItem(items, s));
    if (missing.length === 0) return;
    const created: ParsedItem[] = missing.map(section => ({
      kind: 'section',
      heading: SECTION_HEADING[section],
      comment: this.gaugeComment(section, []),
      lines: [],
    }));
    items.splice(insertAt, 0, ...created);
  }

  /** Refresh every owned section's gauge comment and the budget line in the H1. */
  private refreshGauges(items: ParsedItem[]): void {
    for (const section of SECTION_ORDER) {
      const sec = this.sectionItem(items, section);
      if (sec && sec.kind === 'section') sec.comment = this.gaugeComment(section, sec.lines);
    }
    const preamble = items.find(i => i.kind === 'preamble');
    if (preamble && preamble.lines.length > 0 && preamble.lines[0].startsWith('# Memory')) {
      preamble.lines[0] = `# Memory <!-- budget: ${fmt(this.opts.budgetChars)} chars · health 60% / life 20% / agent 20% -->`;
    }
  }

  private writeItems(items: ParsedItem[]): string {
    const text = this.assembleText(items);
    secureWriteViaTmp(this.filePath(), text);
    return text;
  }

  /**
   * Load the current file, degrading on corrupt read (D2/F24): sanitized warn + fresh
   * skeleton, preserving any salvageable raw bytes in a PARSE-ERROR quarantine note.
   * Never crashes.
   */
  private load(): { items: ParsedItem[] } {
    const fp = this.filePath();
    let raw: string;
    try {
      raw = fs.readFileSync(fp, 'utf-8');
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') return { items: this.freshItems() };
      console.warn(`[curated-memory] degraded read: ${summarizeErrorForLog(err)}`);
      return { items: this.quarantinedItems(this.salvageRaw(fp)) };
    }
    if (raw.includes('\uFFFD')) {
      console.warn('[curated-memory] degraded read: invalid UTF-8 content');
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
    return [{
      kind: 'preamble',
      lines: [`# Memory <!-- budget: ${fmt(this.opts.budgetChars)} chars · health 60% / life 20% / agent 20% -->`],
    }];
  }

  private quarantinedItems(salvaged: string | null): ParsedItem[] {
    const items = this.freshItems();
    if (salvaged) {
      // Salvaged bytes → 0600 side file; only a constant pointer inlines into the
      // always-injected MEMORY.md (no injection surface, no date leak).
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
        const parsed = this.parseHeading(line);
        current = { kind: 'section', heading: parsed.heading, comment: parsed.comment, lines: [] };
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
    // Blank lines between blocks are structural separators (assemble re-adds them), not
    // section content — drop them so entries()/gauges stay clean and round-trips stable.
    for (const item of items) {
      if (item.kind !== 'quarantine') item.lines = this.trimOuterBlank(item.lines);
    }
    return items;
  }

  private parseHeading(line: string): { heading: string; comment?: string } {
    const match = line.match(/^##\s+(.+?)(?:\s+<!--\s*(.*?)\s*-->)?\s*$/);
    if (!match) return { heading: line.slice(3).trim() };
    return { heading: match[1].trim(), comment: match[2]?.trim() };
  }

  private assembleText(items: ParsedItem[]): string {
    if (items.length === 0) items = this.freshItems();
    if (!items.some(i => i.kind === 'preamble')) {
      items = [this.freshItems()[0], ...items];
    }
    const parts: string[] = [];
    for (const item of items) {
      const block = item.kind === 'section'
        ? [`## ${item.heading}${item.comment ? ` <!-- ${item.comment} -->` : ''}`, ...item.lines]
        : item.lines;
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