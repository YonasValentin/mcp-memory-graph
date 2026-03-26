import type { ConfidenceLevel } from '../types.js';

export function computeConfidence(
  vectorDistance: number | null,
  keywordRank: number | null,
  fusedRank: number,
  totalResults: number
): number {
  const vectorSim = vectorDistance !== null
    ? Math.max(0, 1 - vectorDistance / 2)
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
