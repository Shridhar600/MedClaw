
import * as fs from 'fs';
import * as path from 'path';

import { MemoryEngine } from '../../src/memory/memory-engine';
import { SessionManager } from '../../src/gateway/session';
import { HeartbeatStore } from '../../src/scheduler/store';
import { SchedulerAuditLog } from '../../src/scheduler/audit-log';
import { syncHeartbeatMarkdown } from '../../src/scheduler/heartbeat-markdown';
import type { HeartbeatJob } from '../../src/scheduler/types';
import { ensureWorkspaceBootstrap } from '../../src/workspace/bootstrap';
import { OnboardingStore } from '../../src/onboarding/store';
import { writeOnboardingProfile } from '../../src/onboarding/profile-writer';
import {
  secureMkdir,
  secureWrite,
  secureWriteViaTmp,
  secureAppend,
  secureCopyFile,
  secureChmodTree,
} from '../../src/security/secure-fs';
import { writeConfigDocument } from '../../src/runtime/installation';
import { cloneStoredDefaults } from '../../src/config/defaults';
import { LedgerStore } from '../../src/memcore/ledger-store';
import { makeTestTemp } from '../helpers/test-temp';

const DIR = 0o700;
const FILE = 0o600;

function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

function expectDirMode(p: string): void {
  expect(fs.existsSync(p)).toBe(true);
  expect(modeOf(p)).toBe(DIR);
}

