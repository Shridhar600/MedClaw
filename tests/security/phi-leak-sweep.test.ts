
import * as fs from 'fs';
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
import { Gateway } from '../../src/gateway';
import { composeOwnerAuthority, loadRuntimeConfig } from '../../src/runtime';
import { asProfileId } from '../../src/profiles';
import { writeConfigFixture } from '../helpers/config-fixture';
import { stageMediaFixture } from '../helpers/media-artifact-fixture';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

const PHI = 'glucose-PHI-marker-142857';

describe('PHI leak sweep — raw error objects never reach console', () => {
  afterEach(() => jest.restoreAllMocks());

  it('medgemma_query logs a sanitized frame, never the PHI-bearing provider error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const tmpDir = makeTestTemp('phi-med-');
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
    const tmpDir = makeTestTemp('phi-sess-');
    try {
      const provider: LLMProvider = {
        chat: jest.fn().mockRejectedValue(Object.assign(new Error(`compact summary failed: ${PHI}`), { status: 400 })),
        embed: jest.fn().mockResolvedValue([0.1]),
      };
      const registry = new ToolRegistry({ allow: ['*'], deny: [] });
      const manager = new SessionManager(
        tmpDir,
        provider,
        registry,
        { enabled: true, memoryFlush: true, keepRecentTurns: 2 },
      );
      const chatId = 'chat-phi';
      for (let i = 0; i < 6; i++) {
        await manager.addTurn(chatId, { role: 'user', content: `u${i}` }, { role: 'assistant', content: `a${i}` });
      }
      await expect(manager.runCompaction(chatId)).resolves.toBeUndefined();

      const warnText = warnSpy.mock.calls.flat().map(String).join('\n');
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
    const tmpDir = makeTestTemp('phi-idx-');
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
    const tmpDir = makeTestTemp('phi-search-');
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
    expect((result.content[0] as { text: string }).text).toContain(PHI);
    const errorText = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(errorText).not.toContain(PHI);
    expect(errorText).toContain('leaky');
    expect(errorText).toContain('Error');
  });

  // ── destructive fs op on owner data logs a sanitized frame, never the PHI-bearing error.
  it('staged-media unlink failure reaches the real boot consumer with only closed fields', async () => {
    const errorSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fsReal = jest.requireActual<typeof import('fs')>('fs');
    const staging = makeTestTemp('phi-staging');
    const fixture = writeConfigFixture(staging);
    const authority = composeOwnerAuthority({ ownerId: asProfileId(fixture.ownerId)!, ownerPaths: { ownerRecord: fixture.ownerRecord } });
    await authority.admission.initialize();
    const artifact = await stageMediaFixture(fixture.workspace, fixture.mediaStaging, 'data');
    const gateway = new Gateway(await loadRuntimeConfig({ configPath: fixture.configPath }), authority);
    try {
      const unlinkSpy = jest.spyOn(fsReal, 'unlinkSync').mockImplementation(() => {
        throw new Error(`unlink fs failure: ${PHI}`);
      });

      await gateway.start();
      unlinkSpy.mockRestore();

      const warnText = errorSpy.mock.calls.flat().map(String).join('\n');
      // The PHI marker and the raw message never appear…
      expect(warnText).not.toContain(PHI);
      expect(warnText).not.toContain('unlink fs failure');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(warnText).toBe('[gateway] Media staging cleanup partial: reason=io-failed inspected=1 removed=0');
      expect(gateway.stagingCleanupResult).toEqual({ kind: 'partial', reason: 'io-failed', inspected: 1, removed: 0 });
      expect(fs.readFileSync(artifact, 'utf8')).toBe('data');
      expect(warnText).not.toContain(staging);
    } finally {
      await gateway.stop();
      removeTestTemp(staging);
      errorSpy.mockRestore();
    }
  });

  it('memory_write append reindex failure logs a sanitized frame, never the PHI-bearing reindex error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tmpDir = makeTestTemp('phi-reindex-');
    try {
      const engine = new MemoryEngine(tmpDir);
      const failingIndexer = {
        indexFile: jest.fn().mockRejectedValue(new Error(`reindex failed: ${PHI}`)),
      };
      const tools = createMemoryTools(engine, undefined, failingIndexer as unknown as Parameters<typeof createMemoryTools>[2]);
      const writeTool = tools.find((t) => t.name === 'memory_write')!;
      await writeTool.execute({ path: 'note.md', content: 'a benign health note', mode: 'overwrite' });
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
    const tmpDir = makeTestTemp('phi-audit-');
    try {
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
