import type { Message } from '../providers/types';
import type { MemoryEngine } from '../memory/memory-engine';

// Files always loaded into every context
const ALWAYS_LOAD = ['SOUL.md', 'HEALTH_PROFILE.md', 'USER.md', 'HEARTBEAT.md'];
// Files loaded if they exist
const LOAD_IF_PRESENT = ['MEMORY.md'];

export class ContextAssembler {
  constructor(
    private readonly memory: MemoryEngine,
    private readonly maxChars: number,
    private readonly profileId: string = 'default',
  ) {}

  async buildSystemMessages(): Promise<Message[]> {
    const sections: Array<{ key: string; title: string; content: string }> = [];

    // Core files (always attempted, stable order)
    for (const filename of ALWAYS_LOAD) {
      const content = await this.memory.readFile(filename);
      if (content) {
        sections.push({ key: filename, title: filename, content });
      }
    }

    // Optional files
    for (const filename of LOAD_IF_PRESENT) {
      const content = await this.memory.readFile(filename);
      if (content) {
        sections.push({ key: filename, title: filename, content });
      }
    }

    // Today's memory log
    const today = new Date().toISOString().slice(0, 10);
    const todayLog = await this.memory.readFile(`memory/${today}.md`);
    if (todayLog) {
      sections.push({
        key: `memory/${today}.md`,
        title: `Today's Log (${today})`,
        content: todayLog,
      });
    }

    // Yesterday's log
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const yesterdayLog = await this.memory.readFile(`memory/${yesterday}.md`);
    if (yesterdayLog) {
      sections.push({
        key: `memory/${yesterday}.md`,
        title: `Yesterday's Log (${yesterday})`,
        content: yesterdayLog,
      });
    }

    const systemContent = this.composeWithBudget(sections);
    return [{ role: 'system', content: systemContent }];
  }

  private composeWithBudget(sections: Array<{ key: string; title: string; content: string }>): string {
    const parts: string[] = [];
    let used = 0;

    for (const section of sections) {
      const separator = parts.length > 0 ? '\n\n---\n\n' : '';
      const header = `## ${section.title}\n\n`;
      const remaining = this.maxChars - used;
      if (remaining <= 0) break;

      const framing = separator.length + header.length;
      if (framing >= remaining) break;

      const contentBudget = remaining - framing;
      const body = this.fitContent(section.key, section.content, contentBudget);
      if (body.length === 0) continue;

      const chunk = `${separator}${header}${body}`;
      parts.push(chunk);
      used += chunk.length;
    }

    return parts.join('');
  }

  private fitContent(sectionKey: string, content: string, contentBudget: number): string {
    if (contentBudget <= 0) return '';
    if (content.length <= contentBudget) return content;

    const markerFor = (omitted: number): string => `\n\n[TRUNCATED ${sectionKey}: ${omitted} chars omitted]`;
    let marker = markerFor(0);
    if (marker.length >= contentBudget) {
      return this.safeSlice(markerFor(content.length), contentBudget);
    }

    let allowed = contentBudget - marker.length;
    let truncated = this.safeSlice(content, allowed);
    let omitted = content.length - truncated.length;
    marker = markerFor(omitted);

    allowed = Math.max(0, contentBudget - marker.length);
    truncated = this.safeSlice(content, allowed);
    omitted = content.length - truncated.length;
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
    // Avoid slicing in-between a UTF-16 surrogate pair.
    if (last >= 0xD800 && last <= 0xDBFF) {
      sliced = sliced.slice(0, -1);
    }
    return sliced;
  }
}
