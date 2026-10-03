/* eslint-disable @typescript-eslint/no-explicit-any */
import { Gateway } from '../../src/gateway/gateway';
import type { EffectiveConfig } from '../../src/config/types';
import { ProfileRuntime } from '../../src/gateway/runtime';
import { attachGatewayTestRuntime } from '../helpers/gateway-test-runtime';

describe('RR-6b transcript sweep completeness', () => {
  it('reports an incomplete ledger read and skips missing-data conclusions', async () => {
    // A structural double, never started: this suite tests `runTranscriptSweep` directly. S1 makes
    // admission REQUIRED on the constructor, so the minimal real authority is supplied here rather
    // than weakening the type back to optional.
    const gateway = new Gateway({} as EffectiveConfig, {
      admission: {} as never,
      ownerId: 'default' as never,
    });
    const added: unknown[] = [];
    const runtime = attachGatewayTestRuntime(gateway, {} as EffectiveConfig, {
      sessions: {
        readDayFileLines: jest.fn().mockReturnValue([
          JSON.stringify({
            timestamp: '2026-08-30T10:00:00.000Z',
            role: 'user',
            content: 'took naproxen today',
            chatId: 'chat-1',
          }),
        ]),
      },
      ledgerStore: {
        listAllOfType: jest.fn().mockImplementation(async (type: string) => {
          if (type === 'medication') throw new Error('medication lane unreadable');
          return [];
        }),
      },
      curiosity: {
        list: jest.fn().mockResolvedValue([]),
        add: jest.fn().mockImplementation(async (item: unknown) => { added.push(item); }),
      },
    });
    runtime.runTranscriptSweep = ProfileRuntime.prototype.runTranscriptSweep.bind(runtime);
    runtime.buildSweepDeps = ProfileRuntime.prototype.buildSweepDeps.bind(runtime);

    const result = await gateway.runTranscriptSweep();

    expect((result as { incomplete?: boolean }).incomplete).toBe(true);
    expect(result.added).toBe(0);
    expect(added).toEqual([]);
  });
});
