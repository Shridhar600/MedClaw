import { AgentLoop, type PrepareSystem } from '../../src/agent/agent-loop';
import type { LLMProvider, LLMResponse, Message } from '../../src/providers/types';
import { ToolRegistry } from '../../src/tools/registry';
import type { Tool } from '../../src/tools/types';

// A provider that records every `messages` array it is handed and replays a fixed response.
function recordingProvider(responses: LLMResponse[]): { provider: LLMProvider; seen: Message[][] } {
  const seen: Message[][] = [];
  let idx = 0;
  const provider: LLMProvider = {
    async chat(msgs: Message[]): Promise<LLMResponse> {
      seen.push(msgs);
      return responses[idx++] ?? { type: 'text', text: 'done' };
    },
    async embed(): Promise<number[]> { return []; },
  };
  return { provider, seen };
}

const CFG = { maxIterations: 15, disclaimerEnabled: false };

describe('AgentLoop — per-turn assembly + <used> feedback (C3)', () => {
  it('builds the system prompt via the supplier on EVERY turn (per-turn D9 assembly)', async () => {
    const calls: { mode: string; msg: string }[] = [];
    const prepare: PrepareSystem = async (mode, msg) => {
      calls.push({ mode, msg });
      return { messages: [{ role: 'system', content: `SYS:${msg}` }] };
    };
    const { provider, seen } = recordingProvider([{ type: 'text', text: 'ok' }, { type: 'text', text: 'ok' }]);
    const loop = new AgentLoop(provider, new ToolRegistry({ allow: ['*'], deny: [] }), prepare, CFG);

    await loop.run('first');
    await loop.run('second');

    expect(calls).toEqual([{ mode: 'chat', msg: 'first' }, { mode: 'chat', msg: 'second' }]);
    expect(seen[0][0]).toEqual({ role: 'system', content: 'SYS:first' });
    expect(seen[1][0]).toEqual({ role: 'system', content: 'SYS:second' });
  });

  it('passes the turn mode from runContext to the supplier (Gateway owns the mode — H-4)', async () => {
    const calls: string[] = [];
    const prepare: PrepareSystem = async (mode) => { calls.push(mode); return { messages: [] }; };
    const { provider } = recordingProvider([{ type: 'text', text: 'ok' }]);
    const loop = new AgentLoop(provider, new ToolRegistry({ allow: ['*'], deny: [] }), prepare, CFG);

    await loop.run('beat', [], { origin: 'heartbeat', mode: 'heartbeat' });

    expect(calls).toEqual(['heartbeat']);
  });

  it('parses and STRIPS the <used> tag and records usage (B7 / H-3)', async () => {
    let recorded: string[] | null = null;
    const prepare: PrepareSystem = async () => ({ messages: [], recordUsed: async (ids) => { recorded = ids; } });
    const { provider } = recordingProvider([{ type: 'text', text: 'Here is your answer.\n<used>c1,c2</used>' }]);
    const loop = new AgentLoop(provider, new ToolRegistry({ allow: ['*'], deny: [] }), prepare, CFG);

    const result = await loop.run('q');

    expect(result.text).toBe('Here is your answer.');
    expect(result.text).not.toContain('<used>');
    expect(recorded).toEqual(['c1', 'c2']);
  });

  it('does not call recordUsed when there is no <used> tag, and leaves the text intact', async () => {
    let called = false;
    const prepare: PrepareSystem = async () => ({ messages: [], recordUsed: async () => { called = true; } });
    const { provider } = recordingProvider([{ type: 'text', text: 'plain answer' }]);
    const loop = new AgentLoop(provider, new ToolRegistry({ allow: ['*'], deny: [] }), prepare, CFG);

    const result = await loop.run('q');

    expect(result.text).toBe('plain answer');
    expect(called).toBe(false);
  });

  it('strips <used> BEFORE appending the disclaimer / classifying health (H-3 ordering)', async () => {
    const prepare: PrepareSystem = async () => ({ messages: [], recordUsed: async () => undefined });
    const { provider } = recordingProvider([{ type: 'text', text: 'Your glucose note looks stable.\n<used>c9</used>' }]);
    const loop = new AgentLoop(provider, new ToolRegistry({ allow: ['*'], deny: [] }), prepare, { maxIterations: 15, disclaimerEnabled: true });

    const result = await loop.run('how is my glucose');

    expect(result.healthResponse).toBe(true);
    expect(result.text).not.toContain('<used>');
    expect(result.text.startsWith('Your glucose note looks stable.')).toBe(true);
    expect(result.text).toContain('I am an AI health companion');
  });

  it('executes ALL tool calls in one assistant turn and appends each result in order (C4.1)', async () => {
    const mkTool = (name: string): Tool => ({
      name, group: 'group:test', description: name,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() { return { content: [{ type: 'text', text: `${name}-result` }] }; },
    });
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    registry.register(mkTool('ping'));
    registry.register(mkTool('pong'));
    const { provider, seen } = recordingProvider([
      { type: 'tool_call', toolCalls: [{ id: 'a', name: 'ping', arguments: {} }, { id: 'b', name: 'pong', arguments: {} }] },
      { type: 'text', text: 'both done' },
    ]);
    const loop = new AgentLoop(provider, registry, [], CFG);

    const result = await loop.run('do both');

    expect(result.text).toBe('both done');
    expect([...result.usedTools].sort()).toEqual(['ping', 'pong']);
    // One assistant tool-request (carrying BOTH calls) → two tool results in order → final assistant.
    expect(result.trace.map((m) => m.role)).toEqual(['assistant', 'tool', 'tool', 'assistant']);
    expect(result.trace[0].tool_calls!.map((t) => t.id)).toEqual(['a', 'b']);
    expect(result.trace[1].tool_call_id).toBe('a');
    expect(result.trace[2].tool_call_id).toBe('b');
    // The second provider call sees a valid history: assistant(tool_calls=2) then both tool messages.
    const second = seen[1];
    const asst = second.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))!;
    expect(asst.tool_calls!.length).toBe(2);
    const toolMsgs = second.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['a', 'b']);
  });

  it('still accepts a static Message[] (legacy/test construction) and reuses it each turn', async () => {
    const { provider, seen } = recordingProvider([{ type: 'text', text: 'ok' }]);
    const staticSys: Message[] = [{ role: 'system', content: 'STATIC' }];
    const loop = new AgentLoop(provider, new ToolRegistry({ allow: ['*'], deny: [] }), staticSys, CFG);

    await loop.run('hi');

    expect(seen[0][0]).toEqual({ role: 'system', content: 'STATIC' });
  });
});
