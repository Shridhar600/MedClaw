
import type { EffectiveConfig } from '../../src/config';
import { asProfileId, resolveOwnerPaths } from '../../src/profiles';

/** Owner ID used by fixtures that do not exercise identity selection. */
export const TEST_OWNER_ID = 'default';

export interface FixtureOwner {
  baseDir: string;
  ownerId: string;
  workspace: string;
  storePath: string;
  auditLogPath: string;
  searchDb: string;
  sessionsDir: string;
  /** Durable enrollment/binding record. Authoritative for admission. */
  ownerRecord: string;
}

export function fixtureOwner(rootDir: string, ownerId: string = TEST_OWNER_ID): FixtureOwner {
  const id = asProfileId(ownerId);
  if (id === undefined) throw new Error(`invalid fixture owner id: ${ownerId}`);
  const paths = resolveOwnerPaths(rootDir, id);
  return {
    baseDir: rootDir,
    ownerId,
    workspace: paths.workspace,
    storePath: paths.schedulerStore,
    auditLogPath: paths.auditLog,
    searchDb: paths.searchDb,
    sessionsDir: paths.sessions,
    ownerRecord: paths.ownerRecord,
  };
}

/** Spread into a configuration literal to declare the selected owner. */
export function ownerSelection(owner: FixtureOwner): Pick<EffectiveConfig, 'profiles'> {
  return { profiles: { baseDir: owner.baseDir, defaultProfileId: owner.ownerId } };
}

/** The three derived owner values the effective configuration carries. */
export function ownerPathsFor(owner: FixtureOwner): {
  workspace: string;
  storePath: string;
  auditLogPath: string;
} {
  return {
    workspace: owner.workspace,
    storePath: owner.storePath,
    auditLogPath: owner.auditLogPath,
  };
}

export function withoutOwnerIdentity(config: EffectiveConfig): EffectiveConfig {
  const copy = { ...config } as Record<string, unknown>;
  delete copy.profiles;
  return copy as unknown as EffectiveConfig;
}
