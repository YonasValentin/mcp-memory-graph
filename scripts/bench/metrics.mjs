// Pure retrieval-quality metric math for the R0 benchmark harness.
//
// Kept dependency-free and side-effect-free so it can be unit tested
// deterministically (no model, no DB) by src/__tests__/bench-metrics.test.ts,
// and reused by scripts/bench/retrieval.mjs.
//
// Rank convention: a "rank" is the 1-based position of the gold (best) hit in
// the result list. A value that is null, <= 0 means the gold result was not
// retrieved at all (a miss).

/** True when a rank represents a real hit (1-based, present). */
function isHit(rank) {
  return typeof rank === 'number' && rank > 0;
}

/**
 * precision@k: fraction of queries whose gold hit lands within the top k.
 * @param {Array<number|null>} ranks 1-based ranks; null/<=0 = miss.
 * @param {number} k cutoff (>= 1).
 */
export function precisionAtK(ranks, k) {
  if (!Array.isArray(ranks) || ranks.length === 0) {
    throw new Error('precisionAtK: ranks must be a non-empty array');
  }
  let hits = 0;
  for (const r of ranks) {
    if (isHit(r) && r <= k) hits++;
  }
  return hits / ranks.length;
}

/**
 * Mean Reciprocal Rank: mean of 1/rank, with misses contributing 0.
 * @param {Array<number|null>} ranks 1-based ranks; null/<=0 = miss.
 */
export function mrr(ranks) {
  if (!Array.isArray(ranks) || ranks.length === 0) {
    throw new Error('mrr: ranks must be a non-empty array');
  }
  let sum = 0;
  for (const r of ranks) {
    if (isHit(r)) sum += 1 / r;
  }
  return sum / ranks.length;
}

/**
 * Nearest-rank percentile over a numeric sample (e.g. latencies in ms).
 * Does not mutate the input. p is in [0, 100].
 * @param {number[]} values
 * @param {number} p percentile, e.g. 95.
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('percentile: values must be a non-empty array');
  }
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: index = ceil(p/100 * N) - 1, clamped into bounds.
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  const clamped = Math.min(sorted.length - 1, Math.max(0, idx));
  return sorted[clamped];
}

/** Arithmetic mean of a non-empty numeric array. */
export function average(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('average: values must be a non-empty array');
  }
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Roll the per-query ranks into the headline retrieval metrics.
 * @param {Array<number|null>} ranks 1-based ranks; null/<=0 = miss.
 */
export function summarizeRanks(ranks) {
  return {
    queries: ranks.length,
    precision_at_1: precisionAtK(ranks, 1),
    precision_at_3: precisionAtK(ranks, 3),
    mrr: mrr(ranks),
  };
}
