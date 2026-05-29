/**
 * MemGPT-style memory tiers (Task T13).
 *
 * Classifies a memory into one of three tiers from its access recency +
 * frequency (and optional T11 stability). Purely derived from existing columns
 * — no schema change. Used by the `memory_tiers` read tool; deliberately does
 * NOT touch search/store/consolidate behavior.
 *
 *   - `hot`      — currently active working set (frequent or recently touched).
 *   - `recall`   — warm: not active, but not yet cold enough to archive.
 *   - `archival` — old and rarely touched: a candidate for cold storage.
 */

export type MemoryTier = 'hot' | 'recall' | 'archival';

/** Access count at/above which a memory is hot regardless of age. */
export const HOT_ACCESS_COUNT = 10;
/** Recency (days) at/below which a memory is hot regardless of access count. */
export const HOT_AGE_DAYS = 7;
/** Age (days) at/above which a cold memory becomes archival. */
export const ARCHIVAL_AGE_DAYS = 90;
/** Access count below which an old memory is archival (≥ stays recall). */
export const ARCHIVAL_MAX_ACCESS = 2;

const MS_PER_DAY = 86_400_000;

/**
 * Pure, deterministic tier classifier. Pass `now` for testability.
 *
 * Rules (order matters — hot first, then archival, else recall):
 *   - hot:      access_count ≥ HOT_ACCESS_COUNT OR ageDays ≤ HOT_AGE_DAYS
 *   - archival: ageDays ≥ ARCHIVAL_AGE_DAYS AND access_count < ARCHIVAL_MAX_ACCESS
 *   - else:     recall
 *
 * `ageDays` is measured from the last time the memory was seen
 * (`last_accessed_at ?? created_at`). `stability` is accepted for forward
 * compatibility but is not required by the current rules.
 */
export function classifyTier(
  row: {
    access_count: number;
    last_accessed_at: string | null;
    created_at: string;
    stability?: number;
  },
  now: Date = new Date(),
): MemoryTier {
  const lastSeen = row.last_accessed_at ?? row.created_at;
  const ageDays = Math.max(0, (now.getTime() - new Date(lastSeen).getTime()) / MS_PER_DAY);

  if (row.access_count >= HOT_ACCESS_COUNT || ageDays <= HOT_AGE_DAYS) {
    return 'hot';
  }
  if (ageDays >= ARCHIVAL_AGE_DAYS && row.access_count < ARCHIVAL_MAX_ACCESS) {
    return 'archival';
  }
  return 'recall';
}
