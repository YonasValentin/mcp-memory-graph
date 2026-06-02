// Unit test for the benchmark metric math (scripts/bench/metrics.mjs).
// Deterministic, no model — guards the precision@k / MRR / percentile
// formulas the R0 retrieval harness reports so they cannot silently drift.
import { describe, it, expect } from 'vitest';
// The metric module lives outside src/ (it is a benchmark utility, not shipped
// runtime code) but is exercised here so the suite covers the formulas.
import {
  precisionAtK,
  mrr,
  percentile,
  average,
  summarizeRanks,
} from '../../scripts/bench/metrics.mjs';

describe('bench/metrics precisionAtK', () => {
  // ranks are 1-based; null/0/-1 mean "gold not retrieved".
  it('counts a hit only when the gold rank is within k', () => {
    // ranks: gold at 1, 2, 4, MISS
    const ranks = [1, 2, 4, null];
    expect(precisionAtK(ranks, 1)).toBeCloseTo(1 / 4); // only the rank-1 query
    expect(precisionAtK(ranks, 3)).toBeCloseTo(2 / 4); // ranks 1 and 2
  });

  it('returns 1 when every query hits within k', () => {
    expect(precisionAtK([1, 1, 1], 1)).toBe(1);
  });

  it('returns 0 when nothing is retrieved', () => {
    expect(precisionAtK([null, null], 5)).toBe(0);
  });

  it('throws on an empty rank list (no division by zero)', () => {
    expect(() => precisionAtK([], 1)).toThrow();
  });
});

describe('bench/metrics mrr', () => {
  it('is the mean of reciprocal ranks, with misses contributing 0', () => {
    // 1/1 + 1/2 + 0 = 1.5 over 3 queries = 0.5
    expect(mrr([1, 2, null])).toBeCloseTo(0.5);
  });

  it('is 1.0 when every gold is rank 1', () => {
    expect(mrr([1, 1, 1])).toBe(1);
  });

  it('throws on an empty rank list', () => {
    expect(() => mrr([])).toThrow();
  });
});

describe('bench/metrics percentile', () => {
  it('returns the p95 via nearest-rank on a sorted copy', () => {
    const xs = [];
    for (let i = 1; i <= 100; i++) xs.push(i);
    // nearest-rank p95 of 1..100 is the 95th value
    expect(percentile(xs, 95)).toBe(95);
  });

  it('does not mutate the input array', () => {
    const xs = [9, 1, 5, 3];
    const copy = [...xs];
    percentile(xs, 50);
    expect(xs).toEqual(copy);
  });

  it('handles a single-element array', () => {
    expect(percentile([42], 95)).toBe(42);
  });

  it('clamps the index so p100 returns the max', () => {
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
  });

  it('throws on an empty array', () => {
    expect(() => percentile([], 95)).toThrow();
  });
});

describe('bench/metrics average', () => {
  it('computes the arithmetic mean', () => {
    expect(average([2, 4, 6])).toBe(4);
  });

  it('throws on an empty array', () => {
    expect(() => average([])).toThrow();
  });
});

describe('bench/metrics summarizeRanks', () => {
  it('rolls precision@1, precision@3 and MRR into one object', () => {
    const ranks = [1, 2, 4, null];
    const s = summarizeRanks(ranks);
    expect(s.queries).toBe(4);
    expect(s.precision_at_1).toBeCloseTo(0.25);
    expect(s.precision_at_3).toBeCloseTo(0.5);
    // 1/1 + 1/2 + 1/4 + 0 = 1.75 over 4 = 0.4375
    expect(s.mrr).toBeCloseTo(0.4375);
  });
});
