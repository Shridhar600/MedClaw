// Shared entry fixtures for tests that construct a serving configuration directly.
//
// Two rules make these fixtures coherent under S1:
//
//  1. `EffectiveConfig` requires `schemaVersion` and an explicit `profiles` identity. A
//     configuration without a selected owner must not be constructible, because that is
//     exactly what let a default stand in for an owner.
//
//  2. The identity a fixture declares must be the identity its owner paths were derived
//     from. While the Gateway still resolves the selected owner through the legacy
//     migration path, declaring an identity whose derived workspace differs from the
//     fixture's `memory.workspace` makes boot COPY the workspace into the derived
//     location. The tests would then silently assert against a copy. Deriving both from
//     one call keeps the fixture honest and makes the T5 cutover a deletion rather than a
//     rewrite.
//
// Path derivation itself is proved separately in `tests/config/config.test.ts`.

import type { EffectiveConfig } from '../../src/config';
import { asProfileId, resolveOwnerPaths } from '../../src/profiles';

/** Owner ID used by fixtures that do not exercise identity selection. */
export const TEST_OWNER_ID = 'default';

/**
 * Owner identity plus every path derived from it, rooted at `rootDir`.
 *
 * Pass a per-test temporary directory as `rootDir`; nothing is created on disk by this call.
 */
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

/**
 * A configuration object shaped like a legacy document that carries no owner identity.
 *
 * `EffectiveConfig.profiles` is required, so a test cannot `delete` it directly. This helper
 * expresses the same runtime shape (an object with no `profiles` key) without weakening the
 * type, so a suite that proves the gateway fails closed rather than crashes on a
 * missing-identity configuration keeps its intent. Serving such a document through the
 * decoder is refused outright — see `tests/config/config.test.ts`.
 */
export function withoutOwnerIdentity(config: EffectiveConfig): EffectiveConfig {
  const copy = { ...config } as Record<string, unknown>;
  delete copy.profiles;
  return copy as unknown as EffectiveConfig;
}

// NOTE: `FIXTURE_OWNER_ROOT` / `sharedFixtureOwner()` are DELETED, not relocated.
//
// They pointed every caller at one hard-coded `/tmp/redacted-socs-s1-fixture-owner` directory, which was
// wrong twice over. It was outside the workspace, which the founder rule forbids. And because S1 makes
// admission bind exactly ONE chat per owner record, the first suite to bind a chat there owned it for
// every later caller: `bindOwnerFixture` finds an existing record, issues no challenge, and returns
// without binding, so every subsequent suite's chat was silently refused. That cascade was the single
// largest cause of test failures after admission became mandatory.
//
// Callers now pass their own `makeTestTemp(...)` root to `fixtureOwner(root)`, so each suite owns and
// removes its own owner workspace.
