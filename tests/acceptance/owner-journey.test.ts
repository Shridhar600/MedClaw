// The single owner's journey through a real Gateway: onboard, record a medication, change it, confirm the
// change, restart the daemon, ask about it, and receive a background check-in. Only the chat model is
// scripted; everything else (ledger, SAFETY.md, recall, sessions, scheduler path) is the shipped code.
import * as fs from 'fs';
import * as path from 'path';
import type { Gateway } from '../../src/gateway/gateway';
import type { HeartbeatJob } from '../../src/scheduler/types';
import type { LLMResponse } from '../../src/providers/types';
import { fixtureOwner } from '../helpers/test-config';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';
import { LIVE_CHAT, ScriptedModel, startLiveGateway, type ModelCall } from '../helpers/live-gateway';

const text = (t: string): LLMResponse => ({ type: 'text', text: t });
const toolCall = (name: string, args: Record<string, unknown>): LLMResponse => ({
  type: 'tool_call',
  toolCalls: [{ id: `call-${name}-${Date.now()}`, name, arguments: args }],
});

describe('owner journey (real Gateway)', () => {
  let root: string;
  let gateway: Gateway | undefined;

  beforeEach(() => {
    root = makeTestTemp('owner-journey');
  });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    removeTestTemp(root);
  });

  it('onboard → record → change → confirm → restart → recall → check-in', async () => {
    const workspace = fixtureOwner(root).workspace;
    let pendingToken = '';
    const model = new ScriptedModel((call: ModelCall) => {
      const last = call.messages[call.messages.length - 1];
      if (last.role === 'tool') {
        const token = String(last.content).match(/tokenId="([0-9a-f]{12})"/);
        if (token) pendingToken = token[1];
        return text('Done.');
      }
      const said = String(last.content);
      if (said.includes('[Heartbeat Trigger]')) {
        return toolCall('ledger_record', { entity: 'metformin', type: 'medication', fields: { dose: '0mg' } });
      }
      if (said.startsWith('I started metformin')) {
        return toolCall('ledger_record', { entity: 'metformin', type: 'medication', fields: { dose: '500mg' } });
      }
      if (said.startsWith('My doctor raised')) {
        return toolCall('ledger_record', { entity: 'metformin', type: 'medication', fields: { dose: '1000mg' } });
      }
      if (said.startsWith('Yes, confirm')) return toolCall('ledger_update', { tokenId: pendingToken, confirm: true });
      return text('Here is what I know.');
    });
    const say = (g: Gateway, words: string, id: string): Promise<string> => g.handleTestMessage(LIVE_CHAT, words, id);
    const safety = (): string => fs.readFileSync(path.join(workspace, 'SAFETY.md'), 'utf8');

    // Onboarding: the answers become structured facts on SAFETY.md.
    gateway = await startLiveGateway(root, model);
    const onboarding = ['hi', 'Asha', '54', 'yes', 'type 2 diabetes', 'lisinopril 10mg', 'penicillin (hives)', 'walk daily', 'none', 'confirm'];
    for (const [i, answer] of onboarding.entries()) await say(gateway, answer, `onboard-${i}`);
    expect(safety()).toContain('lisinopril');
    expect(safety()).toContain('penicillin');

    // Record, then change a medication: the change waits for the owner's confirmation in a later turn.
    await say(gateway, 'I started metformin 500mg', 'm1');
    await say(gateway, 'My doctor raised my metformin to 1000mg', 'm2');
    expect(pendingToken).toMatch(/^[0-9a-f]{12}$/);
    expect(safety()).toContain('500mg');
    await say(gateway, 'Yes, confirm the new dose', 'm3');
    expect(safety()).toContain('1000mg');
    expect(safety()).not.toContain('500mg');

    // Restart the daemon: the next reply carries the current facts and the earlier conversation.
    await gateway.stop();
    gateway = await startLiveGateway(root, model);
    await say(gateway, 'What medications am I on?', 'm4');
    const afterRestart = model.calls[model.calls.length - 1];
    expect(afterRestart.system).toMatch(/metformin \(medication\) active — dose: 1000mg/);
    expect(afterRestart.system).toContain('lisinopril');
    expect(afterRestart.system).toContain('penicillin');
    expect(afterRestart.messages.some((m) => String(m.content).includes('My doctor raised my metformin'))).toBe(true);

    // A background check-in sees the same memory but cannot change a medical fact.
    const sent: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = gateway as any;
    internals.channel = { send: async (_chat: string, message: { text: string }) => { sent.push(message.text); } };
    const now = new Date().toISOString();
    const job: HeartbeatJob = {
      id: 'journey-check-in', title: 'Evening check-in', chatId: LIVE_CHAT, cron: '0 21 * * *', timezone: 'UTC',
      prompt: 'Ask how the day went.', enabled: true, source: 'system', kind: 'routine', deliveryState: 'ready',
      retryCount: 0, maxRetries: 3, createdAt: now, updatedAt: now,
    };
    const callsBefore = model.calls.length;
    await internals.handleScheduledJob(job, gateway.runtimeInstance);

    const checkIn = model.calls[callsBefore];
    expect(checkIn.tools).not.toEqual(expect.arrayContaining(['ledger_record']));
    expect(checkIn.tools).not.toEqual(expect.arrayContaining(['ledger_update']));
    expect(checkIn.system).toContain('1000mg');
    expect(sent).toEqual([expect.stringContaining('Done.')]);
    expect(safety()).toContain('1000mg');
    expect(safety()).not.toMatch(/— 0mg/);
    expect(fs.readFileSync(path.join(workspace, 'ledger', 'medications.md'), 'utf8')).not.toMatch(/^- dose: 0mg$/m);
  }, 60_000);
});
