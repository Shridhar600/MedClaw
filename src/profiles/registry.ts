import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ProfileId, ProfileMeta } from './types';

interface RegistryData {
  profiles: ProfileMeta[];
}

export class ProfileRegistry {
  private readonly filePath: string;

  constructor(private readonly baseDir: string) {
    this.filePath = path.join(baseDir, 'profiles.json');
  }

  // ── Path derivation ──────────────────────────────────────────────

  profileDir(profileId: ProfileId): string {
    return path.join(this.baseDir, 'profiles', profileId);
  }

  profileWorkspace(profileId: ProfileId): string {
    return this.profileDir(profileId);
  }

  profileSessions(profileId: ProfileId): string {
    return path.join(this.profileDir(profileId), '.state', 'sessions');
  }

  profileSearchDb(profileId: ProfileId): string {
    return path.join(this.profileDir(profileId), '.state', 'search.db');
  }

  profileSchedulerStore(profileId: ProfileId): string {
    return path.join(this.profileDir(profileId), '.state', 'heartbeat-jobs.json');
  }

  profileAuditLog(profileId: ProfileId): string {
    return path.join(this.profileDir(profileId), '.state', 'audit.jsonl');
  }

  // ── Registry CRUD ────────────────────────────────────────────────

  getAllProfiles(): ProfileMeta[] {
    return this.readData().profiles;
  }

  getProfile(profileId: ProfileId): ProfileMeta | undefined {
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
    const data = this.readData();
    const before = data.profiles.length;
    data.profiles = data.profiles.filter((p) => p.profileId !== profileId);
    if (data.profiles.length < before) {
      this.writeData(data);
    }
  }

  renameProfile(profileId: ProfileId, newLabel: string): void {
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

    return { migrated, errors };
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
      return { profiles: [] };
    }
    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (raw.length === 0) {
      return { profiles: [] };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.profiles)) {
        return parsed as RegistryData;
      }
      return { profiles: [] };
    } catch {
      return { profiles: [] };
    }
  }

  private writeData(data: RegistryData): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
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
