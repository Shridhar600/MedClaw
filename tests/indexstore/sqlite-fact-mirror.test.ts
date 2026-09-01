import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { SqliteFactMirror } from '../../src/indexstore';
import { runFactMirrorContract } from '../ports/fact-mirror.contract';
import type { FactRecord } from '../../src/ports';

const tmpDirs: string[] = [];

// Each mirror gets its own isolated temp search.db (its own better-sqlite3 connection —
// the mirror layer co-owns search.db with the vec/keyword adapters, D6). NEVER ~/.redacted.
runFactMirrorContract(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-factmirror-'));
  tmpDirs.push(dir);
  return new SqliteFactMirror({ dbPath: path.join(dir, 'search.db') });
});

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function collect(iterable: AsyncIterable<FactRecord>): Promise<FactRecord[]> {
  const rows: FactRecord[] = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

function record(over: Partial<FactRecord> = {}): FactRecord {
  return {
    id: 'penicillin@v1',
    profileId: 'default',
    entity: 'penicillin',
    type: 'medication',
    version: 1,
    status: 'active',
    fields: { dose: '500mg' },
    safetyRelevant: true,
    authority: 'user',
    confidence: 0.9,
    createdAt: '2026-08-20T00:00:00.000Z',
    ...over,
  };
}

function makeDirectMirror(): SqliteFactMirror {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-factmirror-rr5-'));
  tmpDirs.push(dir);
  return new SqliteFactMirror({ dbPath: path.join(dir, 'search.db') });
}

describe('SqliteFactMirror RR-5 projection correctness', () => {
  it('keeps same-named medication and allergy facts as separate active heads', async () => {
    const mirror = makeDirectMirror();
    await mirror.upsert([
      record({ id: 'penicillin@v1', type: 'medication', fields: { dose: '500mg' } }),
      record({ id: 'penicillin@v1', type: 'allergy', fields: { reaction: 'anaphylaxis' } }),
    ]);

    const active = await collect(mirror.queryActive());
    const heads = await collect(mirror.queryEntityHeads());

    expect(active.map(f => `${f.type}:${f.entity}`)).toEqual(
      expect.arrayContaining(['medication:penicillin', 'allergy:penicillin']),
    );
    expect(heads.map(f => `${f.type}:${f.entity}`)).toEqual(
      expect.arrayContaining(['medication:penicillin', 'allergy:penicillin']),
    );
    mirror.close();
  });

  it('prefers an active lifecycle winner over a higher superseded version', async () => {
    const mirror = makeDirectMirror();
    await mirror.upsert([
      record({ id: 'metformin@v2', entity: 'metformin', version: 2, status: 'active' }),
      record({ id: 'metformin@v3', entity: 'metformin', version: 3, status: 'superseded' }),
    ]);

    const heads = await collect(mirror.queryEntityHeads());
    expect(heads).toHaveLength(1);
    expect(heads[0]).toMatchObject({ entity: 'metformin', version: 2, status: 'active' });
    mirror.close();
  });

  it('replaces a type scope so facts removed from the source disappear immediately', async () => {
    const mirror = makeDirectMirror();
    const stale = record({ id: 'lisinopril@v1', entity: 'lisinopril' });
    const keep = record({ id: 'metformin@v1', entity: 'metformin' });
    await mirror.upsert([stale, keep]);

    const replaceType = (mirror as unknown as {
      replaceType(type: string, facts: FactRecord[]): Promise<void>;
    }).replaceType.bind(mirror);
    await replaceType('medication', [keep]);

    const active = await collect(mirror.queryActive('medication'));
    expect(active.map(f => f.entity)).toEqual(['metformin']);
    mirror.close();
  });
});
