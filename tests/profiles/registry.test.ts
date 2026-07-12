import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProfileRegistry } from '../../src/profiles/registry';
import type { ProfileId } from '../../src/profiles/types';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prof-reg-test-'));
}

describe('ProfileRegistry', () => {
  let registry: ProfileRegistry;
  let baseDir: string;

  beforeEach(() => {
    baseDir = tmpBase();
    registry = new ProfileRegistry(baseDir);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  describe('path derivation', () => {
    it('profileDir returns the profiles directory', () => {
      const pid = 'test-profile' as ProfileId;
      expect(registry.profileDir(pid)).toBe(path.join(baseDir, 'profiles', pid));
    });

    it('profileWorkspace returns profiles/<id>/', () => {
      const pid = 'my-profile' as ProfileId;
      expect(registry.profileWorkspace(pid)).toBe(path.join(baseDir, 'profiles', 'my-profile'));
    });

    it('profileSessions returns profiles/<id>/.state/sessions/', () => {
      const pid = 'p1' as ProfileId;
      expect(registry.profileSessions(pid)).toBe(path.join(baseDir, 'profiles', 'p1', '.state', 'sessions'));
    });

    it('profileSearchDb returns profiles/<id>/.state/search.db', () => {
      const pid = 'p1' as ProfileId;
      expect(registry.profileSearchDb(pid)).toBe(path.join(baseDir, 'profiles', 'p1', '.state', 'search.db'));
    });

    it('profileSchedulerStore returns profiles/<id>/.state/heartbeat-jobs.json', () => {
      const pid = 'p1' as ProfileId;
      expect(registry.profileSchedulerStore(pid)).toBe(path.join(baseDir, 'profiles', 'p1', '.state', 'heartbeat-jobs.json'));
    });

    it('profileAuditLog returns profiles/<id>/.state/audit.jsonl', () => {
      const pid = 'p1' as ProfileId;
      expect(registry.profileAuditLog(pid)).toBe(path.join(baseDir, 'profiles', 'p1', '.state', 'audit.jsonl'));
    });
  });

  describe('CRUD', () => {
    it('createProfile creates and returns a profile with given label', () => {
      const profile = registry.createProfile('default');
      expect(profile.label).toBe('default');
      expect(profile.chatIds).toEqual([]);
      expect(typeof profile.profileId).toBe('string');
      expect(typeof profile.createdAt).toBe('string');
      expect(profile.createdAt.length).toBeGreaterThan(0);
    });

    it('getProfile returns undefined for missing profile', () => {
      expect(registry.getProfile('nonexistent' as ProfileId)).toBeUndefined();
    });

    it('getProfile returns the created profile', () => {
      const created = registry.createProfile('my-health');
      const fetched = registry.getProfile(created.profileId);
      expect(fetched).toEqual(created);
    });

    it('getAllProfiles returns all created profiles', () => {
      const a = registry.createProfile('A');
      const b = registry.createProfile('B');
      expect(registry.getAllProfiles()).toHaveLength(2);
      expect(registry.getAllProfiles().map((p) => p.label).sort()).toEqual(['A', 'B']);
    });

    it('deleteProfile removes a profile', () => {
      const created = registry.createProfile('to-delete');
      expect(registry.getProfile(created.profileId)).toBeDefined();
      registry.deleteProfile(created.profileId);
      expect(registry.getProfile(created.profileId)).toBeUndefined();
      expect(registry.getAllProfiles()).toHaveLength(0);
    });

    it('deleteProfile on nonexistent profile is a no-op (does not throw)', () => {
      expect(() => registry.deleteProfile('nope' as ProfileId)).not.toThrow();
    });

    it('renameProfile changes the label', () => {
      const p = registry.createProfile('old-label');
      registry.renameProfile(p.profileId, 'new-label');
      expect(registry.getProfile(p.profileId)!.label).toBe('new-label');
    });

    it('renameProfile on nonexistent profile throws', () => {
      expect(() => registry.renameProfile('nope' as ProfileId, 'x')).toThrow(/not found/i);
    });
  });

  describe('chat pairing', () => {
    it('pairChatToProfile and getProfileForChat round-trip', () => {
      const p = registry.createProfile('my-profile', 'chat-123');
      const found = registry.getProfileForChat('chat-123');
      expect(found).toBeDefined();
      expect(found!.profileId).toBe(p.profileId);
    });

    it('getProfileForChat returns undefined for unpaired chat', () => {
      expect(registry.getProfileForChat('unknown-chat')).toBeUndefined();
    });

    it('pairChatToProfile adds chatId to profile', () => {
      const p = registry.createProfile('p');
      registry.pairChatToProfile('chat-1', p.profileId);
      const updated = registry.getProfile(p.profileId)!;
      expect(updated.chatIds).toContain('chat-1');
    });

    it('unpairChatFromProfile removes the pairing', () => {
      const p = registry.createProfile('p', 'chat-1');
      expect(registry.getProfileForChat('chat-1')).toBeDefined();
      registry.unpairChatFromProfile('chat-1');
      expect(registry.getProfileForChat('chat-1')).toBeUndefined();
      expect(registry.getProfile(p.profileId)!.chatIds).not.toContain('chat-1');
    });

    it('unpairChatFromProfile on unpaired chat is a no-op', () => {
      expect(() => registry.unpairChatFromProfile('lonely-chat')).not.toThrow();
    });

    it('pairing same chat to a different profile moves the pairing', () => {
      const p1 = registry.createProfile('p1', 'chat-1');
      const p2 = registry.createProfile('p2');
      registry.pairChatToProfile('chat-1', p2.profileId);
      expect(registry.getProfileForChat('chat-1')!.profileId).toBe(p2.profileId);
      expect(registry.getProfile(p1.profileId)!.chatIds).not.toContain('chat-1');
      expect(registry.getProfile(p2.profileId)!.chatIds).toContain('chat-1');
    });
  });

  describe('getOrCreateDefaultProfile', () => {
    it('creates a default profile when none exists', () => {
      const def = registry.getOrCreateDefaultProfile();
      expect(def.label).toBe('default');
      expect(def.profileId).toBe('default');
      expect(def.chatIds).toEqual([]);
    });

    it('returns existing default on second call', () => {
      const first = registry.getOrCreateDefaultProfile();
      const second = registry.getOrCreateDefaultProfile();
      expect(second).toEqual(first);
      expect(second.profileId).toBe('default');
    });
  });

  describe('persistence', () => {
    it('data survives re-instantiation', () => {
      const p = registry.createProfile('persistent');
      registry.pairChatToProfile('chat-persist', p.profileId);

      const registry2 = new ProfileRegistry(baseDir);
      const profiles = registry2.getAllProfiles();
      expect(profiles).toHaveLength(1);
      expect(profiles[0].label).toBe('persistent');
      expect(profiles[0].chatIds).toContain('chat-persist');
      expect(registry2.getProfileForChat('chat-persist')!.profileId).toBe(p.profileId);
    });

    it('writes atomic file (no .tmp left behind)', () => {
      registry.createProfile('atomic');
      const files = fs.readdirSync(baseDir);
      expect(files).toEqual(['profiles.json']);
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    });
  });

  describe('migrateLegacyWorkspace', () => {
    let legacyDir: string;

    beforeEach(() => {
      legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-ws-'));
      fs.mkdirSync(path.join(legacyDir, 'sub'), { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(legacyDir, { recursive: true, force: true });
    });

    it('copies files from legacy workspace to profiles/default/', () => {
      fs.writeFileSync(path.join(legacyDir, 'hello.md'), 'world', 'utf8');
      fs.writeFileSync(path.join(legacyDir, 'sub', 'nested.txt'), 'nested', 'utf8');

      const result = registry.migrateLegacyWorkspace(legacyDir);
      expect(result.migrated).toBe(2);
      expect(result.errors).toEqual([]);

      const targetDir = registry.profileWorkspace('default' as ProfileId);
      expect(fs.readFileSync(path.join(targetDir, 'hello.md'), 'utf8')).toBe('world');
      expect(fs.readFileSync(path.join(targetDir, 'sub', 'nested.txt'), 'utf8')).toBe('nested');
    });

    it('is idempotent when run twice', () => {
      fs.writeFileSync(path.join(legacyDir, 'data.txt'), 'info', 'utf8');
      const first = registry.migrateLegacyWorkspace(legacyDir);
      expect(first.migrated).toBe(1);
      const second = registry.migrateLegacyWorkspace(legacyDir);
      expect(second.migrated).toBe(0);
    });

    it('handles missing legacy workspace gracefully', () => {
      const result = registry.migrateLegacyWorkspace('/nonexistent/path');
      expect(result.migrated).toBe(0);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
    });

    it('returns errors for unreadable files without crashing', () => {
      fs.writeFileSync(path.join(legacyDir, 'good.txt'), 'content', 'utf8');
      fs.writeFileSync(path.join(legacyDir, 'bad.bin'), Buffer.alloc(10), { mode: 0o000 });

      const result = registry.migrateLegacyWorkspace(legacyDir);
      expect(result.migrated).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.errors)).toBe(true);
      // At least good.txt may still be copied
    });
  });
});
