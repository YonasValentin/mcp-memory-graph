import type { TemporalDecayConfig } from '../types.js';

export function applyTemporalDecay(
  score: number,
  createdAt: string,
  config: TemporalDecayConfig
): number {
  const now = new Date();
  const created = new Date(createdAt);
  const ageDays = (now.getTime() - created.getTime()) / 86_400_000;

  if (ageDays < 0) return score;

  switch (config.type) {
    case 'exponential': {
      const halfLifeDays = config.half_life_days ?? 30;
      return score * Math.exp(-Math.LN2 / halfLifeDays * ageDays);
    }
    case 'linear': {
      const maxAgeDays = config.max_age_days ?? 365;
      return score * Math.max(0, 1 - ageDays / maxAgeDays);
    }
    case 'none':
      return score;
  }
}
