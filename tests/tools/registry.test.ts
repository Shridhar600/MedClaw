import { ToolRegistry } from '../../src/tools/registry';
import type { Tool, ToolResult } from '../../src/tools/types';

const echoTool: Tool = {
  name: 'echo',
  group: 'group:test',
  description: 'Echoes input',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  async execute(params) {
    return { content: [{ type: 'text', text: String(params.text) }] };
  },
};

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    registry.register(echoTool);
    const available = registry.getAvailable();
    expect(available.map(t => t.name)).toContain('echo');
  });

  it('deny list takes precedence over allow all', () => {
    const registry = new ToolRegistry({ allow: ['*'], deny: ['echo'] });
    registry.register(echoTool);
    const available = registry.getAvailable();
    expect(available.map(t => t.name)).not.toContain('echo');
  });

  it('deny list can block by group', () => {
    const registry = new ToolRegistry({ allow: ['*'], deny: ['group:test'] });
    registry.register(echoTool);
    expect(registry.getAvailable()).toHaveLength(0);
  });

  it('allow list restricts when not wildcard', () => {
    const registry = new ToolRegistry({ allow: ['group:memory'], deny: [] });
    registry.register(echoTool); // group:test — not allowed
    expect(registry.getAvailable()).toHaveLength(0);
  });

  it('executes a registered tool', async () => {
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    registry.register(echoTool);
    const result = await registry.execute('echo', { text: 'hello' });
    expect(result.content[0].text).toBe('hello');
  });

  it('throws when executing unknown tool', async () => {
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    await expect(registry.execute('nonexistent', {})).rejects.toThrow('Tool not found: nonexistent');
  });

  it('enforces declared maxLength and maxItems schema limits before execution', async () => {
    const execute: Tool['execute'] = jest.fn(async (): Promise<ToolResult> => ({
      content: [{ type: 'text', text: 'executed' }],
    }));
    const bounded: Tool = {
      name: 'bounded',
      group: 'group:test',
      description: 'Bounded input',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 5 },
          ids: { type: 'array', maxItems: 2 },
        },
      },
      execute,
    };
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    registry.register(bounded);

    const long = await registry.execute('bounded', { text: '123456' });
    const many = await registry.execute('bounded', { ids: ['a', 'b', 'c'] });

    expect(long.isError).toBe(true);
    expect(many.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
