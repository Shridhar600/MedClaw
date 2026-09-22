import { scoreChunk } from '../../src/recall/scoring';

// P2 Wave B / Task B1 — scoring goldens (specs/13 B5 + v2-BL-1a/1b).
//   decay   = safetyRelevant ? 1 : exp(-ageDays / halfLifeDays)
//   raw     = (0.7·cosine + 0.3·bm25n) · decay
//   ranking = raw · (1 + 0.1·authorityRank)
// Thresholds (0.5/0.3) are applied to `raw`; the authority boost affects `ranking` ONLY (B5).
// Expected values are computed independently (not from the implementation) to 10 dp.

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
    // base = 0.7·0.8 + 0.3·0.4 = 0.68; decay=1; ranking = 0.68·(1+0.2)=0.816
    expect(s.raw).toBeCloseTo(0.68, 6);
    expect(s.ranking).toBeCloseTo(0.816, 6);
  });

  test('recency decay lowers raw for older chunks (CONTRA-11)', () => {
    const fresh = scoreChunk({
      cosine: 0.8, bm25n: 0.4, ageDays: 0, halfLifeDays: 120, authorityRank: 2, safetyRelevant: false,
    });
    const stale = scoreChunk({
      cosine: 0.8, bm25n: 0.4, ageDays: 60, halfLifeDays: 120, authorityRank: 2, safetyRelevant: false,
    });
    // decay(60/120)=e^-0.5=0.6065306597; raw=0.68·0.6065306597=0.4124408486; ranking·1.2=0.4949290183
    expect(stale.raw).toBeCloseTo(0.4124408486, 9);
    expect(stale.ranking).toBeCloseTo(0.4949290183, 9);
    expect(stale.raw).toBeLessThan(fresh.raw); // older ranks lower
  });

  test('safety_relevant chunks are exempt from time-decay (decay=1) at any age (v2-BL-1b)', () => {
    const s = scoreChunk({
      cosine: 0.8, bm25n: 0.4, ageDays: 3650, halfLifeDays: 120, authorityRank: 5, safetyRelevant: true,
    });
    // decay forced to 1 → raw stays 0.68 (≥ 0.3 safety threshold regardless of age); ranking=0.68·1.5=1.02
    expect(s.raw).toBeCloseTo(0.68, 6);
    expect(s.ranking).toBeCloseTo(1.02, 6);
  });

  test('threshold is on raw; authority boost affects ranking only (B5)', () => {
    const s = scoreChunk({
      cosine: 0.4, bm25n: 0.4, ageDays: 0, halfLifeDays: 120, authorityRank: 5, safetyRelevant: false,
    });
    // base = 0.7·0.4 + 0.3·0.4 = 0.40 (below the 0.5 scoreThreshold — boost must NOT rescue it on raw)
    // ranking = 0.40·(1+0.5) = 0.60 (boost lifts ordering above 0.5, but that's ranking, not raw)
    expect(s.raw).toBeCloseTo(0.4, 6);
    expect(s.ranking).toBeCloseTo(0.6, 6);
    expect(s.raw).toBeLessThan(0.5);
    expect(s.ranking).toBeGreaterThan(0.5);
  });

  test('a high-authority low-relevance chunk still outranks a peer with no authority (B5 ordering)', () => {
    const hiAuthLoRel = scoreChunk({
      cosine: 0.4, bm25n: 0.4, ageDays: 0, halfLifeDays: 120, authorityRank: 5, safetyRelevant: false,
    });
    const loAuthHiRel = scoreChunk({
      cosine: 0.45, bm25n: 0.45, ageDays: 0, halfLifeDays: 120, authorityRank: 0, safetyRelevant: false,
    });
    // raw: 0.40 (hi-auth) vs 0.45 (lo-auth) → lo-auth has the higher raw
    expect(hiAuthLoRel.raw).toBeLessThan(loAuthHiRel.raw);
    // ranking: 0.60 (hi-auth boost 1.5) vs 0.45 (no boost) → hi-auth outranks
    expect(hiAuthLoRel.ranking).toBeGreaterThan(loAuthHiRel.ranking);
  });

  test('authorityRank 0 leaves ranking equal to raw', () => {
    const s = scoreChunk({
      cosine: 1.0, bm25n: 0.0, ageDays: 0, halfLifeDays: 120, authorityRank: 0, safetyRelevant: false,
    });
    // base = 0.7·1.0 = 0.7; ranking = 0.7·(1+0) = 0.7
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
