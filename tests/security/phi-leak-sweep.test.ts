// tests/security/phi-leak-sweep.test.ts
//
// SEC-M1 regression deliverable: for each runtime-proven PHI leak site, drive
// the failure path with a PHI marker injected into the error message and
// assert (a) the marker never reaches console output and (b) the sanitized
// name/frame DOES reach console. Pattern follows tests/scheduler/runtime.test.ts
// 'sanitized lastError'. These tests FAIL on the reverted (pre-W3F-B) source
// because the raw error object/message was logged directly.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryIndexer } from '../../src/memory/indexer';
import { MemorySearch } from '../../src/memory/search';
import { SqliteStore } from '../../src/memory/sqlite-store';
import { SessionManager } from '../../src/gateway/session';
import { ToolRegistry } from '../../src/tools/registry';
import { createMedicalTools } from '../../src/tools/medical-tools';
import { createMemoryTools } from '../../src/tools/memory-tools';
import { MemoryEngine } from '../../src/memory/memory-engine';
import type { LLMProvider } from '../../src/providers/types';
import type { Tool } from '../../src/tools/types';

const PHI = 'glucose-PHI-marker-142857';

describe('SEC-M1 PHI leak sweep — raw error objects never reach console', () => {
  afterEach(() => jest.restoreAllMocks());

  // ── medical-tools.ts: medical provider + main provider both fail → two logs.
  it('medgemma_query logs a sanitized frame, never the PHI-bearing provider error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-med-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'HEALTH_PROFILE.md'), '# none');
      const engine = new MemoryEngine(tmpDir);
      const failingMedical: LLMProvider = {
        chat: jest.fn().mockRejectedValue(new Error(`medical provider failed: ${PHI}`)),
        embed: jest.fn().mockRejectedValue(new Error(`embed failed: ${PHI}`)),
      };
      const failingMain: LLMProvider = {
        chat: jest.fn().mockRejectedValue(new Error(`main provider failed: ${PHI}`)),
        embed: jest.fn().mockRejectedValue(new Error(`embed failed: ${PHI}`)),
      };
      const tools = createMedicalTools(engine, undefined, failingMedical, failingMain, tmpDir, {
        mainProviderType: 'ollama',
      });
      const query = tools.find((t) => t.name === 'medgemma_query')!;
      await query.execute({ question: 'What about my blood sugar?' });

      const combined = warnSpy.mock.calls.flat().map(String).join('\n')
        + '\n' + errorSpy.mock.calls.flat().map(String).join('\n');
      expect(combined).not.toContain(PHI);
      expect(combined).not.toContain('medical provider failed');
      expect(combined).toContain('medgemma_query');
      expect(combined).toContain('Error');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── gateway/session.ts: compaction flush + summary chat both throw PHI error.
  it('session compaction logs a sanitized frame, never the PHI-bearing provider error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-sess-'));
    try {
      const provider: LLMProvider = {
        chat: jest.fn().mockRejectedValue(new Error(`compact summary failed: ${PHI}`)),
        embed: jest.fn().mockResolvedValue([0.1]),
      };
      const registry = new ToolRegistry({ allow: ['*'], deny: [] });
      const manager = new SessionManager(
        240,
        1440,
        tmpDir,
        provider,
        registry,
        { enabled: true, triggerAtTokenPercent: 80, memoryFlush: true, keepRecentTurns: 2 },
      );
      // I3 added bounded retries to compaction LLM calls; this test asserts log
      // sanitization, so use a single fast attempt to stay inside the timeout.
      manager.setCompactionRetryPolicy({ attempts: 1 });
      const chatId = 'chat-phi';
      for (let i = 0; i < 6; i++) {
        await manager.addTurn(chatId, { role: 'user', content: `u${i}` }, { role: 'assistant', content: `a${i}` });
      }
      await expect(manager.runCompaction(chatId)).resolves.toBeUndefined();

      const warnText = warnSpy.mock.calls.flat().map(String).join('\n');
      // The PHI marker in the provider error must never reach console; the
      // flush (line 222) and compact (line 255) catches both log the frame.
      expect(warnText).not.toContain(PHI);
      expect(warnText).not.toContain('compact summary failed');
      expect(warnText).toContain('session');
      expect(warnText).toContain('Error');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── memory/indexer.ts: embedding failure logs sanitized frame.
  it('indexer embed failure logs a sanitized frame, never the PHI-bearing chunk error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-idx-'));
    try {
      const store = new SqliteStore(path.join(tmpDir, 'test.db'));
      const provider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockRejectedValue(new Error(`embed failed: ${PHI}`)),
      };
      fs.writeFileSync(path.join(tmpDir, 'note.md'), `Diagnosis: ${PHI}\nMore content to chunk here.`);
      const indexer = new MemoryIndexer(store, provider, tmpDir);
      await indexer.indexFile('note.md');
      store.close();

      const warnText = warnSpy.mock.calls.flat().map(String).join('\n');
      expect(warnText).not.toContain(PHI);
      expect(warnText).not.toContain('embed failed');
      expect(warnText).toContain('indexer');
      expect(warnText).toContain('Error');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── memory/search.ts: vector search embedding failure logs sanitized frame.
  it('search vector failure logs a sanitized frame, never the PHI-bearing query error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-search-'));
    try {
      const store = new SqliteStore(path.join(tmpDir, 'test.db'));
      const query = `glucose spikes ${PHI}`;
      const provider: LLMProvider = {
        chat: jest.fn(),
        embed: jest.fn().mockRejectedValue(new Error(`vector embed failed: ${PHI}`)),
      };
      const search = new MemorySearch(store, provider, { vector: 0.7, keyword: 0.3 });
      await search.search(query, 5);
      store.close();

      const warnText = warnSpy.mock.calls.flat().map(String).join('\n');
      expect(warnText).not.toContain(PHI);
      expect(warnText).not.toContain('vector embed failed');
      expect(warnText).toContain('search');
      expect(warnText).toContain('Error');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── tools/registry.ts: tool execution throws PHI-bearing error.
  it('tool registry execution error logs a sanitized frame, never the PHI-bearing tool error', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const throwingTool: Tool = {
      name: 'leaky',
      group: 'group:test',
      description: 'throws a PHI-bearing error',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        throw new Error(`tool failed: ${PHI}`);
      },
    };
    const registry = new ToolRegistry({ allow: ['*'], deny: [] });
    registry.register(throwingTool);
    const result = await registry.execute('leaky', {});
    // The full tool error text is still returned to the agent (persisted into
    // the 0600 session JSONL), but the console log must be sanitized.
    expect((result.content[0] as { text: string }).text).toContain(PHI);
    const errorText = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(errorText).not.toContain(PHI);
    expect(errorText).toContain('leaky');
    expect(errorText).toContain('Error');
  });

  // ── profiles/registry.ts: deleteProfile rename failure logs sanitized frame.
  it('profiles deleteProfile quarantine failure logs a sanitized frame, never the PHI-bearing fs error', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const fsReal = jest.requireActual<typeof import('fs')>('fs');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-profs-'));
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ProfileRegistry } = require('../../src/profiles/registry');
      const registry = new ProfileRegistry(tmpDir);
      const profile = registry.createProfile('test-profile');
      fs.mkdirSync(path.join(tmpDir, 'profiles', profile.profileId), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'profiles', profile.profileId, 'note.md'), 'data');

      const originalRename = fsReal.renameSync;
      const renameSpy = jest.spyOn(fsReal, 'renameSync').mockImplementation((src, dest) => {
        const destStr = typeof dest === 'string' ? dest : dest.toString();
        if (destStr.includes('.trash')) {
          throw new Error(`rename fs failure: ${PHI}`);
        }
        return originalRename.call(fsReal, src, dest);
      });
      registry.deleteProfile(profile.profileId);
      renameSpy.mockRestore();

      const errorText = errorSpy.mock.calls.flat().map(String).join('\n');
      expect(errorText).not.toContain(PHI);
      expect(errorText).not.toContain('rename fs failure');
      expect(errorText).toContain('profiles');
      expect(errorText).toContain('Error');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Sweep additions the review MISSED — each driven with a PHI marker.
