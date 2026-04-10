import type { TemporalDecayConfig } from '../types.js';

export function applyTemporalDecay(
  score: number,
  createdAt: string,
  config: TemporalDecayConfig,
  accessCount?: number,
): number {
  const now = new Date();
  const created = new Date(createdAt);
  const ageDays = (now.getTime() - created.getTime()) / 86_400_000;

  if (ageDays < 0) return score;

  // Frequently accessed memories resist decay
  const accessBoost = accessCount ? 1 + Math.min(accessCount, 50) * 0.02 : 1;

  switch (config.type) {
    case 'exponential': {
      const halfLifeDays = (config.half_life_days ?? 30) * accessBoost;
      return score * Math.exp(-Math.LN2 / halfLifeDays * ageDays);
    }
    case 'linear': {
      const maxAgeDays = (config.max_age_days ?? 365) * accessBoost;
      return score * Math.max(0, 1 - ageDays / maxAgeDays);
    }
    case 'none':
      return score;
  }
}
