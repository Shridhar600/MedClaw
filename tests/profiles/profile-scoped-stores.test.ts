import * as fs from 'fs';
import * as path from 'path';
import { asProfileId, resolveOwnerPaths } from '../../src/profiles';
import type { ProfileId } from '../../src/profiles/types';
import { MemoryEngine } from '../../src/memory/memory-engine';
import { SessionManager } from '../../src/gateway/session';
import { HeartbeatStore } from '../../src/scheduler/store';
import { SchedulerAuditLog } from '../../src/scheduler/audit-log';
import { syncHeartbeatMarkdown } from '../../src/scheduler/heartbeat-markdown';
import { createMemoryTools } from '../../src/tools/memory-tools';
import { SqliteStore } from '../../src/memory/sqlite-store';
import { makeTestTemp, removeTestTemp } from '../helpers/test-temp';

describe('Profile-scoped store isolation', () => {
  let tmpDir: string;
  let baseDir: string;
  let profileA: ProfileId;
  let profileB: ProfileId;

  beforeEach(() => {
    tmpDir = makeTestTemp('profile-isolation');
    baseDir = path.join(tmpDir, 'base');
    fs.mkdirSync(baseDir, { recursive: true });
    profileA = asProfileId('alpha')!;
    profileB = asProfileId('beta')!;
    for (const id of [profileA, profileB]) {
      fs.mkdirSync(resolveOwnerPaths(baseDir, id).workspace, { recursive: true, mode: 0o700 });
    }
  });

  afterEach(() => {
    removeTestTemp(tmpDir);
  });

  /** The derivation that replaced `ownerPaths(id)` and friends. */
  const ownerPaths = (id: ProfileId): ReturnType<typeof resolveOwnerPaths> => resolveOwnerPaths(baseDir, id);

  describe('on-disk directory separation', () => {
    it('two profiles resolve to distinct workspace, session, scheduler, and audit directories', () => {
      const wsA = ownerPaths(profileA).workspace;
      const wsB = ownerPaths(profileB).workspace;
      const sessA = ownerPaths(profileA).sessions;
      const sessB = ownerPaths(profileB).sessions;
      const hbA = ownerPaths(profileA).schedulerStore;
      const hbB = ownerPaths(profileB).schedulerStore;
      const auditA = ownerPaths(profileA).auditLog;
      const auditB = ownerPaths(profileB).auditLog;

      expect(wsA).not.toBe(wsB);
      expect(sessA).not.toBe(sessB);
      expect(hbA).not.toBe(hbB);
      expect(auditA).not.toBe(auditB);

      expect(wsA).toContain(path.join('profiles', profileA));
      expect(wsB).toContain(path.join('profiles', profileB));
      expect(sessA).toContain(path.join('profiles', profileA, '.state', 'sessions'));
      expect(sessB).toContain(path.join('profiles', profileB, '.state', 'sessions'));
    });
  });

  describe('MemoryEngine isolation', () => {
    it('writes to profile A workspace are absent from profile B workspace', async () => {
      const wsA = ownerPaths(profileA).workspace;
      const wsB = ownerPaths(profileB).workspace;
      const engineA = new MemoryEngine(wsA, profileA);
      const engineB = new MemoryEngine(wsB, profileB);

      await engineA.writeFile('conditions/diabetes.md', 'A: fasting glucose 110');
      await engineB.writeFile('conditions/diabetes.md', 'B: blood pressure 130/85');

      const contentA = await engineA.readFile('conditions/diabetes.md');
      const contentB = await engineB.readFile('conditions/diabetes.md');

      expect(contentA).toBe('A: fasting glucose 110');
      expect(contentB).toBe('B: blood pressure 130/85');

      const onDiskA = fs.readFileSync(path.join(wsA, 'conditions', 'diabetes.md'), 'utf8');
      const onDiskB = fs.readFileSync(path.join(wsB, 'conditions', 'diabetes.md'), 'utf8');
      expect(onDiskA).toBe('A: fasting glucose 110');
      expect(onDiskB).toBe('B: blood pressure 130/85');

      expect(fs.existsSync(path.join(wsA, 'conditions', 'diabetes.md'))).toBe(true);
      expect(fs.existsSync(path.join(wsB, 'conditions', 'diabetes.md'))).toBe(true);
    });
  });

  describe('SessionManager isolation', () => {
    it('sessions recorded for profile A are absent from profile B directory', async () => {
      const sessA = ownerPaths(profileA).sessions;
      const sessB = ownerPaths(profileB).sessions;
      const mgrA = new SessionManager(sessA, undefined, undefined, undefined, profileA);
      new SessionManager(sessB, undefined, undefined, undefined, profileB);

      await mgrA.recordTurn('chat-1', [
        { role: 'user', content: 'A private data' },
        { role: 'assistant', content: 'A response' },
      ]);

      const dayFileName = new Date().toISOString().slice(0, 10) + '.jsonl';
      const filesA = fs.readdirSync(sessA).filter(f => f.endsWith('.jsonl'));
      const filesB = fs.readdirSync(sessB).filter(f => f.endsWith('.jsonl'));

      expect(filesA).toEqual([dayFileName]);
      expect(filesB.length).toBe(0);

      const jsonlContent = fs.readFileSync(path.join(sessA, dayFileName), 'utf8');
      expect(jsonlContent).toContain('A private data');
      expect(sessA).not.toBe(sessB);
    });

    it('two profiles can have sessions for the same chatId without collision', async () => {
      const sessA = ownerPaths(profileA).sessions;
      const sessB = ownerPaths(profileB).sessions;
      const mgrA = new SessionManager(sessA, undefined, undefined, undefined, profileA);
      const mgrB = new SessionManager(sessB, undefined, undefined, undefined, profileB);

      await mgrA.recordTurn('shared-chat', [
        { role: 'user', content: 'Profile A context' },
        { role: 'assistant', content: 'A reply' },
      ]);
      await mgrB.recordTurn('shared-chat', [
        { role: 'user', content: 'Profile B context' },
        { role: 'assistant', content: 'B reply' },
      ]);

      const dayFileName = new Date().toISOString().slice(0, 10) + '.jsonl';
      const contentA = fs.readFileSync(path.join(sessA, dayFileName), 'utf8');
      const contentB = fs.readFileSync(path.join(sessB, dayFileName), 'utf8');

      expect(contentA).toContain('Profile A context');
      expect(contentB).toContain('Profile B context');
      expect(contentA).not.toContain('Profile B context');
      expect(contentB).not.toContain('Profile A context');
    });
  });

  describe('HeartbeatStore isolation', () => {
    it('heartbeat jobs for profile A land under profiles/A/.state/ and are absent from B', async () => {
      const hbPathA = ownerPaths(profileA).schedulerStore;
      const hbPathB = ownerPaths(profileB).schedulerStore;
      const storeA = new HeartbeatStore(hbPathA, profileA);
      const storeB = new HeartbeatStore(hbPathB, profileB);

      await storeA.create({
        title: 'A morning check',
        chatId: 'chat-a',
        cron: '0 8 * * *',
        timezone: 'UTC',
        prompt: 'How are you?',
        source: 'agent',
        kind: 'routine',
      });

      const jobsA = await storeA.list();
      const jobsB = await storeB.list();

      expect(jobsA.length).toBe(1);
      expect(jobsA[0].title).toBe('A morning check');
      expect(jobsB.length).toBe(0);

      expect(fs.existsSync(hbPathA)).toBe(true);
      const hbDirA = path.dirname(hbPathA);
      expect(hbDirA).toContain(path.join('profiles', profileA, '.state'));

      if (fs.existsSync(hbPathB)) {
        const rawB = fs.readFileSync(hbPathB, 'utf8');
        expect(JSON.parse(rawB)).toEqual([]);
      }
    });
  });

  describe('SchedulerAuditLog isolation', () => {
    it('audit events for profile A are absent from profile B', async () => {
      const auditPathA = ownerPaths(profileA).auditLog;
      const auditPathB = ownerPaths(profileB).auditLog;
      const auditA = new SchedulerAuditLog(auditPathA, profileA);
      new SchedulerAuditLog(auditPathB, profileB);

      await auditA.append({
        jobId: 'job-1',
        chatId: 'chat-a',
        type: 'triggered',
        at: new Date().toISOString(),
      });

      expect(fs.existsSync(auditPathA)).toBe(true);
      const linesA = fs.readFileSync(auditPathA, 'utf8').trim().split('\n').filter(Boolean);
      expect(linesA.length).toBe(1);
      expect(JSON.parse(linesA[0]).jobId).toBe('job-1');

      expect(fs.existsSync(auditPathB)).toBe(false);

      const auditDirA = path.dirname(auditPathA);
      const auditDirB = path.dirname(auditPathB);
      expect(auditDirA).toContain(path.join('profiles', profileA, '.state'));
      expect(auditDirB).toContain(path.join('profiles', profileB, '.state'));
      expect(auditDirA).not.toBe(auditDirB);
    });
  });

  describe('syncHeartbeatMarkdown profile-scoped workspace', () => {
    it('writes HEARTBEAT.md to the profile workspace it is given, not to any other directory', async () => {
      const wsA = ownerPaths(profileA).workspace;
      const wsB = ownerPaths(profileB).workspace;
      const now = new Date().toISOString();

      await syncHeartbeatMarkdown(wsA, [{
        id: 'job-1',
        title: 'Morning check',
        chatId: 'chat-a',
        cron: '0 8 * * *',
        timezone: 'UTC',
        prompt: 'Good morning',
        enabled: true,
        source: 'agent',
        kind: 'routine',
        deliveryState: 'ready',
        retryCount: 0,
        maxRetries: 3,
        createdAt: now,
        updatedAt: now,
      }]);

      expect(fs.existsSync(path.join(wsA, 'HEARTBEAT.md'))).toBe(true);
      const contentA = fs.readFileSync(path.join(wsA, 'HEARTBEAT.md'), 'utf8');
      expect(contentA).toContain('Morning check');

      expect(fs.existsSync(path.join(wsB, 'HEARTBEAT.md'))).toBe(false);
    });
  });

  describe('SqliteStore profile-scoped search index isolation', () => {
    it('search index databases for two profiles are separate files', () => {
      const dbPathA = ownerPaths(profileA).searchDb;
      const dbPathB = ownerPaths(profileB).searchDb;

      expect(dbPathA).not.toBe(dbPathB);
      expect(dbPathA).toContain(path.join('profiles', profileA, '.state'));
      expect(dbPathB).toContain(path.join('profiles', profileB, '.state'));

      fs.mkdirSync(path.dirname(dbPathA), { recursive: true });
      fs.mkdirSync(path.dirname(dbPathB), { recursive: true });

      const storeA = new SqliteStore(dbPathA, profileA);
      const storeB = new SqliteStore(dbPathB, profileB);

      storeA.upsertChunk({
        id: 'chunk-a1',
        path: 'test.md',
        content: 'Profile A medical data',
        startLine: 1,
        endLine: 5,
        embedding: new Array(768).fill(0.1),
      });

      const allA = storeA.getAllChunksWithEmbeddings();
      const allB = storeB.getAllChunksWithEmbeddings();

      expect(allA.length).toBe(1);
      expect(allA[0].content).toBe('Profile A medical data');
      expect(allB.length).toBe(0);

      storeA.close();
      storeB.close();
    });
  });

  describe('createMemoryTools accepts profileId', () => {
    it('accepts profileId parameter and tools still operate on the correct profile workspace', async () => {
      const wsA = ownerPaths(profileA).workspace;
      const engineA = new MemoryEngine(wsA, profileA);
      const tools = createMemoryTools(engineA, undefined, undefined, profileA);

      expect(tools.length).toBeGreaterThanOrEqual(2);
      const getTool = tools.find(t => t.name === 'memory_get');
      const writeTool = tools.find(t => t.name === 'memory_write');
      expect(getTool).toBeDefined();
      expect(writeTool).toBeDefined();

      await writeTool!.execute!({ path: 'test.md', content: 'Profile A data', mode: 'overwrite' });
      const result = await getTool!.execute!({ path: 'test.md' });
      expect(result.content![0]).toEqual(expect.objectContaining({ text: 'Profile A data' }));

      const onDisk = fs.readFileSync(path.join(wsA, 'test.md'), 'utf8');
      expect(onDisk).toBe('Profile A data');
    });

    it('works without profileId for backward compatibility', async () => {
      const ws = path.join(tmpDir, 'compat-workspace');
      const engine = new MemoryEngine(ws);
      const tools = createMemoryTools(engine);

      expect(tools.length).toBeGreaterThanOrEqual(2);
      const writeTool = tools.find(t => t.name === 'memory_write');
      await writeTool!.execute!({ path: 'test.md', content: 'backward compat', mode: 'overwrite' });

      const onDisk = fs.readFileSync(path.join(ws, 'test.md'), 'utf8');
      expect(onDisk).toBe('backward compat');
    });
  });
});
