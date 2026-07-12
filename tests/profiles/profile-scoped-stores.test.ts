import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProfileRegistry } from '../../src/profiles/registry';
import type { ProfileId } from '../../src/profiles/types';
import { MemoryEngine } from '../../src/memory/memory-engine';
import { SessionManager } from '../../src/gateway/session';
import { HeartbeatStore } from '../../src/scheduler/store';
import { SchedulerAuditLog } from '../../src/scheduler/audit-log';
import { syncHeartbeatMarkdown } from '../../src/scheduler/heartbeat-markdown';
import { createMemoryTools } from '../../src/tools/memory-tools';
import { SqliteStore } from '../../src/memory/sqlite-store';

describe('Profile-scoped store isolation', () => {
  let tmpDir: string;
  let baseDir: string;
  let registry: ProfileRegistry;
  let profileA: ProfileId;
  let profileB: ProfileId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-profile-isolation-'));
    baseDir = path.join(tmpDir, 'base');
    fs.mkdirSync(baseDir, { recursive: true });
    registry = new ProfileRegistry(baseDir);
    profileA = registry.createProfile('alpha').profileId;
    profileB = registry.createProfile('beta').profileId;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('on-disk directory separation', () => {
    it('two profiles resolve to distinct workspace, session, scheduler, and audit directories', () => {
      const wsA = registry.profileWorkspace(profileA);
      const wsB = registry.profileWorkspace(profileB);
      const sessA = registry.profileSessions(profileA);
      const sessB = registry.profileSessions(profileB);
      const hbA = registry.profileSchedulerStore(profileA);
      const hbB = registry.profileSchedulerStore(profileB);
      const auditA = registry.profileAuditLog(profileA);
      const auditB = registry.profileAuditLog(profileB);

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
      const wsA = registry.profileWorkspace(profileA);
      const wsB = registry.profileWorkspace(profileB);
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
      const sessA = registry.profileSessions(profileA);
      const sessB = registry.profileSessions(profileB);
      const mgrA = new SessionManager(240, 1440, sessA, undefined, undefined, undefined, profileA);
      const mgrB = new SessionManager(240, 1440, sessB, undefined, undefined, undefined, profileB);

      await mgrA.recordTurn('chat-1', [
        { role: 'user', content: 'A private data' },
        { role: 'assistant', content: 'A response' },
      ]);

      const filesA = fs.readdirSync(sessA).filter(f => f.startsWith('active-'));
      const filesB = fs.readdirSync(sessB).filter(f => f.startsWith('active-'));

      expect(filesA.length).toBe(1);
      expect(filesA[0]).toBe('active-chat-1.jsonl');
      expect(filesB.length).toBe(0);

      const jsonlContent = fs.readFileSync(path.join(sessA, 'active-chat-1.jsonl'), 'utf8');
      expect(jsonlContent).toContain('A private data');
      expect(sessA).not.toBe(sessB);
    });

    it('two profiles can have sessions for the same chatId without collision', async () => {
      const sessA = registry.profileSessions(profileA);
      const sessB = registry.profileSessions(profileB);
      const mgrA = new SessionManager(240, 1440, sessA, undefined, undefined, undefined, profileA);
      const mgrB = new SessionManager(240, 1440, sessB, undefined, undefined, undefined, profileB);

      await mgrA.recordTurn('shared-chat', [
        { role: 'user', content: 'Profile A context' },
        { role: 'assistant', content: 'A reply' },
      ]);
      await mgrB.recordTurn('shared-chat', [
        { role: 'user', content: 'Profile B context' },
        { role: 'assistant', content: 'B reply' },
      ]);

      const contentA = fs.readFileSync(path.join(sessA, 'active-shared-chat.jsonl'), 'utf8');
      const contentB = fs.readFileSync(path.join(sessB, 'active-shared-chat.jsonl'), 'utf8');

      expect(contentA).toContain('Profile A context');
      expect(contentB).toContain('Profile B context');
      expect(contentA).not.toContain('Profile B context');
      expect(contentB).not.toContain('Profile A context');
    });
  });

  describe('HeartbeatStore isolation', () => {
    it('heartbeat jobs for profile A land under profiles/A/.state/ and are absent from B', async () => {
      const hbPathA = registry.profileSchedulerStore(profileA);
      const hbPathB = registry.profileSchedulerStore(profileB);
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
      const auditPathA = registry.profileAuditLog(profileA);
      const auditPathB = registry.profileAuditLog(profileB);
      const auditA = new SchedulerAuditLog(auditPathA, profileA);
      const auditB = new SchedulerAuditLog(auditPathB, profileB);

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
      const wsA = registry.profileWorkspace(profileA);
      const wsB = registry.profileWorkspace(profileB);
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
      const dbPathA = registry.profileSearchDb(profileA);
      const dbPathB = registry.profileSearchDb(profileB);

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
      const wsA = registry.profileWorkspace(profileA);
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
