import * as fs from 'fs';
import * as path from 'path';
import * as cron from 'node-cron';
import { Gateway } from '../../src/gateway/gateway';
import type { EffectiveConfig } from '../../src/config/types';
import {} from '../helpers/test-config';
import { bindGatewayOwner } from '../helpers/gateway-owner-deps';
import { makeTestTemp } from '../helpers/test-temp';

const CHAT_BINDING = 'owner-chat';

jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({ stop: jest.fn() })),
}));

function makeConfig(tmpDir: string): EffectiveConfig {
  return {
  schemaVersion: 2,
    providers: {
      main: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
      medical: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
      embeddings: { type: 'ollama', model: 'unused', baseUrl: 'http://127.0.0.1:9/v1' },
    },
    channels: { telegram: { enabled: false, botToken: '' } },
    tools: { allow: ['*'], deny: [] },
    profiles: { baseDir: path.join(tmpDir, 'profiles-base'), defaultProfileId: 'default' },
    memory: { workspace: path.join(tmpDir, 'workspace'), search: { hybridWeights: { vector: 0.7, keyword: 0.3 } }, bootstrapMaxChars: 20000 },
    sessions: { compaction: { enabled: true, memoryFlush: true, keepRecentTurns: 10 } },
    heartbeat: {
      enabled: false, timezone: 'Asia/Kolkata', storePath: path.join(tmpDir, 'heartbeats', 'jobs.json'),
      recovery: { enabled: false, windowMinutes: 60 }, retry: { maxRetries: 3, backoffMinutes: 5 },
      rateLimit: { maxGlobalTriggersPerMinute: 10, maxPerChatTriggersPerMinute: 3 }, audit: { path: path.join(tmpDir, 'heartbeats', 'audit.jsonl') },
      policy: { quietHours: { enabled: false, start: '22:00', end: '07:00' }, skipIfChatActiveWithinMinutes: 0, defaults: { morningCheckIn: { enabled: false, cron: '0 8 * * *', prompt: 'M' }, eveningSummary: { enabled: false, cron: '0 21 * * *', prompt: 'E' } } },
    },
    agent: { maxIterations: 15 },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('Gateway.runTranscriptSweep', () => {
  let tmpDir: string;
  let gateway: Gateway;

  beforeEach(() => { tmpDir = makeTestTemp('redacted-gw-sweep-'); });
  afterEach(async () => {
    try { await gateway?.stop(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const prov = (capturedAt: string) => ({ source: 'user' as const, confidence: 1, anchor: 'memory/x.md#L1', capturedAt });

  it('files a critical miss for an unlogged med, drops a logged one, and does NOT re-ask a same-day-superseded med', async () => {
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await gateway.start();
    warn.mockRestore(); log.mockRestore();

    const runtime = gateway.runtimeInstance!;
    const sessions = runtime.sessions!;
    const ledger = runtime.ledgerStore!;
    const curiosity = runtime.curiosity!;

    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-08-30T10:00:00.000Z'));
      await sessions.recordTurn('owner-chat', [{ role: 'user', content: 'took naproxen, metformin, and ibuprofen today' }]);
      await ledger.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: prov('2026-08-30T10:00:00.000Z') });
      await ledger.recordFact({ entity: 'ibuprofen', type: 'medication', fields: { dose: '200mg' }, provenance: prov('2026-08-30T10:05:00.000Z') });

      jest.setSystemTime(new Date('2026-08-31T09:00:00.000Z'));
      await ledger.recordFact({ entity: 'ibuprofen', type: 'medication', fields: { dose: '400mg' }, provenance: prov('2026-08-31T09:00:00.000Z') });

      jest.setSystemTime(new Date('2026-08-31T03:15:00.000Z'));
      const result = await gateway.runTranscriptSweep();
      expect(result.scanned).toBe(true);

      const items = await curiosity.list();
      const entities = items.map((i: any) => i.relatedEntity);
      expect(entities).toContain('naproxen');       // mentioned, never logged → critical miss
      expect(entities).not.toContain('metformin');  // logged yesterday → no item
      expect(entities).not.toContain('ibuprofen');
      expect(items.find((i: any) => i.relatedEntity === 'naproxen')!.critical).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('joins a concurrent sweep instead of racing the dedup boundary', async () => {
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await gateway.start();
    warn.mockRestore(); log.mockRestore();

    const p1 = gateway.runTranscriptSweep();
    const p2 = gateway.runTranscriptSweep(); // same tick, before p1 resolves
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2); // both awaited the SAME in-flight run (one execution, one result object)
  });

  it('restarts the nightly sweep with a live callback after stop', async () => {
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    const scheduled: Array<{
      expression: string;
      callback: ((now: Date | 'manual' | 'init') => void) | string;
      options?: cron.ScheduleOptions;
    }> = [];
    const scheduleMock = cron.schedule as jest.MockedFunction<typeof cron.schedule>;
    scheduleMock.mockClear();
    scheduleMock.mockImplementation((expression, callback, options) => {
      scheduled.push({ expression, callback, options });
      return { stop: jest.fn() } as unknown as cron.ScheduledTask;
    });

    try {
      await gateway.start();
      await gateway.stop();
      await gateway.start();

      const latest = scheduled.at(-1);
      expect(latest).toMatchObject({ expression: '15 3 * * *', options: { scheduled: true, timezone: 'Asia/Kolkata' } });
      expect(typeof latest?.callback).toBe('function');
      await expect(gateway.runTranscriptSweep()).resolves.toMatchObject({ scanned: true });
    } finally {
      scheduleMock.mockReset();
    }
  });

  it('does not run a sweep after stop', async () => {
    gateway = new Gateway(makeConfig(tmpDir), await bindGatewayOwner(makeConfig(tmpDir), CHAT_BINDING));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await gateway.start();
    warn.mockRestore(); log.mockRestore();

    await gateway.stop();
    expect(await gateway.runTranscriptSweep()).toEqual({ scanned: false, added: 0 });
  });
});
