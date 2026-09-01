import { Gateway } from '../../src/gateway/gateway';
import type { AppConfig } from '../../src/config/types';

describe('RR-6b transcript sweep completeness', () => {
  it('reports an incomplete ledger read and skips missing-data conclusions', async () => {
    const gateway = new Gateway({} as AppConfig);
    const state = gateway as unknown as Record<string, unknown>;
    const added: unknown[] = [];
    state.sessions = {
      readDayFileLines: jest.fn().mockReturnValue([
        JSON.stringify({
          timestamp: '2026-08-30T10:00:00.000Z',
          role: 'user',
          content: 'took naproxen today',
          chatId: 'chat-1',
        }),
      ]),
    };
    state.ledgerStore = {
      listAllOfType: jest.fn().mockImplementation(async (type: string) => {
        if (type === 'medication') throw new Error('medication lane unreadable');
        return [];
      }),
    };
    state.curiosity = {
      list: jest.fn().mockResolvedValue([]),
      add: jest.fn().mockImplementation(async (item: unknown) => { added.push(item); }),
    };

    const result = await gateway.runTranscriptSweep();

    expect((result as { incomplete?: boolean }).incomplete).toBe(true);
    expect(result.added).toBe(0);
    expect(added).toEqual([]);
  });
});
