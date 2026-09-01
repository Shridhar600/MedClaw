import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
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

  describe('validateProfileId', () => {
    const badIds = ['../evil', 'a/b', 'a\\b', '..', '', 'UPPERCASE', 'has space', '-leading'];

    const standaloneMethods: ((id: ProfileId) => unknown)[] = [
      (id) => registry.profileDir(id),
      (id) => registry.profileWorkspace(id),
      (id) => registry.profileSessions(id),
      (id) => registry.profileSearchDb(id),
      (id) => registry.profileSchedulerStore(id),
      (id) => registry.profileAuditLog(id),
      (id) => registry.getProfile(id),
      (id) => registry.deleteProfile(id),
    ];

    const methodsWithExistingProfile: ((id: ProfileId) => unknown)[] = [
      (id) => registry.renameProfile(id, 'new-label'),
      (id) => registry.pairChatToProfile('chat', id),
    ];

    for (const bad of badIds) {
      for (const method of standaloneMethods) {
        it(`rejects "${bad}" from method`, () => {
          expect(() => method(bad as ProfileId)).toThrow(/Invalid profileId/);
        });
      }
    }

    for (const bad of badIds) {
      for (const method of methodsWithExistingProfile) {
        it(`rejects "${bad}" from rename/pair method`, () => {
          registry.createProfile('existing-profile');
          expect(() => method(bad as ProfileId)).toThrow(/Invalid profileId/);
        });
      }
    }

    it('accepts valid profileId "my-profile-1" and "trailing-"', () => {
      expect(() => registry.profileDir('my-profile-1' as ProfileId)).not.toThrow();
      expect(() => registry.profileDir('trailing-' as ProfileId)).not.toThrow();
    });
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
      registry.createProfile('A');
      registry.createProfile('B');
      expect(registry.getAllProfiles()).toHaveLength(2);
      expect(registry.getAllProfiles().map((p) => p.label).sort()).toEqual(['A', 'B']);
    });

    it('getAllProfiles returns a copy not live reference', () => {
      registry.createProfile('P');
      const arr = registry.getAllProfiles();
      arr.push({ profileId: 'fake' as ProfileId, createdAt: '', label: 'fake', chatIds: [] });
      expect(registry.getAllProfiles()).toHaveLength(1);
    });

    it('deleteProfile removes a profile', () => {
      const created = registry.createProfile('to-delete');
      expect(registry.getProfile(created.profileId)).toBeDefined();
      registry.deleteProfile(created.profileId);
      expect(registry.getProfile(created.profileId)).toBeUndefined();
      expect(registry.getAllProfiles()).toHaveLength(0);
    });

    it('deleteProfile on nonexistent profile is a no-op (does not throw)', () => {
      expect(() => registry.deleteProfile('valid-but-nonexistent' as ProfileId)).not.toThrow();
    });

    it('renameProfile changes the label', () => {
      const p = registry.createProfile('old-label');
      registry.renameProfile(p.profileId, 'new-label');
      expect(registry.getProfile(p.profileId)!.label).toBe('new-label');
    });

    it('renameProfile on nonexistent profile throws', () => {
      expect(() => registry.renameProfile('valid-but-nonexistent' as ProfileId, 'x')).toThrow(/not found/i);
    });
  });

  describe('renameProfile validation', () => {
    it('rejects empty label', () => {
      const p = registry.createProfile('test');
      expect(() => registry.renameProfile(p.profileId, '')).toThrow(/empty/);
    });

    it('rejects whitespace-only label', () => {
      const p = registry.createProfile('test');
      expect(() => registry.renameProfile(p.profileId, '   ')).toThrow(/empty/);
    });

    it('rejects label over 64 chars', () => {
      const p = registry.createProfile('test');
      expect(() => registry.renameProfile(p.profileId, 'a'.repeat(65))).toThrow(/64/);
    });
  });

  describe('deleteProfile soft-delete', () => {
    it('moves profile directory to .trash', () => {
      const p = registry.createProfile('softy');
      const profileDir = registry.profileDir(p.profileId);
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, 'data.txt'), 'health data', 'utf8');

      registry.deleteProfile(p.profileId);
      expect(registry.getProfile(p.profileId)).toBeUndefined();
      expect(fs.existsSync(profileDir)).toBe(false);

      const trashDir = path.join(baseDir, 'profiles', '.trash');
      const trashContents = fs.readdirSync(trashDir);
      expect(trashContents.length).toBeGreaterThan(0);
      const trashItem = trashContents.find((f) => f.startsWith('softy-'));
      expect(trashItem).toBeDefined();

      const trashFile = path.join(trashDir, trashItem!, 'data.txt');
      expect(fs.existsSync(trashFile)).toBe(true);
      expect(fs.readFileSync(trashFile, 'utf8')).toBe('health data');
    });

    it('does not crash when profile directory does not exist', () => {
      const p = registry.createProfile('nodir');
      expect(() => registry.deleteProfile(p.profileId)).not.toThrow();
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

  describe('file permissions', () => {
    it('profiles.json mode is 0o600 after write', () => {
      if (process.platform === 'win32') return;
      registry.createProfile('perm-test');
      const stat = fs.statSync(path.join(baseDir, 'profiles.json'));
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('corruption handling', () => {
    it('corrupt profiles.json is quarantined not silently erased', () => {
      const corruptJson = '{not valid json!!';
      fs.writeFileSync(path.join(baseDir, 'profiles.json'), corruptJson, 'utf8');

      const r2 = new ProfileRegistry(baseDir);
      const profiles = r2.getAllProfiles();
      expect(profiles).toEqual([]);

      const files = fs.readdirSync(baseDir);
      const corruptFiles = files.filter((f) => f.startsWith('profiles.json.corrupt-'));
      expect(corruptFiles.length).toBe(1);
    });

    it('corrupt profiles.json with invalid shape is quarantined', () => {
      fs.writeFileSync(path.join(baseDir, 'profiles.json'), JSON.stringify({ notProfiles: true }), 'utf8');

      const r2 = new ProfileRegistry(baseDir);
      const profiles = r2.getAllProfiles();
      expect(profiles).toEqual([]);

      const files = fs.readdirSync(baseDir);
      const corruptFiles = files.filter((f) => f.startsWith('profiles.json.corrupt-'));
      expect(corruptFiles.length).toBe(1);
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
      // CORR-B1: the sentinel must be present after the second run even though
      // nothing was copied this run (migrated===0). Previously the stuck-on-
      // legacy-forever bug hid here — the test only checked migrated===0.
      expect(second.errors).toEqual([]);
      expect(registry.hasBeenMigrated('default' as ProfileId, legacyDir)).toBe(true);
    });

    it('does not trust a torn migration sentinel', () => {
      fs.writeFileSync(path.join(legacyDir, 'data.txt'), 'info', 'utf8');
      const profile = registry.getOrCreateDefaultProfile();
      const hash = createHash('sha256').update(legacyDir).digest('hex').slice(0, 12);
      const sentinel = path.join(registry.profileDir(profile.profileId), `.migrated-from-${hash}`);
      fs.mkdirSync(path.dirname(sentinel), { recursive: true });
      fs.writeFileSync(sentinel, '{"version":1');

      expect(registry.hasBeenMigrated(profile.profileId, legacyDir)).toBe(false);
      const result = registry.migrateLegacyWorkspace(legacyDir);

      expect(result.errors).toEqual([]);
      expect(JSON.parse(fs.readFileSync(sentinel, 'utf8'))).toMatchObject({
        version: 1,
        completed: true,
      });
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
    });
  });

  describe('migration sentinel', () => {
    it('writes sentinel and hasBeenMigrated returns true', () => {
      const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-ws-'));
      try {
        fs.writeFileSync(path.join(legacyDir, 'note.md'), 'hello', 'utf8');
        const result = registry.migrateLegacyWorkspace(legacyDir);
        expect(result.migrated).toBe(1);
        expect(result.errors).toEqual([]);

        expect(registry.hasBeenMigrated('default' as ProfileId, legacyDir)).toBe(true);
      } finally {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      }
    });

    it('hasBeenMigrated returns false for unmigrated workspace', () => {
      const unmigrated = '/tmp/nonexistent-sentinel-test';
      expect(registry.hasBeenMigrated('default' as ProfileId, unmigrated)).toBe(false);
    });

    it('validates profileId in hasBeenMigrated', () => {
      expect(() => registry.hasBeenMigrated('../evil' as ProfileId, '/tmp/x')).toThrow(/Invalid profileId/);
    });
  });

  // ── CORR-B1 regression: verify-then-seal ──────────────────────────────
  describe('CORR-B1 verify-then-seal', () => {
    it('boot 1 sentinel write fails → boot 2 writes sentinel and hasBeenMigrated() === true', () => {
      const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-fail-'));
      try {
        fs.writeFileSync(path.join(legacyDir, 'hello.md'), 'world', 'utf8');
        jest.spyOn(console, 'log').mockImplementation(() => undefined);

        // Mock the private sentinel writer to fail once (boot 1), then fall
        // back to the real implementation (boot 2).
        const sentinelSpy = jest
          .spyOn(ProfileRegistry.prototype as unknown as {
            writeMigrationSentinel: (p: ProfileId, lw: string) => string | null;
          }, 'writeMigrationSentinel')
          .mockReturnValueOnce(null);

        // Boot 1: full copy succeeds but the sentinel write fails.
        const first = registry.migrateLegacyWorkspace(legacyDir);
        expect(first.migrated).toBe(1);
        expect(first.errors.length).toBe(1);
        expect(first.errors[0]).toContain('sentinel');
        expect(registry.hasBeenMigrated('default' as ProfileId, legacyDir)).toBe(false);

        sentinelSpy.mockRestore();

        // Boot 2: every file already exists (skipped, migrated===0). With the
        // old code the sentinel would never be re-attempted. Verify-then-seal
        // must re-run and seal so the daemon escapes the legacy workspace.
        const second = registry.migrateLegacyWorkspace(legacyDir);
        expect(second.migrated).toBe(0);
        expect(second.errors).toEqual([]);
        expect(registry.hasBeenMigrated('default' as ProfileId, legacyDir)).toBe(true);
      } finally {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      }
    });

    it('truncated dest (short file at dest before migration) → re-copied with correct content + sentinel written', () => {
      const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trunc-dest-'));
      try {
        // Source file is 5 bytes.
        fs.writeFileSync(path.join(legacyDir, 'hello.md'), 'world', 'utf8');
        const targetDir = registry.profileWorkspace('default' as ProfileId);
        fs.mkdirSync(targetDir, { recursive: true });
        // Pre-create a truncated (2-byte) dest simulating a partial copyFileSync
        // that ENOSPC'd mid-write in a prior boot.
        const destPath = path.join(targetDir, 'hello.md');
        fs.writeFileSync(destPath, 'wo', 'utf8');

        jest.spyOn(console, 'log').mockImplementation(() => undefined);

        const result = registry.migrateLegacyWorkspace(legacyDir);
        expect(result.errors).toEqual([]);

        // The truncated dest must have been detected (size mismatch) and
        // re-copied with the correct full content.
        expect(fs.readFileSync(destPath, 'utf8')).toBe('world');
        expect(fs.statSync(destPath).size).toBe(5);

        // A fresh registry instance confirms disk state: all skipped now, and
        // the sentinel is present.
        expect(registry.hasBeenMigrated('default' as ProfileId, legacyDir)).toBe(true);
        const registry2 = new ProfileRegistry(baseDir);
        expect(registry2.hasBeenMigrated('default' as ProfileId, legacyDir)).toBe(true);
      } finally {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      }
    });
  });
});