function expectFileMode(p: string): void {
  expect(fs.existsSync(p)).toBe(true);
  expect(modeOf(p)).toBe(FILE);
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

function makeRoot(): string {
  return makeTestTemp('redacted-modes-');
}

describe('PHI file modes', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('secure-fs helpers', () => {
    it('secureMkdir creates a directory at 0o700', () => {
      const d = path.join(root, 'sec');
      secureMkdir(d);
      expectDirMode(d);
    });

    it('secureMkdir tightens a pre-existing 0o755 leaf to 0o700', () => {
      const d = path.join(root, 'loose');
      fs.mkdirSync(d, 0o755);
      fs.chmodSync(d, 0o755); // Establish the loose fixture even under a restrictive process umask.
      expect(modeOf(d)).toBe(0o755);
      secureMkdir(d);
      expect(modeOf(d)).toBe(DIR);
    });

    it('secureWrite creates a file at 0o600', () => {
      const f = path.join(root, 'a.txt');
      secureWrite(f, 'hello');
      expectFileMode(f);
    });

    it('secureWrite tightens a pre-existing 0o644 file to 0o600', () => {
      const f = path.join(root, 'b.txt');
      fs.writeFileSync(f, 'old', { mode: 0o644 });
      fs.chmodSync(f, 0o644);
      expect(modeOf(f)).toBe(0o644);
      secureWrite(f, 'new');
      expectFileMode(f);
    });

    it('secureWriteViaTmp leaves the final file at 0o600 (umask/rename defense)', () => {
      const f = path.join(root, 'c.txt');
      secureWriteViaTmp(f, 'atomic');
      expectFileMode(f);
    });

    it('secureWriteViaTmp tightens a pre-existing loose target', () => {
      const f = path.join(root, 'd.txt');
      fs.writeFileSync(f, 'loose', { mode: 0o644 });
      fs.chmodSync(f, 0o644);
      secureWriteViaTmp(f, 'replaced');
      expectFileMode(f);
    });

    it('secureAppend creates a new file at 0o600', () => {
      const f = path.join(root, 'e.txt');
      secureAppend(f, 'line1\n');
      expectFileMode(f);
    });

    it('secureAppend tightens an existing 0o644 file on first touch', () => {
      const f = path.join(root, 'f.txt');
      fs.writeFileSync(f, 'loose\n', { mode: 0o644 });
      fs.chmodSync(f, 0o644);
      expect(modeOf(f)).toBe(0o644);
      secureAppend(f, 'more\n');
      expectFileMode(f);
      secureAppend(f, 'even more\n');
      expectFileMode(f);
    });

    it('secureCopyFile chmods the destination to 0o600', () => {
      const src = path.join(root, 'src.txt');
      secureWrite(src, 'payload');
      const dest = path.join(root, 'copy.txt');
      fs.writeFileSync(dest, 'stale', { mode: 0o644 });
      fs.chmodSync(dest, 0o644);
      secureCopyFile(src, dest);
      expectFileMode(dest);
      expect(fs.readFileSync(dest, 'utf8')).toBe('payload');
    });

    it('secureChmodTree tightens a mixed dir tree (dirs 0o700, files 0o600)', () => {
      const base = path.join(root, 'tree');
      fs.mkdirSync(base, 0o755);
      fs.mkdirSync(path.join(base, 'sub'), 0o755);
      fs.writeFileSync(path.join(base, 'x.md'), 'x', { mode: 0o644 });
      fs.writeFileSync(path.join(base, 'sub', 'y.md'), 'y', { mode: 0o644 });
      for (const directory of [base, path.join(base, 'sub')]) fs.chmodSync(directory, 0o755);
      for (const file of [path.join(base, 'x.md'), path.join(base, 'sub', 'y.md')]) fs.chmodSync(file, 0o644);
      secureChmodTree(base);
      expectDirMode(base);
      expectDirMode(path.join(base, 'sub'));
      expectFileMode(path.join(base, 'x.md'));
      expectFileMode(path.join(base, 'sub', 'y.md'));
    });
  });

  describe('MemoryEngine', () => {
    it('workspace dir and memory files are 0o700 / 0o600', async () => {
      const ws = path.join(root, 'mem');
      const engine = new MemoryEngine(ws, 'default');
      await engine.writeFile('conditions/cancer.md', 'stage II');
      expectDirMode(ws);
      expectDirMode(path.join(ws, 'conditions'));
      expectFileMode(path.join(ws, 'conditions', 'cancer.md'));
    });

    it('appendToFile tightens a pre-existing loose memory file to 0o600', async () => {
      const ws = path.join(root, 'mem2');
      const engine = new MemoryEngine(ws, 'default');
      // Pre-create a loose PHI file the way a (hypothetical) legacy writer would.
      fs.mkdirSync(path.join(ws, 'medications'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'medications', 'metformin.md'), 'old\n', { mode: 0o644 });
      fs.chmodSync(path.join(ws, 'medications', 'metformin.md'), 0o644);
      expect(modeOf(path.join(ws, 'medications', 'metformin.md'))).toBe(0o644);

      await engine.appendToFile('medications/metformin.md', 'new dose\n');
      expectFileMode(path.join(ws, 'medications', 'metformin.md'));
    });
  });

  describe('SessionManager', () => {
    const mkMsg = (role: 'user' | 'assistant', content: string) => ({ role, content });

    it('sessions dir and day-file archive are 0o700 / 0o600', async () => {
      const sessionsPath = path.join(root, 'sessions');
      const sm = new SessionManager(sessionsPath, undefined, undefined, undefined, 'default');
      await sm.recordTurn('123', [mkMsg('user', 'my back hurts'), mkMsg('assistant', 'sorry to hear')]);
      expectDirMode(sessionsPath);
      expectFileMode(path.join(sessionsPath, new Date().toISOString().slice(0, 10) + '.jsonl'));
    });

    it('reset preserves the day-file archive 0600 and writes an empty window (no archive/summaries side-files)', async () => {
      const sessionsPath = path.join(root, 'sessions2');
      const sm = new SessionManager(sessionsPath, undefined, undefined, undefined, 'default');
      await sm.recordTurn('456', [mkMsg('user', 'hi'), mkMsg('assistant', 'hello')]);
      await sm.resetSession('456');

      expect(fs.existsSync(path.join(sessionsPath, 'archive'))).toBe(false);
      expect(fs.existsSync(path.join(sessionsPath, 'summaries'))).toBe(false);

      // The append-only day file is preserved at 0600 (searchable), and the replacement window is 0600.
      expectDirMode(sessionsPath);
      expectFileMode(path.join(sessionsPath, new Date().toISOString().slice(0, 10) + '.jsonl'));
      expectFileMode(path.join(sessionsPath, 'session-window.json'));
      expect(JSON.parse(fs.readFileSync(path.join(sessionsPath, 'session-window.json'), 'utf8')).summaryBlock).toBe('');
    });

    it('append to a pre-existing loose day file tightens it to 0o600', async () => {
      const sessionsPath = path.join(root, 'sessions3');
      fs.mkdirSync(sessionsPath, 0o755);
      fs.chmodSync(sessionsPath, 0o755);
      const day = path.join(sessionsPath, new Date().toISOString().slice(0, 10) + '.jsonl');
      fs.writeFileSync(day, '{"timestamp":"t","role":"user","content":"x","chatId":"789"}\n', { mode: 0o644 });
      fs.chmodSync(day, 0o644);
      expect(modeOf(day)).toBe(0o644);

      const sm = new SessionManager(sessionsPath, undefined, undefined, undefined, 'default');
      await sm.recordTurn('789', [mkMsg('assistant', 'ok')]);
      expectFileMode(day);
      expectDirMode(sessionsPath);
    });
  });

  describe('HeartbeatStore', () => {
    it('store dir and heartbeat-jobs.json are 0o700 / 0o600', async () => {
      const storePath = path.join(root, '.state', 'heartbeat-jobs.json');
      const store = new HeartbeatStore(storePath, 'default');
      await store.create({
        title: 'Morning check-in',
        chatId: 'chat-1',
        cron: '0 9 * * *',
        prompt: 'How are you feeling today?',
        source: 'user',
        kind: 'routine',
      });
      expectDirMode(path.dirname(storePath));
      expectFileMode(storePath);

      const list = await store.list();
      await store.markRun(list[0].id, new Date().toISOString());
      expectFileMode(storePath);
    });
  });

  describe('SchedulerAuditLog', () => {
    it('audit dir and audit.jsonl are 0o700 / 0o600', async () => {
      const logPath = path.join(root, '.state', 'audit.jsonl');
      const log = new SchedulerAuditLog(logPath, 'default');
      await log.append({
        jobId: 'j1',
        chatId: 'chat-1',
        type: 'triggered',
        at: new Date().toISOString(),
        details: { ok: true },
      });
      expectDirMode(path.dirname(logPath));
      expectFileMode(logPath);
    });

    it('append to a pre-existing loose audit log tightens it to 0o600', async () => {
      const logPath = path.join(root, '.state2', 'audit.jsonl');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, '', { mode: 0o644 });
      fs.chmodSync(logPath, 0o644);
      expect(modeOf(logPath)).toBe(0o644);
      const log = new SchedulerAuditLog(logPath, 'default');
      await log.append({
        jobId: 'j2',
        chatId: 'chat-1',
        type: 'sent',
        at: new Date().toISOString(),
      });
      expectFileMode(logPath);
    });
  });

  describe('syncHeartbeatMarkdown', () => {
    it('workspace dir and HEARTBEAT.md are 0o700 / 0o600', async () => {
      const ws = path.join(root, 'hbsync');
      const jobs = [{
        id: 'x', title: 't', chatId: 'c', cron: '* * * * *', timezone: 'UTC',
        prompt: 'p', enabled: true, source: 'user', kind: 'routine',
        deliveryState: 'ready', retryCount: 0, maxRetries: 0,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }] as HeartbeatJob[];
      await syncHeartbeatMarkdown(ws, jobs);
      expectDirMode(ws);
      expectFileMode(path.join(ws, 'HEARTBEAT.md'));
    });
  });

  describe('ensureWorkspaceBootstrap', () => {
    it('workspace dir, required dirs (0o700) and copied templates (0o600)', () => {
      const ws = path.join(root, 'wsboot');
      ensureWorkspaceBootstrap(ws, { preserveExisting: false });
      expectDirMode(ws);
      for (const d of ['conditions', 'medications', 'reports', 'goals', 'memory', 'summaries', 'archive']) {
        expectDirMode(path.join(ws, d));
      }
      for (const f of ['SOUL.md', 'USER.md', 'HEALTH_PROFILE.md', 'HEARTBEAT.md']) {
        expectFileMode(path.join(ws, f));
      }
    });
  });

  describe('OnboardingStore', () => {
    it('state dir and onboarding.json are 0o700 / 0o600', async () => {
      const store = new OnboardingStore(root);
      await store.save({
        status: 'in_progress',
        currentStep: 'conditions',
        answers: { name: 'Owner', age: '42', conditions: 'hypertension' },
      });
      const stateDir = path.join(root, '.redacted');
      const stateFile = path.join(stateDir, 'onboarding.json');
      expectDirMode(stateDir);
      expectFileMode(stateFile);
    });
  });

  describe('writeOnboardingProfile', () => {
    it('workspace dir and USER.md / HEALTH_PROFILE.md are 0o700 / 0o600', async () => {
      const ws = path.join(root, 'pwd');
      fs.mkdirSync(ws, 0o755);
      await writeOnboardingProfile(ws, {
        name: 'Owner',
        age: '42',
        timezone: 'UTC',
        conditions: 'asthma',
        medications: 'inhaler',
        allergies: 'penicillin',
        goals: 'walk daily',
      });
      expectDirMode(ws);
      expectFileMode(path.join(ws, 'USER.md'));
      expectFileMode(path.join(ws, 'HEALTH_PROFILE.md'));
    });
  });

  // The durable owner record holds the chat identifier, so it is owner-only (0600) in a 0700 dir.
  describe('owner enrollment record', () => {
    it('is written 0600 inside a 0700 owner workspace, and stays that way through a binding', async () => {
      const { composeOwnerAuthority } = await import('../../src/runtime/owner-authority');
      const { resolveOwnerPaths } = await import('../../src/profiles');

      const baseDir = path.join(root, 'owner-base');
      const ownerId = 'default' as never;
      const paths = resolveOwnerPaths(baseDir, ownerId);
      fs.mkdirSync(path.dirname(paths.ownerRecord), { recursive: true, mode: 0o700 });

      const authority = composeOwnerAuthority({ ownerId, ownerPaths: { ownerRecord: paths.ownerRecord } });
      await authority.admission.initialize();

      expect(fs.existsSync(paths.ownerRecord)).toBe(true);
      expectFileMode(paths.ownerRecord);
      expectDirMode(paths.workspace);
      expectDirMode(path.dirname(paths.ownerRecord));

      const issued = await authority.admission.issueChallenge();
      if (issued.kind === 'issued') {
        await authority.admission.handlePairing(
          {
            channel: 'telegram', chatId: 'owner-chat', userId: 'owner-user',
            chatType: 'private', eventId: 'telegram:owner-chat:bind',
          },
          issued.plaintext,
        );
      }
      expectFileMode(paths.ownerRecord);

      const raw = fs.readFileSync(paths.ownerRecord, 'utf8');
      if (issued.kind === 'issued') {
        expect(raw).not.toContain(issued.plaintext);
      }
      expect(raw).toContain('owner-chat');
    });
  });

  describe('writeConfigDocument', () => {
    it('creates the config parent dir at 0o700 and file at 0o600', () => {
      const configPath = path.join(root, '.redacted', 'config.json');
      const stored = cloneStoredDefaults();
      stored.profiles = { baseDir: root, defaultProfileId: 'default' };

      const outcome = writeConfigDocument(configPath, stored);

      expect(outcome.status).toBe('committed');
      expectDirMode(path.join(root, '.redacted'));
      expectFileMode(configPath);
    });
  });

  describe('LedgerStore', () => {
    it('ledger dir and fact file are 0o700 / 0o600', async () => {
      const ledgerRoot = path.join(root, 'ledger-profile');
      fs.mkdirSync(ledgerRoot, 0o755);
      const store = new LedgerStore(ledgerRoot);
      await store.recordFact({
        entity: 'walk-daily',
        type: 'goal',
        fields: { target: '30min' },
        provenance: {
          source: 'user',
          confidence: 0.9,
          anchor: 'onboarding',
          capturedAt: new Date().toISOString(),
        },
      });
      const ledgerDir = path.join(ledgerRoot, 'ledger');
      expectDirMode(ledgerDir);
      const files = listFiles(ledgerDir);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expectFileMode(f);
      }
    });
  });
});
