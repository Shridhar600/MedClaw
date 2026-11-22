import { scoreChunk } from '../../src/recall/scoring';

describe('scoreChunk', () => {
  test('zero age applies no decay; 0.7/0.3 cos/bm25 weighting', () => {
    const s = scoreChunk({
      cosine: 0.8,
      bm25n: 0.4,
      ageDays: 0,
      halfLifeDays: 120,
      authorityRank: 2,
      safetyRelevant: false,
    });
    expect(s.raw).toBeCloseTo(0.68, 6);
    expect(s.ranking).toBeCloseTo(0.816, 6);
  });

  test('recency decay lowers raw for older chunks', () => {
    const fresh = scoreChunk({
      cosine: 0.8, bm25n: 0.4, ageDays: 0, halfLifeDays: 120, authorityRank: 2, safetyRelevant: false,
    });
    const stale = scoreChunk({
      cosine: 0.8, bm25n: 0.4, ageDays: 60, halfLifeDays: 120, authorityRank: 2, safetyRelevant: false,
    });
    expect(stale.raw).toBeCloseTo(0.4124408486, 9);
    expect(stale.ranking).toBeCloseTo(0.4949290183, 9);
    expect(stale.raw).toBeLessThan(fresh.raw); // older ranks lower
  });

  test('safety_relevant chunks are exempt from time-decay (decay=1) at any age', () => {
    const s = scoreChunk({
      cosine: 0.8, bm25n: 0.4, ageDays: 3650, halfLifeDays: 120, authorityRank: 5, safetyRelevant: true,
    });
    // decay forced to 1 → raw stays 0.68 (≥ 0.3 safety threshold regardless of age); ranking=0.68·1.5=1.02
    expect(s.raw).toBeCloseTo(0.68, 6);
    expect(s.ranking).toBeCloseTo(1.02, 6);
  });

  test('threshold is on raw; authority boost affects ranking only', () => {
    const s = scoreChunk({
      cosine: 0.4, bm25n: 0.4, ageDays: 0, halfLifeDays: 120, authorityRank: 5, safetyRelevant: false,
    });
    expect(s.raw).toBeCloseTo(0.4, 6);
    expect(s.ranking).toBeCloseTo(0.6, 6);
    expect(s.raw).toBeLessThan(0.5);
    expect(s.ranking).toBeGreaterThan(0.5);
  });

  test('a high-authority low-relevance chunk still outranks a peer with no authority (ordering)', () => {
    const hiAuthLoRel = scoreChunk({
      cosine: 0.4, bm25n: 0.4, ageDays: 0, halfLifeDays: 120, authorityRank: 5, safetyRelevant: false,
    });
    const loAuthHiRel = scoreChunk({
      cosine: 0.45, bm25n: 0.45, ageDays: 0, halfLifeDays: 120, authorityRank: 0, safetyRelevant: false,
    });
    expect(hiAuthLoRel.raw).toBeLessThan(loAuthHiRel.raw);
    expect(hiAuthLoRel.ranking).toBeGreaterThan(loAuthHiRel.ranking);
  });

  test('authorityRank 0 leaves ranking equal to raw', () => {
    const s = scoreChunk({
      cosine: 1.0, bm25n: 0.0, ageDays: 0, halfLifeDays: 120, authorityRank: 0, safetyRelevant: false,
    });
    expect(s.raw).toBeCloseTo(0.7, 6);
    expect(s.ranking).toBeCloseTo(0.7, 6);
  });

  test('bm25-only chunk scores by the 0.3 weight', () => {
    const s = scoreChunk({
      cosine: 0.0, bm25n: 1.0, ageDays: 0, halfLifeDays: 120, authorityRank: 0, safetyRelevant: false,
    });
    expect(s.raw).toBeCloseTo(0.3, 6);
    expect(s.ranking).toBeCloseTo(0.3, 6);
  });
});
