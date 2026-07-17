import type { Tool, ToolExecutionContext, ToolResult } from './types';
import type { ToolsConfig } from '../config/types';
import { summarizeErrorForLog } from '../security';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private config: ToolsConfig;

  constructor(config: ToolsConfig) {
    this.config = config;
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  getAvailable(): Tool[] {
    return [...this.tools.values()].filter(t => this.isAllowed(t));
  }

  async execute(
    name: string,
    params: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    if (!this.isAllowed(tool)) throw new Error(`Tool not allowed: ${name}`);
    try {
      return await tool.execute(params, context);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Tool error messages can echo PHI (tool args carry health content) — log
      // the tool name + sanitized frame only. The full error text is returned
      // to the agent (persisted into the 0600 session JSONL, not stdout/stderr).
      console.error(`[tool:${name}] Error:`, summarizeErrorForLog(e));
      return { content: [{ type: 'text', text: `Tool error: ${msg}` }], isError: true };
    }
  }

  private isAllowed(tool: Tool): boolean {
    const { allow, deny } = this.config;

    const isDenied =
      deny.includes(tool.name) ||
      deny.includes(tool.group);

    if (isDenied) return false;

    const isAllowed =
      allow.includes('*') ||
      allow.includes(tool.name) ||
      allow.includes(tool.group);

    return isAllowed;
  }
}
