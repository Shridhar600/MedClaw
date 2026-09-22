import type { Tool, ToolExecutionContext, ToolResult } from './types';
import type { ToolsConfig } from '../config/types';
import { summarizeErrorForLog } from '../security';

interface SchemaNode {
  type?: unknown;
  maxLength?: unknown;
  maxItems?: unknown;
  items?: unknown;
  properties?: unknown;
}

function schemaLimitError(toolName: string, parameter: string, limit: 'maxLength' | 'maxItems', value: number): ToolResult {
  return {
    content: [{ type: 'text', text: `Invalid parameters for ${toolName}: ${parameter} exceeds ${limit} ${value}.` }],
    isError: true,
  };
}

function validateSchemaValue(
  toolName: string,
  parameter: string,
  value: unknown,
  schema: SchemaNode,
): ToolResult | null {
  if (typeof value === 'string' && typeof schema.maxLength === 'number'
    && Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
    return schemaLimitError(toolName, parameter, 'maxLength', schema.maxLength);
  }
  if (Array.isArray(value) && typeof schema.maxItems === 'number'
    && Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
    return schemaLimitError(toolName, parameter, 'maxItems', schema.maxItems);
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    for (let i = 0; i < value.length; i++) {
      const nested = validateSchemaValue(toolName, `${parameter}[${i}]`, value[i], schema.items as SchemaNode);
      if (nested) return nested;
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)
    && schema.properties && typeof schema.properties === 'object') {
    for (const [key, childSchema] of Object.entries(schema.properties as Record<string, unknown>)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && childSchema && typeof childSchema === 'object') {
        const nested = validateSchemaValue(toolName, `${parameter}.${key}`, (value as Record<string, unknown>)[key], childSchema as SchemaNode);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function validateParameters(tool: Tool, params: Record<string, unknown>): ToolResult | null {
  const properties = tool.parameters.properties;
  for (const [parameter, schema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(params, parameter) || !schema || typeof schema !== 'object') continue;
    const error = validateSchemaValue(tool.name, parameter, params[parameter], schema as SchemaNode);
    if (error) return error;
  }
  return null;
}

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
    const validationError = validateParameters(tool, params);
    if (validationError) return validationError;
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
