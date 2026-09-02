import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SqliteFactMirror } from '../../src/indexstore';
import { headWins } from '../../src/indexstore/adapters/sqlite-fact-mirror';
import type { FactRecord } from '../../src/ports';

const tmpDirs: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function record(overrides: Partial<FactRecord>): FactRecord {
  return {
    id: 'fact-1',
    profileId: 'default',
    entity: 'entity-1',
    type: 'medication',
    version: 1,
    status: 'superseded',
    fields: { dose: '500mg' },
    safetyRelevant: true,
    authority: 'user',
    confidence: 0.9,
    createdAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<FactRecord>): Promise<FactRecord[]> {
  const rows: FactRecord[] = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

describe('RR-9a C-36 bounded entity-head reads', () => {
  it('returns the legacy head set while parsing only one row per type/entity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9a-heads-'));
    tmpDirs.push(dir);
    const mirror = new SqliteFactMirror({ dbPath: path.join(dir, 'search.db') });
    const facts: FactRecord[] = [];
    for (const type of ['medication', 'condition', 'allergy']) {
      for (let entityIndex = 0; entityIndex < 12; entityIndex++) {
        for (let version = 1; version <= 30; version++) {
          facts.push(record({
            id: `${type}-${entityIndex}-${version}`,
            type,
            entity: `entity-${entityIndex}`,
            version,
            status: version % 11 === 0 ? 'active' : 'superseded',
            createdAt: `2026-08-${String((version % 20) + 1).padStart(2, '0')}T00:00:00.000Z`,
          }));
        }
        facts.push(record({
          id: `${type}-${entityIndex}-dual-active`,
          type,
          entity: `entity-${entityIndex}`,
          version: 2,
          status: 'active',
          createdAt: '2026-12-31T00:00:00.000Z',
        }));
      }
    }
    await mirror.rebuild(facts);

    const expectedByKey = new Map<string, FactRecord>();
    for (const fact of facts) {
      if (fact.version < 1) continue;
      const key = `${fact.type}::${fact.entity}`;
      if (headWins(fact, expectedByKey.get(key))) expectedByKey.set(key, fact);
    }

    const parse = jest.spyOn(JSON, 'parse');
    const actual = await collect(mirror.queryEntityHeads());
    const parseCount = parse.mock.calls.length;
    parse.mockRestore();
    mirror.close();

    const actualByKey = new Map(actual.map((fact) => [`${fact.type}::${fact.entity}`, fact]));
    expect(actualByKey).toEqual(expectedByKey);
    expect(parseCount).toBe(expectedByKey.size);
  });
});
