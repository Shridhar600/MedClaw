
import * as path from 'path';

import {
  OWNER_ID_PATTERN,
  asProfileId,
  isValidProfileId,
  resolveOwnerPaths,
} from '../../src/profiles';
import type { ProfileId } from '../../src/profiles/types';

const BASE = '/Users/someone/.redacted';

describe('owner path derivation', () => {
  const paths = resolveOwnerPaths(BASE, 'my-profile-1' as ProfileId);

  it('derives every owner resource from one base directory and one owner id', () => {
    const ownerDir = path.join(BASE, 'profiles', 'my-profile-1');
    const state = path.join(ownerDir, '.state');

    expect(paths.profileId).toBe('my-profile-1');
    expect(paths.workspace).toBe(ownerDir);
    expect(paths.ownerRecord).toBe(path.join(state, 'owner-access.json'));
    expect(paths.searchDb).toBe(path.join(state, 'search.db'));
    expect(paths.sessions).toBe(path.join(state, 'sessions'));
    expect(paths.schedulerStore).toBe(path.join(state, 'heartbeat-jobs.json'));
    expect(paths.auditLog).toBe(path.join(state, 'audit.jsonl'));
    expect(paths.mediaStaging).toBe(path.join(state, 'media-staging'));
    expect(paths.workspaceLease).toBe(path.join(state, 'installation.lease'));
  });

  it('puts EVERY derived resource inside the owner workspace — containment, not convention', () => {
    const ownerDir = paths.workspace;
    const outside = Object.entries(paths)
      .filter(([name]) => name !== 'profileId' && name !== 'workspace')
      .filter(([, value]) => !value.startsWith(`${ownerDir}${path.sep}`))
      .map(([name, value]) => `${name} -> ${value}`);
    expect(outside).toEqual([]);
  });

  it('gives two owner ids entirely disjoint resource sets', () => {
    const other = resolveOwnerPaths(BASE, 'other-profile' as ProfileId);
    const shared = (Object.keys(paths) as (keyof typeof paths)[])
      .filter((key) => key !== 'profileId' && other[key] === paths[key]);
    expect(shared).toEqual([]);
  });

  it('reads no disk and writes nothing: derivation is pure', () => {
    const again = resolveOwnerPaths(BASE, 'my-profile-1' as ProfileId);
    expect(again).toEqual(paths);
    expect(() => resolveOwnerPaths(BASE, 'default' as ProfileId)).not.toThrow();
  });

  it('refuses a relative or unnormalized base directory rather than guessing', () => {
    expect(() => resolveOwnerPaths('relative/base', 'default' as ProfileId)).toThrow(/absolute normalized/);
    expect(() => resolveOwnerPaths('./base', 'default' as ProfileId)).toThrow(/absolute normalized/);
    expect(() => resolveOwnerPaths(`${BASE}/./x`, 'default' as ProfileId)).toThrow(/absolute normalized/);
    expect(() => resolveOwnerPaths(`${BASE}/x/../y`, 'default' as ProfileId)).toThrow(/absolute normalized/);

    expect(resolveOwnerPaths(`${BASE}/`, 'default' as ProfileId)).toEqual(
      resolveOwnerPaths(BASE, 'default' as ProfileId),
    );
  });
});

describe('owner id grammar', () => {
  const accepted = ['default', 'a', 'my-profile-1', 'trailing-', '0start', 'a'.repeat(64)];
  const rejected = [
    '', 'Upper', '-leading', 'has space', 'has/slash', 'has\\backslash', '..', 'a'.repeat(65),
    'emoji-\u{1F600}', 'dot.dot', 'semi;colon', 'null\u0000byte',
  ];

  it.each(accepted)('accepts %j', (id) => {
    expect(OWNER_ID_PATTERN.test(id)).toBe(true);
    expect(isValidProfileId(id)).toBe(true);
    expect(asProfileId(id)).toBe(id);
  });

  it.each(rejected)('rejects %j', (id) => {
    expect(OWNER_ID_PATTERN.test(id)).toBe(false);
    expect(isValidProfileId(id)).toBe(false);
    expect(asProfileId(id)).toBeUndefined();
  });

  it('refuses traversal sequences outright — the ID is a path segment', () => {
    for (const id of ['..', '../etc', 'a/../../b', '.', './x']) {
      expect(asProfileId(id)).toBeUndefined();
    }
  });

  it('refuses an invalid owner id when deriving paths', () => {
    expect(() => resolveOwnerPaths(BASE, 'Bad Id' as ProfileId)).toThrow(/valid owner ID/);
    expect(() => resolveOwnerPaths(BASE, '../escape' as ProfileId)).toThrow(/valid owner ID/);
  });
});
