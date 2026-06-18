import { describe, it, expect } from 'vitest';
import { freshnessWarning, autoDecayConfig } from '../../search/hybrid.js';

/**
 * freshnessWarning thresholds are keyed by volatility: a volatile deploy/status
 * fact is suspect within days, a normal fact after a month, a stable reference
 * only after months. autoDecayConfig gives volatile facts a short half-life for
 * `auto_decay` searches and leaves durable facts untouched.
 */
describe('freshnessWarning (volatility-aware)', () => {
  it('volatile: silent fresh, soft at 3d, strong past 7d', () => {
    expect(freshnessWarning(1, 'volatile')).toBeNull();
    expect(freshnessWarning(3, 'volatile')).toMatch(/may be outdated/i);
    expect(freshnessWarning(10, 'volatile')).toMatch(/verify against current state/i);
  });

  it('normal: keeps the historical 30 / 90 day thresholds', () => {
    expect(freshnessWarning(3, 'normal')).toBeNull();
    expect(freshnessWarning(31, 'normal')).toMatch(/may be outdated/i);
    expect(freshnessWarning(91, 'normal')).toMatch(/verify against current state/i);
  });

  it('stable: silent until months old', () => {
    expect(freshnessWarning(31, 'stable')).toBeNull();
    expect(freshnessWarning(181, 'stable')).toMatch(/may be outdated/i);
    expect(freshnessWarning(400, 'stable')).toMatch(/verify against current state/i);
  });

  it('defaults to normal thresholds when volatility omitted', () => {
    expect(freshnessWarning(3)).toBeNull();
    expect(freshnessWarning(31)).toMatch(/may be outdated/i);
  });
});

describe('autoDecayConfig', () => {
  it('gives volatile facts a short exponential half-life', () => {
    expect(autoDecayConfig('volatile')).toEqual({ type: 'exponential', half_life_days: 3 });
  });

  it('leaves normal and stable facts undecayed (null)', () => {
    expect(autoDecayConfig('normal')).toBeNull();
    expect(autoDecayConfig('stable')).toBeNull();
  });
});
