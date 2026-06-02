import type { TemporalDecayConfig } from '../types.js';

/**
 * Floor on stability so retention never divides by zero (or amplifies decay
 * for a corrupt sub-1 stability). Stability is seeded at 1.0 and only grows.
 */
export const MIN_STABILITY = 1;

/**
 * Spaced-repetition retention: the Ebbinghaus forgetting curve
 * `e^(-ageDays / stability)`, clamped to (0, 1]. Pure — the `'forgetting'`
 * decay type and the consolidate prune signal both call this.
 *   - ageDays 0 → 1.0
 *   - larger ageDays → smaller retention (monotonic)
 *   - higher stability → higher retention at the same age
 */
export function computeRetention(ageDays: number, stability: number): number {
  const age = Math.max(0, ageDays);
  const r = Math.exp(-age / Math.max(stability, MIN_STABILITY));
  return Math.min(1, Math.max(Number.MIN_VALUE, r));
}

/** Return `v` only when it is a finite positive number; otherwise `fallback`. */
function positiveOrDefault(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;
}

export function applyTemporalDecay(
  score: number,
  createdAt: string,
  config: TemporalDecayConfig,
  accessCount?: number,
  stability?: number,
): number {
  const now = new Date();
  const created = new Date(createdAt);
  const ageDays = (now.getTime() - created.getTime()) / 86_400_000;

  if (ageDays < 0) return score;

  // Frequently accessed memories resist decay
  const accessBoost = accessCount ? 1 + Math.min(accessCount, 50) * 0.02 : 1;

  switch (config.type) {
    case 'exponential': {
      // Defense in depth: the schema rejects non-positive half_life_days, but
      // guard here too so a degenerate value can never produce -Infinity/NaN
      // (e.g. 0 → division by zero) regardless of call path.
      const halfLifeDays = positiveOrDefault(config.half_life_days, 30) * accessBoost;
      return score * Math.exp(-Math.LN2 / halfLifeDays * ageDays);
    }
    case 'linear': {
      const maxAgeDays = positiveOrDefault(config.max_age_days, 365) * accessBoost;
      return score * Math.max(0, 1 - ageDays / maxAgeDays);
    }
    case 'forgetting':
      // Spaced-repetition curve: per-memory stability (grown by access) drives
      // retention directly. Higher stability → slower forgetting → less decay.
      return score * computeRetention(ageDays, stability ?? 1);
    case 'none':
      return score;
  }
}
