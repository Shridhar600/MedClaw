// tests/security/file-modes.test.ts
//
// Asserts the threat-model §5.1 compensating control: every PHI-bearing
// directory is 0o700 and every PHI-bearing file is 0o600. Uses REAL tmpdir
// writes — no fs mocks — because the threat is the on-disk mode the OS sees.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { MemoryEngine } from '../../src/memory/memory-engine';
import { SessionManager } from '../../src/gateway/session';
import { HeartbeatStore } from '../../src/scheduler/store';
import { SchedulerAuditLog } from '../../src/scheduler/audit-log';
import { syncHeartbeatMarkdown } from '../../src/scheduler/heartbeat-markdown';
import type { HeartbeatJob } from '../../src/scheduler/types';
import { ensureWorkspaceBootstrap } from '../../src/workspace/bootstrap';
import { OnboardingStore } from '../../src/onboarding/store';
import { writeOnboardingProfile } from '../../src/onboarding/profile-writer';
import { ProfileRegistry } from '../../src/profiles/registry';
import {
  secureMkdir,
  secureWrite,
  secureWriteViaTmp,
  secureAppend,
  secureCopyFile,
  secureChmodTree,
} from '../../src/security/secure-fs';
import { saveConfig } from '../../src/config/config';
import { cloneDefaultConfig } from '../../src/config/defaults';
import { LedgerStore } from '../../src/memcore/ledger-store';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-modes-'));
}

