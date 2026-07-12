import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import type { ProfileId, ProfileMeta } from './types';

interface RegistryData {
  profiles: ProfileMeta[];
}

export class ProfileRegistry {
  private readonly filePath: string;
  private cache: { data: RegistryData | null; mtimeMs: number } = { data: null, mtimeMs: 0 };

  constructor(private readonly baseDir: string) {
    this.filePath = path.join(baseDir, 'profiles.json');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  // ── Validation ────────────────────────────────────────────────────

  private validateProfileId(id: string): asserts id is ProfileId {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`Invalid profileId: must be a non-empty string`);
    }
    if (id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw new Error(`Invalid profileId: must not contain "..", "/", or "\\"`);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new Error(`Invalid profileId: must match /^[a-z0-9][a-z0-9-]{0,63}$/`);
    }
  }

  // ── Path derivation ──────────────────────────────────────────────

  profileDir(profileId: ProfileId): string {
    this.validateProfileId(profileId);
    return path.join(this.baseDir, 'profiles', profileId);
  }

  profileWorkspace(profileId: ProfileId): string {
    this.validateProfileId(profileId);
    return this.profileDir(profileId);
  }

  profileSessions(profileId: ProfileId): string {
    this.validateProfileId(profileId);
    return path.join(this.profileDir(profileId), '.state', 'sessions');
  }

  profileSearchDb(profileId: ProfileId): string {
    this.validateProfileId(profileId);
    return path.join(this.profileDir(profileId), '.state', 'search.db');
  }

  profileSchedulerStore(profileId: ProfileId): string {
    this.validateProfileId(profileId);
    return path.join(this.profileDir(profileId), '.state', 'heartbeat-jobs.json');
  }

  profileAuditLog(profileId: ProfileId): string {
    this.validateProfileId(profileId);
    return path.join(this.profileDir(profileId), '.state', 'audit.jsonl');
  }

  // ── Registry CRUD ────────────────────────────────────────────────

  getAllProfiles(): ProfileMeta[] {
    return [...this.readData().profiles];
  }

  getProfile(profileId: ProfileId): ProfileMeta | undefined {
    this.validateProfileId(profileId);
    return this.readData().profiles.find((p) => p.profileId === profileId);
  }

  createProfile(label: string, chatId?: string): ProfileMeta {
    const data = this.readData();
    const profileId = this.nextProfileId(label, data.profiles);
    const now = new Date().toISOString();
    const profile: ProfileMeta = {
      profileId,
      createdAt: now,
      label,
      chatIds: chatId ? [chatId] : [],
    };
    data.profiles.push(profile);
    this.writeData(data);
    return profile;
  }

  deleteProfile(profileId: ProfileId): void {
    this.validateProfileId(profileId);
    const data = this.readData();
    const before = data.profiles.length;
    data.profiles = data.profiles.filter((p) => p.profileId !== profileId);
    if (data.profiles.length < before) {
      this.writeData(data);
      const profileDir = this.profileDir(profileId);
      if (fs.existsSync(profileDir)) {
        try {
          const trashDir = path.join(this.baseDir, 'profiles', '.trash');
          fs.mkdirSync(trashDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const trashPath = path.join(trashDir, `${profileId}-${stamp}`);
          fs.renameSync(profileDir, trashPath);
        } catch (err) {
          console.error(`[profiles] Failed to move ${profileId} to .trash:`, err);
        }
      }
    }
  }

  renameProfile(profileId: ProfileId, newLabel: string): void {
    this.validateProfileId(profileId);
    if (!newLabel || newLabel.trim().length === 0) {
      throw new Error('Label must not be empty or whitespace-only');
    }
    if (newLabel.length > 64) {
      throw new Error('Label must be at most 64 characters');
    }
    const data = this.readData();
    const profile = data.profiles.find((p) => p.profileId === profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }
    profile.label = newLabel;
    this.writeData(data);
  }

  // ── Chat pairing ─────────────────────────────────────────────────

  getProfileForChat(chatId: string): ProfileMeta | undefined {
    return this.readData().profiles.find((p) => p.chatIds.includes(chatId));
  }

  pairChatToProfile(chatId: string, profileId: ProfileId): void {
    this.validateProfileId(profileId);
    const data = this.readData();
    const profile = data.profiles.find((p) => p.profileId === profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }
    for (const other of data.profiles) {
      const idx = other.chatIds.indexOf(chatId);
      if (idx >= 0 && other.profileId !== profileId) {
        other.chatIds.splice(idx, 1);
      }
    }
    if (!profile.chatIds.includes(chatId)) {
      profile.chatIds.push(chatId);
    }
    this.writeData(data);
  }

  unpairChatFromProfile(chatId: string): void {
    const data = this.readData();
    let changed = false;
    for (const profile of data.profiles) {
      const idx = profile.chatIds.indexOf(chatId);
      if (idx >= 0) {
        profile.chatIds.splice(idx, 1);
        changed = true;
      }
    }
    if (changed) {
      this.writeData(data);
    }
  }

  // ── Default profile ──────────────────────────────────────────────

  getOrCreateDefaultProfile(): ProfileMeta {
    const existing = this.getProfile('default' as ProfileId);
    if (existing) return existing;
    return this.createProfile('default');
  }

  // ── Migration ────────────────────────────────────────────────────

  migrateLegacyWorkspace(legacyWorkspace: string): { migrated: number; errors: string[] } {
    const errors: string[] = [];
    let migrated = 0;

    if (!fs.existsSync(legacyWorkspace)) {
      errors.push(`Legacy workspace does not exist: ${legacyWorkspace}`);
      return { migrated: 0, errors };
    }

    const defaultProfile = this.getOrCreateDefaultProfile();
    const targetDir = this.profileWorkspace(defaultProfile.profileId);

    try {
      this.copyDirSync(legacyWorkspace, targetDir, (srcRel: string, srcAbs: string) => {
        const dest = path.join(targetDir, srcRel);
        if (fs.existsSync(dest)) {
          return false;
        }
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(srcAbs, dest);
          migrated++;
          return true;
        } catch (err) {
          errors.push(`Failed to copy ${srcRel}: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      });
    } catch (err) {
      errors.push(`Failed to scan legacy workspace: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (errors.length === 0 && migrated > 0) {
      const sentinel = this.writeMigrationSentinel(defaultProfile.profileId, legacyWorkspace);
      if (sentinel) {
        console.log(`[profiles] Migration sentinel written: ${sentinel}`);
      }
    }

    return { migrated, errors };
  }

  hasBeenMigrated(profileId: ProfileId, legacyWorkspace: string): boolean {
    this.validateProfileId(profileId);
    const profileDir = this.profileDir(profileId);
    const hash = this.sha256Prefix(legacyWorkspace, 12);
    const sentinelPath = path.join(profileDir, `.migrated-from-${hash}`);
    return fs.existsSync(sentinelPath);
  }

  // ── Private helpers ──────────────────────────────────────────────

  private nextProfileId(label: string, existing: ProfileMeta[]): ProfileId {
    const slug = label.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const base = slug || 'profile';
    if (!existing.some((p) => p.profileId === base)) {
      return base as ProfileId;
    }
    return `${base}-${randomUUID().slice(0, 8)}` as ProfileId;
  }

  private readData(): RegistryData {
    if (!fs.existsSync(this.filePath)) {
      this.cache = { data: null, mtimeMs: 0 };
      return { profiles: [] };
    }

    const stat = fs.statSync(this.filePath);
    const cached = this.cache;
    if (cached.data !== null && stat.mtimeMs === cached.mtimeMs) {
      return cached.data;
    }

    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (raw.length === 0) {
      const empty: RegistryData = { profiles: [] };
      this.cache = { data: empty, mtimeMs: stat.mtimeMs };
      return empty;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.profiles)) {
        const data = parsed as RegistryData;
        this.cache = { data, mtimeMs: stat.mtimeMs };
        return data;
      }
      console.error(`[profiles] Corrupt profiles.json — invalid shape, quarantining`);
    } catch {
      console.error(`[profiles] Corrupt profiles.json — JSON parse error, quarantining`);
    }

    // Quarantine
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantinedPath = `${this.filePath}.corrupt-${stamp}`;
    try {
      fs.renameSync(this.filePath, quarantinedPath);
    } catch (qerr) {
      console.error(`[profiles] Failed to quarantine corrupt file:`, qerr);
    }
    this.cache = { data: { profiles: [] }, mtimeMs: 0 };
    return { profiles: [] };
  }

  private writeData(data: RegistryData): void {
    const tmpPath = `${this.filePath}.tmp`;
    const tmpFd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(tmpFd, JSON.stringify(data, null, 2));
      fs.fsyncSync(tmpFd);
    } finally {
      fs.closeSync(tmpFd);
    }
    fs.renameSync(tmpPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
    this.invalidateCache();
  }

  private writeMigrationSentinel(profileId: ProfileId, legacyWorkspace: string): string | null {
    const hash = this.sha256Prefix(legacyWorkspace, 12);
    const sentinelPath = path.join(this.profileDir(profileId), `.migrated-from-${hash}`);
    try {
      fs.writeFileSync(sentinelPath, '', 'utf8');
      return sentinelPath;
    } catch (err) {
      console.error(`[profiles] Failed to write migration sentinel:`, err);
      return null;
    }
  }

  private sha256Prefix(input: string, len: number): string {
    return createHash('sha256').update(input).digest('hex').slice(0, len);
  }

  private invalidateCache(): void {
    this.cache = { data: null, mtimeMs: 0 };
  }

  private copyDirSync(
    src: string,
    dest: string,
    onFile: (relative: string, absolute: string) => boolean,
    prefix: string = '',
  ): void {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcAbs = path.join(src, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        this.copyDirSync(srcAbs, dest, onFile, rel);
      } else if (entry.isFile()) {
        onFile(rel, srcAbs);
      }
    }
  }
}
