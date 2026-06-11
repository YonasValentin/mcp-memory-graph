import type Database from 'better-sqlite3';
import type { MemoryScope, MemoryRow } from '../types.js';
import { classifyTier, type MemoryTier } from '../search/tiers.js';
import { liveConditions, scopeConditions, accessCeilingCondition } from '../db/predicates.js';

interface TiersInput {
  scope?: MemoryScope;
  namespace?: string;
  /** Injected reference time for deterministic classification (tests). */
  now?: Date;
  /**
   * RBAC §6 (re-battle-5): hot_memories returns id+title — an over-ceiling row's
   * title is sensitive egress, so a capped principal's tiers reflect only rows
   * at/below the ceiling. undefined → legacy/local/full-clearance.
   */
  access_level_ceiling?: string[];
}

interface TiersResult {
  counts: Record<MemoryTier, number>;
  total: number;
  hot_memories: Array<{ id: string; title: string | null }>;
}

/** Max hot memories returned in the response. */
const HOT_LIMIT = 20;

type TierRow = Pick<
  MemoryRow,
  'id' | 'title' | 'access_count' | 'last_accessed_at' | 'created_at' | 'stability'
>;

/**
 * Classify currently-valid, top-level memories into hot / recall / archival
 * tiers (MemGPT-style) and return the distribution plus the hot set. Purely a
 * read over existing columns — no schema change, no side effects.
 */
export function handleMemoryTiers(
  db: Database.Database,
  input: TiersInput = {},
): TiersResult {
  const now = input.now ?? new Date();

  // Top-level, currently-valid memories only (bi-temporal filter).
  const scope = scopeConditions(input);
  const ceil = accessCeilingCondition(input.access_level_ceiling);
  const conditions: string[] = [
    ...liveConditions({ topLevelOnly: true }),
    ...scope.conditions,
    ...ceil.conditions,
  ];
  const params: unknown[] = [...scope.params, ...ceil.params];

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const rows = db
    .prepare<unknown[], TierRow>(
      `SELECT id, title, access_count, last_accessed_at, created_at, stability
       FROM memories ${whereClause}
       ORDER BY COALESCE(last_accessed_at, created_at) DESC`,
    )
    .all(...params);

  const counts: Record<MemoryTier, number> = { hot: 0, recall: 0, archival: 0 };
  const hot_memories: Array<{ id: string; title: string | null }> = [];

  for (const row of rows) {
    const tier = classifyTier(row, now);
    counts[tier] += 1;
    if (tier === 'hot' && hot_memories.length < HOT_LIMIT) {
      hot_memories.push({ id: row.id, title: row.title });
    }
  }

  return { counts, total: rows.length, hot_memories };
}