describe('PHI file modes', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // ── secure-fs primitives ──────────────────────────────────────────

  describe('secure-fs helpers', () => {
    it('secureMkdir creates a directory at 0o700', () => {
      const d = path.join(root, 'sec');
      secureMkdir(d);
      expectDirMode(d);
    });

    it('secureMkdir tightens a pre-existing 0o755 leaf to 0o700', () => {
      const d = path.join(root, 'loose');
      fs.mkdirSync(d, 0o755);
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
      expect(modeOf(f)).toBe(0o644);
      secureAppend(f, 'more\n');
      expectFileMode(f);
      // a second append must keep it 0o600 (and not fall back to loose)
      secureAppend(f, 'even more\n');
      expectFileMode(f);
    });

    it('secureCopyFile chmods the destination to 0o600', () => {
      const src = path.join(root, 'src.txt');
      secureWrite(src, 'payload');
      const dest = path.join(root, 'copy.txt');
      // Warm a loose destination to prove copy then restricts it.
      fs.writeFileSync(dest, 'stale', { mode: 0o644 });
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
      secureChmodTree(base);
      expectDirMode(base);
      expectDirMode(path.join(base, 'sub'));
      expectFileMode(path.join(base, 'x.md'));
      expectFileMode(path.join(base, 'sub', 'y.md'));
    });
  });

  // ── memory engine ────────────────────────────────────────────────

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
      expect(modeOf(path.join(ws, 'medications', 'metformin.md'))).toBe(0o644);

      await engine.appendToFile('medications/metformin.md', 'new dose\n');
      expectFileMode(path.join(ws, 'medications', 'metformin.md'));
    });
  });

  // ── session manager ───────────────────────────────────────────────

  describe('SessionManager', () => {
    const mkMsg = (role: 'user' | 'assistant', content: string) => ({ role, content });

    it('sessions dir and active JSONL are 0o700 / 0o600', async () => {
      const sessionsPath = path.join(root, 'sessions');
      const sm = new SessionManager(60, 1440, sessionsPath, undefined, undefined, undefined, 'default');
      await sm.recordTurn('123', [mkMsg('user', 'my back hurts'), mkMsg('assistant', 'sorry to hear')]);
      expectDirMode(sessionsPath);
      expectFileMode(path.join(sessionsPath, 'active-123.jsonl'));
    });

    it('archive + summary dirs/files are 0o700 / 0o600 after reset', async () => {
      const sessionsPath = path.join(root, 'sessions2');
      const sm = new SessionManager(60, 1440, sessionsPath, undefined, undefined, undefined, 'default');
      await sm.recordTurn('456', [mkMsg('user', 'hi'), mkMsg('assistant', 'hello')]);
      await sm.resetSession('456');

      const archiveDir = path.join(sessionsPath, 'archive');
      const summariesDir = path.join(sessionsPath, 'summaries');
      expectDirMode(archiveDir);
      expectDirMode(summariesDir);

      const archives = listFiles(archiveDir).filter((p) => p.endsWith('.jsonl'));
      expect(archives.length).toBe(1);
      expectFileMode(archives[0]);

      const summaries = listFiles(summariesDir).filter((p) => p.endsWith('.md'));
      expect(summaries.length).toBe(1);
      expectFileMode(summaries[0]);

      // The active file must have been moved away.
      expect(fs.existsSync(path.join(sessionsPath, 'active-456.jsonl'))).toBe(false);
    });

    it('append to a pre-existing loose active JSONL tightens it to 0o600', async () => {
      const sessionsPath = path.join(root, 'sessions3');
      fs.mkdirSync(sessionsPath, 0o755);
      const active = path.join(sessionsPath, 'active-789.jsonl');
      fs.writeFileSync(active, '{"timestamp":"t","role":"user","content":"x","chatId":"789"}\n', { mode: 0o644 });
      expect(modeOf(active)).toBe(0o644);

      const sm = new SessionManager(60, 1440, sessionsPath, undefined, undefined, undefined, 'default');
      await sm.recordTurn('789', [mkMsg('assistant', 'ok')]);
      expectFileMode(active);
      expectDirMode(sessionsPath);
    });
  });

  // ── heartbeat store ───────────────────────────────────────────────

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

      // Re-saving (update path) must keep the file 0o600.
      const list = await store.list();
      await store.markRun(list[0].id, new Date().toISOString());
      expectFileMode(storePath);
    });
  });

  // ── audit log ────────────────────────────────────────────────────

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

  // ── heartbeat markdown sync ──────────────────────────────────────

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

  // ── workspace bootstrap ──────────────────────────────────────────

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

  // ── onboarding store ─────────────────────────────────────────────

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

  // ── profile writer ───────────────────────────────────────────────

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

  // ── profile registry ────────────────────────────────────────────

  describe('ProfileRegistry', () => {
    it('profiles root dir and profiles.json are 0o700 / 0o600', () => {
      const registry = new ProfileRegistry(root);
      // Constructing the registry creates the base dir; an explicit write
      // includes a quarantine-triggerable profiles.json too.
      const profile = registry.createProfile('default', 'chat-1');
      expectDirMode(root);
      expectFileMode(path.join(root, 'profiles.json'));
      expect(profile.profileId).toBe('default');
    });

    it('migrates a legacy workspace with copied files at 0o600', () => {
      const legacy = path.join(root, 'legacy');
      fs.mkdirSync(path.join(legacy, 'medications'), { recursive: true });
      fs.writeFileSync(path.join(legacy, 'USER.md'), 'u', { mode: 0o644 });
      fs.writeFileSync(path.join(legacy, 'medications', 'aspirin.md'), 'm', { mode: 0o644 });

      const registryDir = path.join(root, 'profiles-reg');
      const registry = new ProfileRegistry(registryDir);
      const result = registry.migrateLegacyWorkspace(legacy);

      expect(result.errors).toHaveLength(0);
      expect(result.migrated).toBeGreaterThan(0);
      const targetDir = path.join(registryDir, 'profiles', 'default');
      expectFileMode(path.join(targetDir, 'USER.md'));
      expectFileMode(path.join(targetDir, 'medications', 'aspirin.md'));
      expectDirMode(targetDir);
    });

    it('deleteProfile moves the subtree to .trash with tightened modes', () => {
      const registryDir = path.join(root, 'profiles-del');
      const registry = new ProfileRegistry(registryDir);
      const profile = registry.createProfile('alice', 'chat-2');
      const profileDir = registry.profileDir(profile.profileId);
      // Populate the profile dir with PHI artifacts (mkdir parents since the
      // dir is only path-derived until the daemon's memory/session mkdir it).
      fs.mkdirSync(path.join(profileDir, 'medications'), { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'medications', 'lisinopril.md'), 'm', { mode: 0o644 });
      fs.writeFileSync(path.join(profileDir, 'HEALTH_PROFILE.md'), 'h', { mode: 0o644 });

      registry.deleteProfile(profile.profileId);

      expect(fs.existsSync(profileDir)).toBe(false);
      const trashDir = path.join(registryDir, 'profiles', '.trash');
      expectDirMode(trashDir);
      const trashed = listFiles(trashDir);
      expect(trashed.length).toBeGreaterThan(0);
      for (const f of trashed) {
        expectFileMode(f);
      }
      // trashed directories are 0o700
      const trashRoots = fs.readdirSync(trashDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());
      for (const e of trashRoots) {
        expectDirMode(path.join(trashDir, e.name));
      }
    });
  });

  // ── config (secrets-bearing parent dir) ─────────────────────────

  describe('saveConfig', () => {
    it('creates the config parent dir at 0o700 and file at 0o600', async () => {
      const configPath = path.join(root, '.redacted', 'config.json');
      const config = cloneDefaultConfig();
      await saveConfig(configPath, config);
      expectDirMode(path.join(root, '.redacted'));
      expectFileMode(configPath);
    });
  });

  // ── memcore ledger store ─────────────────────────────────────────

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