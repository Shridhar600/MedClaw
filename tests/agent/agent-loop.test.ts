import { AgentLoop } from '../../src/agent/agent-loop';
import type { LLMProvider, LLMResponse } from '../../src/providers/types';
import { ToolRegistry } from '../../src/tools/registry';
import type { Tool } from '../../src/tools/types';

// Mock provider that replays a sequence of responses
function makeProvider(responses: LLMResponse[]): LLMProvider {
  let idx = 0;
  return {
    async chat(/* msgs: Message[], tools?: ToolSchema[] */): Promise<LLMResponse> {
      return responses[idx++] ?? { type: 'text', text: 'done' };
    },
    async embed(/* text: string */): Promise<number[]> { return []; },
  };
}

const pingTool: Tool = {
  name: 'ping',
  group: 'group:test',
  description: 'Returns pong',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute(/* p */) { return { content: [{ type: 'text', text: 'pong' }] }; },
};

describe('AgentLoop', () => {
  it('returns text response directly when no tool call needed', async () => {
    const provider = makeProvider([{ type: 'text', text: 'Hello Shridhar!' }]);
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    const loop = new AgentLoop(provider, registry, [], { maxIterations: 15, disclaimerEnabled: false });

    const result = await loop.run('Hi there');
    expect(result.text).toBe('Hello Shridhar!');
  });

  it('executes a tool call then returns follow-up text', async () => {
    const provider = makeProvider([
      { type: 'tool_call', toolCall: { id: 'c1', name: 'ping', arguments: {} } },
      { type: 'text', text: 'I called ping and got pong!' },
    ]);
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    registry.register(pingTool);
    const loop = new AgentLoop(provider, registry, [], { maxIterations: 15, disclaimerEnabled: false });

    const result = await loop.run('Ping the system');
    expect(result.text).toContain('pong');
  });

  it('returns structured run result with trace, usedTools, and healthResponse for tool flow', async () => {
    const provider = makeProvider([
      { type: 'tool_call', toolCall: { id: 'c1', name: 'ping', arguments: {} } },
      { type: 'text', text: 'I called ping and got pong!' },
    ]);
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    registry.register(pingTool);
    const loop = new AgentLoop(provider, registry, [], { maxIterations: 15, disclaimerEnabled: false });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (loop.run('Ping the system') as any);
    expect(result.text).toBe('I called ping and got pong!');
    expect(result.usedTools).toEqual(['ping']);
    expect(result.healthResponse).toBe(false);
    expect(result.trace.map((m: { role: string }) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(result.trace[0].tool_calls[0].function.name).toBe('ping');
    expect(result.trace[1].tool_call_id).toBe('c1');
    expect(result.trace[1].content).toBe('pong');
  });

  it('sets healthResponse from health intent context even when response lacks health keywords', async () => {
    const provider = makeProvider([{ type: 'text', text: 'Consider discussing this with a professional soon.' }]);
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    const loop = new AgentLoop(provider, registry, [], { maxIterations: 15, disclaimerEnabled: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (loop.run('My fasting glucose was 180 this morning.') as any);
    expect(result.healthResponse).toBe(true);
    expect(result.text).toContain('I am an AI health companion');
    const lastTrace = result.trace[result.trace.length - 1];
    expect(lastTrace.role).toBe('assistant');
    expect(lastTrace.content).toBe(result.text);
  });

  it('does not mark clearly non-health responses as medical', async () => {
    const provider = makeProvider([{ type: 'text', text: 'Here is a short haiku about mountains.' }]);
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    const loop = new AgentLoop(provider, registry, [], { maxIterations: 15, disclaimerEnabled: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (loop.run('Write a haiku about mountains.') as any);
    expect(result.healthResponse).toBe(false);
    expect(result.text).not.toContain('I am an AI health companion');
  });

  it('stops after maxIterations to prevent infinite loop', async () => {
    // Provider always returns a tool call
    const provider = makeProvider(Array(20).fill({ type: 'tool_call', toolCall: { id: 'c1', name: 'ping', arguments: {} } }));
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    registry.register(pingTool);
    const loop = new AgentLoop(provider, registry, [], { maxIterations: 3, disclaimerEnabled: false });

    const result = await loop.run('Loop forever');
    expect(result.text).toContain('maximum');
  });
});