describe('SEC-M1 extra sweep — review-missed raw-error logs', () => {
  afterEach(() => jest.restoreAllMocks());

  // memory-tools.ts:88 reindex catch logs sanitized frame.
  it('memory_write append reindex failure logs a sanitized frame, never the PHI-bearing reindex error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-reindex-'));
    try {
      const engine = new MemoryEngine(tmpDir);
      const failingIndexer = {
        indexFile: jest.fn().mockRejectedValue(new Error(`reindex failed: ${PHI}`)),
      };
      const tools = createMemoryTools(engine, undefined, failingIndexer as unknown as Parameters<typeof createMemoryTools>[2]);
      const writeTool = tools.find((t) => t.name === 'memory_write')!;
      await writeTool.execute({ path: 'note.md', content: 'a benign health note', mode: 'overwrite' });
      // The reindex runs fire-and-forget; allow the rejected promise to settle.
      await new Promise((r) => setImmediate(r));

      const warnText = warnSpy.mock.calls.flat().map(String).join('\n');
      expect(warnText).not.toContain(PHI);
      expect(warnText).not.toContain('reindex failed');
      expect(warnText).toContain('memory-tools');
      expect(warnText).toContain('Error');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // scheduler/audit-log.ts:43 rotation failure logs sanitized frame.
  it('audit-log rotation failure logs a sanitized frame, never the PHI-bearing rotation error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phi-audit-'));
    try {
      // Force the rotation check to throw on the first append (appendCount === 1
      // triggers a rotation check). Inject a PHI-bearing throw via the rotation
      // module that audit-log imports.
      jest.isolateModules(() => {
        jest.doMock('../../src/scheduler/rotation', () => ({
          rotateFileIfNeeded: jest.fn().mockImplementation(() => {
            throw new Error(`rotation failed: ${PHI}`);
          }),
        }));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { SchedulerAuditLog } = require('../../src/scheduler/audit-log');
        const log = new SchedulerAuditLog(path.join(tmpDir, 'audit.jsonl'));
        log.append({
          type: 'job.executed' as never,
          jobId: 'j1',
          at: new Date().toISOString(),
        } as unknown as Parameters<typeof log.append>[0]);
      });
      jest.dontMock('../../src/scheduler/rotation');

      const warnText = warnSpy.mock.calls.flat().map(String).join('\n');
      expect(warnText).not.toContain(PHI);
      expect(warnText).not.toContain('rotation failed');
      expect(warnText).toContain('audit-log');
      expect(warnText).toContain('Error');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});