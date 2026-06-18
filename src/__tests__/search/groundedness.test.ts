import { describe, it, expect } from 'vitest';
import { computeGroundedness } from '../../search/scoring.js';

/**
 * Groundedness is a TRUST signal, orthogonal to relevance: it answers "how much
 * should I believe this memory", not "how well does it match the query". It
 * fuses four stored signals — the explicit `confidence_score`, the `provenance`
 * tier (operator-authored manual / vault_sync outrank machine-derived reflection
 * / ingest), how much of the validity window remains (recency vs `valid_to`),
 * and reinforcement (`access_count`) — into a 0..1 score, then bucketed to
 * high/medium/low via the SAME 0.7 / 0.4 thresholds as confidenceLabel so the
 * two signals are read on one scale. The function is pure: `now` is an ISO
 * parameter, never the wall clock, so a given row scores identically every run.
 */
describe('computeGroundedness', () => {
  const NOW = '2026-06-04T00:00:00.000Z';

  it('scores a manual, high-confidence, recent, well-accessed row HIGH', () => {
    const { groundedness, groundedness_level } = computeGroundedness(
      {
        confidence_score: 0.95,
        provenance: 'manual',
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-03T00:00:00.000Z',
        valid_to: null,
        access_count: 12,
      },
      NOW
    );
    expect(groundedness).toBeGreaterThanOrEqual(0.7);
    expect(groundedness_level).toBe('high');
  });

  it('scores a low-confidence ingest row near expiry LOW', () => {
    const { groundedness, groundedness_level } = computeGroundedness(
      {
        confidence_score: 0.2,
        provenance: 'ingest',
        created_at: '2025-06-04T00:00:00.000Z',
        updated_at: '2025-06-04T00:00:00.000Z',
        // validity window almost fully elapsed: 1 of ~365 days left
        valid_to: '2026-06-05T00:00:00.000Z',
        access_count: 0,
      },
      NOW
    );
    expect(groundedness).toBeLessThan(0.4);
    expect(groundedness_level).toBe('low');
  });

  it('ranks manual provenance above ingest, all else equal', () => {
    const base = {
      confidence_score: 0.6,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      valid_to: null,
      access_count: 3,
    } as const;
    const manual = computeGroundedness({ ...base, provenance: 'manual' }, NOW);
    const ingest = computeGroundedness({ ...base, provenance: 'ingest' }, NOW);
    expect(manual.groundedness).toBeGreaterThan(ingest.groundedness);
  });

  it('ranks vault_sync in the same top tier as manual', () => {
    const base = {
      confidence_score: 0.6,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      valid_to: null,
      access_count: 0,
    } as const;
    const vault = computeGroundedness({ ...base, provenance: 'vault_sync' }, NOW);
    const manual = computeGroundedness({ ...base, provenance: 'manual' }, NOW);
    expect(vault.groundedness).toBeCloseTo(manual.groundedness, 10);
  });

  it('treats an already-expired valid_to as no remaining recency credit', () => {
    const base = {
      confidence_score: 0.6,
      provenance: 'manual',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      access_count: 0,
    } as const;
    const expired = computeGroundedness(
      { ...base, valid_to: '2026-05-01T00:00:00.000Z' },
      NOW
    );
    const live = computeGroundedness({ ...base, valid_to: null }, NOW);
    expect(expired.groundedness).toBeLessThan(live.groundedness);
  });

  it('gives reinforcement (access_count) a bounded, monotone boost', () => {
    const base = {
      confidence_score: 0.5,
      provenance: 'reflection',
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      valid_to: null,
    } as const;
    const cold = computeGroundedness({ ...base, access_count: 0 }, NOW);
    const warm = computeGroundedness({ ...base, access_count: 5 }, NOW);
    const hot = computeGroundedness({ ...base, access_count: 1000 }, NOW);
    expect(warm.groundedness).toBeGreaterThan(cold.groundedness);
    expect(hot.groundedness).toBeGreaterThanOrEqual(warm.groundedness);
    // bounded: the boost saturates, it never blows past 1
    expect(hot.groundedness).toBeLessThanOrEqual(1);
  });

  it('maps to levels via the 0.7 / 0.4 thresholds (mirrors confidenceLabel)', () => {
    // HIGH: top confidence, top provenance, open window.
    expect(
      computeGroundedness(
        { confidence_score: 1.0, provenance: 'manual', created_at: NOW, updated_at: NOW, valid_to: null, access_count: 0 },
        NOW
      ).groundedness_level
    ).toBe('high');
    // MEDIUM: mid confidence, mid provenance, open window.
    expect(
      computeGroundedness(
        { confidence_score: 0.5, provenance: 'import', created_at: NOW, updated_at: NOW, valid_to: null, access_count: 0 },
        NOW
      ).groundedness_level
    ).toBe('medium');
    // LOW: zero confidence, lowest provenance, fully-expired window.
    expect(
      computeGroundedness(
        {
          confidence_score: 0.0,
          provenance: 'ingest',
          created_at: '2020-01-01T00:00:00.000Z',
          updated_at: '2020-01-01T00:00:00.000Z',
          valid_to: '2020-02-01T00:00:00.000Z',
          access_count: 0,
        },
        NOW
      ).groundedness_level
    ).toBe('low');
  });

  it('clamps every output to the closed [0,1] interval', () => {
    const cases = [
      computeGroundedness(
        { confidence_score: 5, provenance: 'manual', created_at: NOW, updated_at: NOW, valid_to: null, access_count: 1e9 },
        NOW
      ),
      computeGroundedness(
        { confidence_score: -3, provenance: 'ingest', created_at: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z', valid_to: '2000-02-01T00:00:00.000Z', access_count: 0 },
        NOW
      ),
    ];
    for (const { groundedness } of cases) {
      expect(groundedness).toBeGreaterThanOrEqual(0);
      expect(groundedness).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic: identical inputs yield identical output', () => {
    const row = {
      confidence_score: 0.7,
      provenance: 'manual' as const,
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-15T00:00:00.000Z',
      valid_to: '2027-01-01T00:00:00.000Z',
      access_count: 4,
    };
    const a = computeGroundedness(row, NOW);
    const b = computeGroundedness(row, NOW);
    expect(a).toEqual(b);
  });

  it('tolerates missing optional fields with sane defaults', () => {
    // Minimal row: only confidence_score present. Should not throw, stays in range.
    const { groundedness, groundedness_level } = computeGroundedness(
      { confidence_score: 0.5 },
      NOW
    );
    expect(groundedness).toBeGreaterThanOrEqual(0);
    expect(groundedness).toBeLessThanOrEqual(1);
    expect(['high', 'medium', 'low']).toContain(groundedness_level);
  });

  // v19: verification tier — orthogonal to provenance, weighted 0.18 into the base.
  describe('verification_tier', () => {
    const base = {
      confidence_score: 0.6,
      provenance: 'manual' as const,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
      valid_to: null,
      access_count: 0,
    };

    it('ranks source_verified > tool_verified > asserted > unverified, all else equal', () => {
      const sv = computeGroundedness({ ...base, verification_tier: 'source_verified' }, NOW).groundedness;
      const tv = computeGroundedness({ ...base, verification_tier: 'tool_verified' }, NOW).groundedness;
      const as = computeGroundedness({ ...base, verification_tier: 'asserted' }, NOW).groundedness;
      const un = computeGroundedness({ ...base, verification_tier: 'unverified' }, NOW).groundedness;
      expect(sv).toBeGreaterThan(tv);
      expect(tv).toBeGreaterThan(as);
      expect(as).toBeGreaterThan(un);
    });

    it('treats a missing tier as the neutral middle (== asserted)', () => {
      const none = computeGroundedness({ ...base }, NOW).groundedness;
      const asserted = computeGroundedness({ ...base, verification_tier: 'asserted' }, NOW).groundedness;
      expect(none).toBeCloseTo(asserted, 10);
    });

    it('pulls an unverified claim a full trust tier below the same claim source-verified', () => {
      // The motivating case: an unverified "deployed/live" fact must read as less
      // trustworthy than one checked against live state.
      const claim = {
        confidence_score: 0.7,
        provenance: 'reflection' as const,
        created_at: NOW,
        updated_at: NOW,
        valid_to: null,
        access_count: 0,
      };
      const verified = computeGroundedness({ ...claim, verification_tier: 'source_verified' }, NOW);
      const unverified = computeGroundedness({ ...claim, verification_tier: 'unverified' }, NOW);
      expect(verified.groundedness).toBeGreaterThan(unverified.groundedness);
      // crosses the medium/high (0.7) or low/medium (0.4) boundary, not just a nudge
      expect(verified.groundedness - unverified.groundedness).toBeGreaterThan(0.1);
    });

    it('ignores an unknown tier string (degrades to neutral, never NaN)', () => {
      const { groundedness } = computeGroundedness(
        { ...base, verification_tier: 'bogus-tier' },
        NOW
      );
      expect(groundedness).toBeGreaterThanOrEqual(0);
      expect(groundedness).toBeLessThanOrEqual(1);
    });
  });
});
