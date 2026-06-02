import type { ConfidenceLevel } from '../types.js';

/**
 * Convert a vec0 L2 (Euclidean) distance to cosine similarity.
 *
 * The vector index stores UNIT-NORMALIZED embeddings (the embedder calls the
 * model with `normalize: true`) under sqlite-vec's default L2 metric, so the
 * MATCH `distance` is the raw L2 distance `d`, not cosine. For unit vectors
 * ||a-b||^2 = 2 - 2cos, hence the exact recovery `cos = 1 - d^2/2`. The result
 * is clamped to [0,1] so an opposite-pointing pair (cos = -1) reports 0 rather
 * than a negative "similarity".
 *
 * This replaces the previous linear approximation `1 - d/2`, which under-reported
 * similarity for every non-identical pair (e.g. a true-cosine-0.8 pair, d≈0.632,
 * reported 0.684 instead of 0.800) and mis-calibrated user-facing thresholds.
 */
export function cosineSimFromL2(distance: number): number {
  return Math.max(0, Math.min(1, 1 - (distance * distance) / 2));
}

/**
 * Inverse of {@link cosineSimFromL2}: convert a user-supplied cosine-similarity
 * threshold into the L2 distance cutoff used to bound a vec0 KNN scan. From
 * `cos = 1 - d^2/2`, `d = sqrt(2(1 - cos))`. Lets callers express thresholds in
 * intuitive cosine terms while the index keeps scanning in efficient L2 space.
 */
export function l2FromCosineSim(similarity: number): number {
  return Math.sqrt(Math.max(0, 2 * (1 - similarity)));
}

export function computeConfidence(
  vectorDistance: number | null,
  keywordRank: number | null,
  fusedRank: number,
  totalResults: number
): number {
  const vectorSim = vectorDistance !== null
    ? cosineSimFromL2(vectorDistance)
    : 0;

  const keywordSim = keywordRank !== null
    ? Math.max(0, 1 - Math.abs(keywordRank) / 25)
    : 0;

  const positionFactor = 1 - fusedRank / Math.max(totalResults, 1);

  let confidence: number;

  if (vectorDistance !== null && keywordRank !== null) {
    confidence = (vectorSim + keywordSim + positionFactor) / 3;
  } else if (vectorDistance !== null) {
    confidence = (vectorSim + positionFactor) / 2;
  } else if (keywordRank !== null) {
    confidence = (keywordSim + positionFactor) / 2;
  } else {
    confidence = positionFactor;
  }

  return Math.max(0, Math.min(1, confidence));
}

export function confidenceLabel(score: number): ConfidenceLevel {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}
