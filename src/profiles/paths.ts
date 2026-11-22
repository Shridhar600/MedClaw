
import * as path from 'path';
import type { ProfileId } from './types';

/** Owner identity and the canonical, already-resolved base directory. */
export interface OwnerPaths {
  profileId: ProfileId;
  /** `<baseDir>/profiles/<ownerId>` — the owner's Markdown workspace. */
  workspace: string;
  /** Durable enrollment/binding record. Authoritative for admission. */
  ownerRecord: string;
  /** Derived/search backend. A mirror of the Markdown workspace, never the source of truth. */
  searchDb: string;
  /** Per-chat transcript directory. */
  sessions: string;
  /** Scheduled-job store. */
  schedulerStore: string;
  /** JSONL scheduler audit log. */
  auditLog: string;
  /** Owner-scoped incoming media staging. Swept at boot under the workspace lease. */
  mediaStaging: string;
  /** Exclusive local-directory lease for this owner's workspace. */
  workspaceLease: string;
}

/** Owner ID grammar. Shared with the config decoder so both refuse the same identities. */
export const OWNER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Narrow an unvalidated string to `ProfileId`, or `undefined` when it is not a valid owner ID. */
export function asProfileId(value: string): ProfileId | undefined {
  if (!OWNER_ID_PATTERN.test(value)) return undefined;
  return value as ProfileId;
}

export function isValidProfileId(value: string): boolean {
  return OWNER_ID_PATTERN.test(value);
}

function requireAbsoluteNormalized(baseDir: string, ownerId: ProfileId): void {
  if (!path.isAbsolute(baseDir) || path.normalize(baseDir) !== baseDir) {
    throw new Error('resolveOwnerPaths requires an absolute normalized base directory');
  }
  if (!isValidProfileId(ownerId)) {
    throw new Error('resolveOwnerPaths requires a valid owner ID');
  }
}

export function resolveOwnerPaths(canonicalBaseDir: string, ownerId: ProfileId): OwnerPaths {
  requireAbsoluteNormalized(canonicalBaseDir, ownerId);
  const workspace = path.join(canonicalBaseDir, 'profiles', ownerId);
  const stateDir = path.join(workspace, '.state');
  return {
    profileId: ownerId,
    workspace,
    ownerRecord: path.join(stateDir, 'owner-access.json'),
    searchDb: path.join(stateDir, 'search.db'),
    sessions: path.join(stateDir, 'sessions'),
    schedulerStore: path.join(stateDir, 'heartbeat-jobs.json'),
    auditLog: path.join(stateDir, 'audit.jsonl'),
    mediaStaging: path.join(stateDir, 'media-staging'),
    workspaceLease: path.join(stateDir, 'installation.lease'),
  };
}

/** The subset the config layer needs to assemble an effective configuration. */
export function derivedPathsFor(paths: OwnerPaths): {
  workspace: string;
  schedulerStorePath: string;
  auditLogPath: string;
} {
  return {
    workspace: paths.workspace,
    schedulerStorePath: paths.schedulerStore,
    auditLogPath: paths.auditLog,
  };
}
