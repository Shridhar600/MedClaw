import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SqliteFactMirror } from '../../src/indexstore';
import type { FactRecord } from '../../src/ports';

async function collect(iterable: AsyncIterable<FactRecord>): Promise<FactRecord[]> {
  const rows: FactRecord[] = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

function fact(overrides: Partial<FactRecord>): FactRecord {
  return {
    id: 'metformin@v1',
    profileId: 'default',
    entity: 'metformin',
    type: 'medication',
    version: 1,
    status: 'active',
    fields: { dose: '500mg' },
    safetyRelevant: true,
    authority: 'user',
    confidence: 1,
    createdAt: '2026-08-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('RR-9b scoped FactMirror replacement', () => {
  it('replaces one type/entity scope and preserves unrelated mirror rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr9b-mirror-'));
    const mirror = new SqliteFactMirror({ dbPath: path.join(dir, 'search.db') });
    try {
      await mirror.upsert([
        fact({ id: 'metformin@v1' }),
        fact({ id: 'lisinopril@v1', entity: 'lisinopril', fields: { dose: '10mg' } }),
        fact({ id: 'metformin@v1', type: 'allergy', fields: { reaction: 'rash' } }),
      ]);

      const replaceScope = (mirror as unknown as {
        replaceScope(type: string, entity: string, facts: FactRecord[]): Promise<void>;
      }).replaceScope.bind(mirror);
      await replaceScope('medication', 'metformin', [
        fact({ id: 'metformin@v2', version: 2, fields: { dose: '850mg' } }),
      ]);

      const rows = await collect(mirror.queryActive());
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'medication', entity: 'metformin', id: 'metformin@v2' }),
        expect.objectContaining({ type: 'medication', entity: 'lisinopril', id: 'lisinopril@v1' }),
        expect.objectContaining({ type: 'allergy', entity: 'metformin', id: 'metformin@v1' }),
      ]));
      expect(rows).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'medication', entity: 'metformin', id: 'metformin@v1' }),
      ]));
    } finally {
      mirror.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
