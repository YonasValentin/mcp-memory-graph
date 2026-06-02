import { describe, it, expect } from 'vitest';
import { applyTemporalDecay } from '../../search/temporal.js';
import { MemorySearchSchema } from '../../schemas/index.js';
import type { TemporalDecayConfig } from '../../types.js';

const NOW_ISO = new Date().toISOString();

describe('applyTemporalDecay is robust to degenerate config (SEARCH-1)', () => {
  it('half_life_days = 0 never yields NaN', () => {
    const out = applyTemporalDecay(1, NOW_ISO, { type: 'exponential', half_life_days: 0 } as TemporalDecayConfig);
    expect(Number.isNaN(out)).toBe(false);
    expect(out).toBeGreaterThanOrEqual(0);
    expect(out).toBeLessThanOrEqual(1);
  });

  it('negative half_life_days never inflates the score above the input', () => {
    const out = applyTemporalDecay(1, '2020-01-01T00:00:00.000Z', { type: 'exponential', half_life_days: -30 } as TemporalDecayConfig);
    expect(out).toBeLessThanOrEqual(1);
    expect(Number.isFinite(out)).toBe(true);
  });

  it('non-positive max_age_days never inflates or NaNs linear decay', () => {
    const zero = applyTemporalDecay(1, NOW_ISO, { type: 'linear', max_age_days: 0 } as TemporalDecayConfig);
    const neg = applyTemporalDecay(1, '2020-01-01T00:00:00.000Z', { type: 'linear', max_age_days: -10 } as TemporalDecayConfig);
    for (const v of [zero, neg]) {
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('temporal_decay schema rejects degenerate values at the boundary (SEARCH-1)', () => {
  it('rejects half_life_days <= 0', () => {
    expect(MemorySearchSchema.safeParse({ query: 'x', temporal_decay: { type: 'exponential', half_life_days: 0 } }).success).toBe(false);
    expect(MemorySearchSchema.safeParse({ query: 'x', temporal_decay: { type: 'exponential', half_life_days: -1 } }).success).toBe(false);
  });

  it('rejects non-finite max_age_days', () => {
    expect(MemorySearchSchema.safeParse({ query: 'x', temporal_decay: { type: 'linear', max_age_days: Infinity } }).success).toBe(false);
  });

  it('accepts positive values', () => {
    expect(MemorySearchSchema.safeParse({ query: 'x', temporal_decay: { type: 'exponential', half_life_days: 30 } }).success).toBe(true);
  });
});

describe("search schema exposes the implemented 'forgetting' decay (SEARCH-2)", () => {
  it("accepts temporal_decay.type = 'forgetting'", () => {
    const parsed = MemorySearchSchema.safeParse({ query: 'x', temporal_decay: { type: 'forgetting' } });
    expect(parsed.success).toBe(true);
  });
});
