import { describe, it, expect } from 'vitest';
import { cosineSimFromL2, l2FromCosineSim } from '../../search/scoring.js';

/**
 * The vec0 table indexes unit-normalized embeddings with the default L2
 * (Euclidean) metric, so the MATCH `distance` is the raw L2 distance d, NOT
 * cosine. For unit vectors ||a-b||^2 = 2 - 2cos, i.e. cos = 1 - d^2/2 and
 * d = sqrt(2(1-cos)). These helpers are the single, exact conversion between the
 * two — replacing the previous linear `1 - d/2` approximation that mis-reported
 * every similarity score and mis-calibrated user-facing thresholds.
 *
 * Values pinned here were measured empirically against sqlite-vec 0.1.7:
 * a true-cosine-0.8 unit-vector pair returns d = 0.632456.
 */
describe('cosineSimFromL2', () => {
  it('maps identical vectors (d=0) to similarity 1', () => {
    expect(cosineSimFromL2(0)).toBeCloseTo(1, 10);
  });

  it('maps a true-cosine-0.8 pair (d=0.632456) to 0.8 — NOT the linear 0.684', () => {
    const d = Math.sqrt(2 * (1 - 0.8)); // 0.632456
    expect(cosineSimFromL2(d)).toBeCloseTo(0.8, 6);
    // Guard against a regression to the old linear `1 - d/2` formula:
    expect(cosineSimFromL2(d)).not.toBeCloseTo(1 - d / 2, 3);
  });

  it('maps a true-cosine-0.5 pair (d=1) to 0.5', () => {
    expect(cosineSimFromL2(1)).toBeCloseTo(0.5, 10);
  });

  it('maps orthogonal vectors (d=sqrt(2)) to 0', () => {
    expect(cosineSimFromL2(Math.SQRT2)).toBeCloseTo(0, 10);
  });

  it('clamps to [0,1]: opposite vectors (d=2, cos=-1) clamp to 0', () => {
    expect(cosineSimFromL2(2)).toBe(0);
  });
});

describe('l2FromCosineSim', () => {
  it('is the exact inverse of cosineSimFromL2 across the [0,1] band', () => {
    for (const cos of [0, 0.25, 0.5, 0.68, 0.8, 0.9, 1]) {
      const d = l2FromCosineSim(cos);
      expect(cosineSimFromL2(d)).toBeCloseTo(cos, 6);
    }
  });

  it('maps cosine 0.85 to its L2 cutoff sqrt(0.3)=0.547723 (consolidate dedup band)', () => {
    expect(l2FromCosineSim(0.85)).toBeCloseTo(Math.sqrt(0.3), 6);
  });

  it('maps cosine 1 to distance 0 and cosine 0 to sqrt(2)', () => {
    expect(l2FromCosineSim(1)).toBeCloseTo(0, 10);
    expect(l2FromCosineSim(0)).toBeCloseTo(Math.SQRT2, 10);
  });
});
