import type { ToolRegistry } from '../../src/tools/registry';
import type { Tool, ToolExecutionContext, ToolResult } from '../../src/tools/types';

/** The registry as an owner turn sees it: every call carries origin 'user'. */
export function ownerTools(registry: ToolRegistry): {
  execute: (name: string, params: Record<string, unknown>, context?: ToolExecutionContext) => Promise<ToolResult>;
  getAvailable: () => Tool[];
} {
  return {
    execute: (name, params, context) => registry.execute(name, params, { ...context, origin: 'user' }),
    getAvailable: () => registry.getAvailable('user'),
  };
}
