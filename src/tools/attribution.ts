import type Database from 'better-sqlite3';
import { liveConditions, scopeConditions, accessCeilingCondition } from '../db/predicates.js';

const UNATTRIBUTED = 'unattributed';

export interface AttributionResult {
  by_agent: Record<string, number>;
  by_author: Record<string, number>;
  total: number;
}

/**
 * Pillar 7 (T22): multi-agent / team attribution.
 *
 * A read-only provenance rollup over currently-valid top-level memories: how
 * many memories each agent (`agent_id`, set at store time) wrote, and how many
 * each `author` (the human/source) is credited with. `agent_id` is distinct
 * from `author` — it answers "which of our agents produced this" so a team
 * running multiple agents can see provenance. Rows with a NULL agent_id are
 * bucketed under 'unattributed' (today's default).
 *
 * Counts only currently-valid (bi-temporal: valid_to/tx_expired NULL),
 * top-level (parent_id IS NULL) memories — chunks and retired facts are
 * excluded, matching the rest of the read surface.
 */
export function handleAttribution(
  db: Database.Database,
  input: { scope?: string; namespace?: string; access_level_ceiling?: string[] },
): AttributionResult {
  // battle-v9 CLASS 4: use the single-source live predicate so a restored-but-
  // still-superseded fact is NOT counted (the docstring promises retired facts
  // are excluded; the hand-written list omitted superseded_at IS NULL).
  // RBAC §6 (RB-10): the by_author / by_agent / total rollups are an aggregate
  // COUNT egress — without the ceiling they disclose the author identity and the
  // per-author/agent count of OVER-ceiling memories to a sub-ceiling principal (the
  // same count-oracle class as battle-v9 mention_count / re-battle-6 community
  // counts). Drop over-ceiling rows from the count. No-op when ceiling undefined.
  const scope = scopeConditions(input);
  const ceil = accessCeilingCondition(input.access_level_ceiling);
  const conditions: string[] = [
    ...liveConditions({ excludeSuperseded: true, topLevelOnly: true }),
    ...scope.conditions,
    ...ceil.conditions,
  ];
  const params: unknown[] = [...scope.params, ...ceil.params];

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const totalRow = db
    .prepare<unknown[], { total: number }>(
      `SELECT COUNT(*) as total FROM memories ${whereClause}`,
    )
    .get(...params);
  const total = totalRow?.total ?? 0;

  const agentRows = db
    .prepare<unknown[], { agent_id: string | null; count: number }>(
      `SELECT agent_id, COUNT(*) as count FROM memories ${whereClause} GROUP BY agent_id`,
    )
    .all(...params);
  const byAgent: Record<string, number> = {};
  for (const row of agentRows) {
    byAgent[row.agent_id ?? UNATTRIBUTED] = row.count;
  }

  const authorRows = db
    .prepare<unknown[], { author: string; count: number }>(
      `SELECT author, COUNT(*) as count FROM memories ${whereClause} AND author IS NOT NULL GROUP BY author`,
    )
    .all(...params);
  const byAuthor: Record<string, number> = {};
  for (const row of authorRows) {
    byAuthor[row.author] = row.count;
  }

  return { by_agent: byAgent, by_author: byAuthor, total };
}
