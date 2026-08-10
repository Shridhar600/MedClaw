import type { LLMProvider } from '../../src/providers/types';
import { probeChatCompletion } from '../../src/providers/healthcheck';

// #3: /status must reflect whether the main model can actually COMPLETE a
// tool-bearing request, not just whether a key/model is configured. probeChatCompletion
// makes one real, tool-bearing call and maps the outcome to a ReadinessResult.

function providerWith(chat: LLMProvider['chat']): Pick<LLMProvider, 'chat'> {
  return { chat };
}

describe('probeChatCompletion (#3 real completion probe)', () => {
  it('ok + tool-calling verified when the model returns a tool call', async () => {
    const provider = providerWith(
      jest.fn().mockResolvedValue({ type: 'tool_call', toolCall: { id: 'x', name: 'healthcheck_ack', arguments: {} } }),
    );
    const r = await probeChatCompletion(provider);
    expect(r.ready).toBe(true);
    expect(r.status).toBe('ok');
    expect(r.details.join(' ')).toContain('tool-calling verified');
  });

  it('ok (completion verified) on a plain text reply', async () => {
    const provider = providerWith(jest.fn().mockResolvedValue({ type: 'text', text: 'online' }));
    const r = await probeChatCompletion(provider);
    expect(r.ready).toBe(true);
    expect(r.status).toBe('ok');
  });

  it('FAILS (not ready) when the model rejects the live request — sanitized', async () => {
    const provider = providerWith(
      jest.fn().mockRejectedValue(new Error('402 subscription required for glucose-SECRETMARKER')),
    );
    const r = await probeChatCompletion(provider);
    expect(r.ready).toBe(false);
    expect(r.status).toBe('fail');
    expect(r.reasonCode).toBe('completion-failed');
    // The raw provider error (which can carry PHI/internals) must NOT leak.
    expect(JSON.stringify(r)).not.toContain('SECRETMARKER');
  });

  it('warns but stays ready on timeout (slow model, not necessarily broken)', async () => {
    const provider = providerWith(jest.fn().mockImplementation(() => new Promise(() => undefined)));
    const r = await probeChatCompletion(provider, { timeoutMs: 20 });
    expect(r.ready).toBe(true);
    expect(r.status).toBe('warn');
    expect(r.reasonCode).toBe('completion-timeout');
  });
});
