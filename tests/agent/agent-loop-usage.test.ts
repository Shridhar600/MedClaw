import { AgentLoop } from '../../src/agent/agent-loop';
import type { LLMProvider, LLMResponse } from '../../src/providers/types';
import { ToolRegistry } from '../../src/tools/registry';
import type { Tool } from '../../src/tools/types';

function makeProvider(responses: LLMResponse[]): LLMProvider {
  let idx = 0;
  return {
    async chat(): Promise<LLMResponse> {
      return responses[idx++] ?? { type: 'text', text: 'done' };
    },
    async embed(): Promise<number[]> {
      return [];
    },
  };
}

const pingTool: Tool = {
  name: 'ping',
  group: 'group:test',
  description: 'Returns pong',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    return { content: [{ type: 'text', text: 'pong' }] };
  },
};

describe('AgentLoop token-usage surfacing (A-MF1)', () => {
  it('surfaces the LAST provider call promptTokens on the result across iterations', async () => {
    const provider = makeProvider([
      { type: 'tool_call', toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } },
      { type: 'text', text: 'done', usage: { promptTokens: 250, completionTokens: 10, totalTokens: 260 } },
    ]);
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    registry.register(pingTool);
    const loop = new AgentLoop(provider, registry, [], { maxIterations: 15, disclaimerEnabled: false });

    const result = await loop.run('ping the system');
    // The final call carries the full accumulated context — the correct window-fill reading.
    expect(result.lastPromptTokens).toBe(250);
  });

  it('lastPromptTokens is undefined when the provider omits usage (⇒ chars/4 fallback downstream)', async () => {
    const provider = makeProvider([{ type: 'text', text: 'done' }]);
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    const loop = new AgentLoop(provider, registry, [], { maxIterations: 15, disclaimerEnabled: false });

    const result = await loop.run('hi');
    expect(result.lastPromptTokens).toBeUndefined();
  });

  it('does NOT carry an earlier iteration usage forward when the FINAL call omits usage (H7)', async () => {
    // First (tool) call reports usage; the final text call omits it. The last call's prompt is the
    // largest (full accumulated context), so a stale earlier reading UNDER-reports the window fill and
    // can skip a needed compaction/emergency. The honest signal is "no reading ⇒ downstream estimates".
    const provider = makeProvider([
      { type: 'tool_call', toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }], usage: { promptTokens: 100, completionTokens: 5, totalTokens: 105 } },
      { type: 'text', text: 'done' },
    ]);
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    registry.register(pingTool);
    const loop = new AgentLoop(provider, registry, [], { maxIterations: 15, disclaimerEnabled: false });

    const result = await loop.run('ping the system');
    expect(result.lastPromptTokens).toBeUndefined();
  });
});
