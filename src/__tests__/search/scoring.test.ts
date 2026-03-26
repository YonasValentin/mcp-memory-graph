import { describe, it, expect } from 'vitest';
import { computeConfidence, confidenceLabel } from '../../search/scoring.js';

describe('computeConfidence', () => {
  it('returns high confidence for close vector match at top position', () => {
    // distance=0 means exact match, rank 0 of 10 results
    const conf = computeConfidence(0, null, 0, 10);
    expect(conf).toBeGreaterThan(0.8);
  });

  it('returns high confidence for top keyword match at top position', () => {
    const conf = computeConfidence(null, 0, 0, 10);
    expect(conf).toBeGreaterThan(0.5);
  });

  it('returns higher confidence for hybrid match than vector-only', () => {
    // Use a moderate vector distance so keyword contribution raises the score
    const hybrid = computeConfidence(0.8, -2, 0, 10);
    const vectorOnly = computeConfidence(0.8, null, 0, 10);
    expect(hybrid).toBeGreaterThan(vectorOnly);
  });

  it('confidence decreases with distance', () => {
    const close = computeConfidence(0.1, null, 0, 10);
    const far = computeConfidence(1.5, null, 0, 10);
    expect(close).toBeGreaterThan(far);
  });

  it('confidence decreases with lower position', () => {
    const top = computeConfidence(0.5, null, 0, 10);
    const bottom = computeConfidence(0.5, null, 9, 10);
    expect(top).toBeGreaterThan(bottom);
  });

  it('returns value between 0 and 1', () => {
    // Extreme inputs
    const cases = [
      computeConfidence(0, 0, 0, 1),
      computeConfidence(2.0, null, 99, 100),
      computeConfidence(null, -25, 50, 100),
      computeConfidence(null, null, 0, 1),
    ];
    for (const conf of cases) {
      expect(conf).toBeGreaterThanOrEqual(0);
      expect(conf).toBeLessThanOrEqual(1);
    }
  });

  it('handles single result (totalResults=1)', () => {
    const conf = computeConfidence(0.3, null, 0, 1);
    expect(conf).toBeGreaterThan(0);
    expect(conf).toBeLessThanOrEqual(1);
  });
});

describe('confidenceLabel', () => {
  it('returns "high" for >= 0.7', () => {
    expect(confidenceLabel(0.7)).toBe('high');
    expect(confidenceLabel(1.0)).toBe('high');
  });

  it('returns "medium" for >= 0.4', () => {
    expect(confidenceLabel(0.4)).toBe('medium');
    expect(confidenceLabel(0.69)).toBe('medium');
  });

  it('returns "low" for < 0.4', () => {
    expect(confidenceLabel(0.39)).toBe('low');
    expect(confidenceLabel(0)).toBe('low');
  });
});
