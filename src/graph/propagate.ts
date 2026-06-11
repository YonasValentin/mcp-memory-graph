import type Database from 'better-sqlite3';
import { getBacklinks } from './memory-links.js';

/**
 * Change-propagation (M3.3). When a memory is retired (bitemporal invalidate /
 * supersede) or its content is edited, anything DERIVED from it may no longer be
 * grounded. This walks the dependency graph backwards from the changed memory
 * and flags each dependent `revalidation_status = 'stale'` so search can
 * downrank it and an agent can re-confirm it.
 *
 * Edge direction matters and is REAL (verified against production writers): the
 * only edge a non-test writer emits that means "A depends on B" is
 * `derived_from` (reflect.ts: an insight `derived_from` its source facts —
 * source_memory_id = insight, target_memory_id = source). So a dependent of a
 * changed memory X is the SOURCE endpoint of a `derived_from` edge whose TARGET
 * is X → exactly `getBacklinks(X)` filtered to the propagating relations.
 *
 * `similar_to` / `co_occurs` / `links_to` are associative, not dependency, edges
 * and are NOT propagated by default (they would mark half the graph stale on any
 * edit). The relation set is overridable for callers that model dependency with
 * a custom typed relation.
 */

/** Relations whose presence means the source endpoint depends on the target. */
export const DEFAULT_PROPAGATING_RELATIONS = ['derived_from'] as const;

export interface PropagateOptions {
  /** Which edge relations carry dependency (default: ['derived_from']). */
  relations?: readonly string[];
  /** Max hops to walk (default 5) — bounds blast radius on deep chains/cycles. */
  maxDepth?: number;
  /** Cap on flagged memories (default 1000) — a safety bound. */
  maxNodes?: number;
}

export interface AffectedNode {
  id: string;
  /** The relation on the edge that linked this node into the blast radius. */
  relation: string;
  /** Hop distance from the originally-changed memory (1 = direct dependent). */
  depth: number;
}

/**
 * Compute the dependents that WOULD be flagged stale if `memoryId` changed,
 * WITHOUT mutating anything (dry-run / `blast_radius`). BFS over backlinks on
 * the propagating relations, bounded by depth + node cap, cycle-safe.
 */
export function computeBlastRadius(
  db: Database.Database,
  memoryId: string,
  opts: PropagateOptions = {},
): AffectedNode[] {
  const relations = new Set(opts.relations ?? DEFAULT_PROPAGATING_RELATIONS);
  const maxDepth = opts.maxDepth ?? 5;
  const maxNodes = opts.maxNodes ?? 1000;

  const visited = new Set<string>([memoryId]);
  const affected: AffectedNode[] = [];
  let frontier: string[] = [memoryId];
  let depth = 0;

  while (frontier.length > 0 && depth < maxDepth && affected.length < maxNodes) {
    depth += 1;
    const next: string[] = [];
    for (const node of frontier) {
      for (const edge of getBacklinks(db, node)) {
        if (!relations.has(edge.relation)) continue;
        // Only propagate across CURRENTLY-VALID edges (a retracted edge is not a
        // live dependency). memory_links carries the bitemporal stamps.
        const e = edge as typeof edge & { valid_to?: string | null; tx_expired?: string | null };
        if (e.valid_to != null || e.tx_expired != null) continue;
        const dependent = edge.source_memory_id;
        if (visited.has(dependent)) continue;
        visited.add(dependent);
        affected.push({ id: dependent, relation: edge.relation, depth });
        next.push(dependent);
        if (affected.length >= maxNodes) break;
      }
      if (affected.length >= maxNodes) break;
    }
    frontier = next;
  }
  return affected;
}

/**
 * Flag every dependent of `memoryId` `revalidation_status = 'stale'`. Skips the
 * changed memory itself and any dependent that is already retired (no point
 * flagging a tombstoned row). Returns the ids actually flagged. Idempotent:
 * re-flagging a stale row is a no-op write.
 */
export function propagateInvalidation(
  db: Database.Database,
  memoryId: string,
  opts: PropagateOptions = {},
): { flagged: string[] } {
  const affected = computeBlastRadius(db, memoryId, opts);
  if (affected.length === 0) return { flagged: [] };

  const flagged: string[] = [];
  const stmt = db.prepare(
    `UPDATE memories
        SET revalidation_status = 'stale'
      WHERE id = ?
        AND valid_to IS NULL
        AND tx_expired IS NULL
        AND (revalidation_status IS NULL OR revalidation_status != 'stale')`,
  );
  const tx = db.transaction(() => {
    for (const node of affected) {
      const changes = stmt.run(node.id).changes;
      if (changes > 0) flagged.push(node.id);
    }
  });
  tx.immediate();
  return { flagged };
}

/** Clear a memory's stale flag — used after an agent re-confirms it. */
export function clearRevalidation(db: Database.Database, memoryId: string): boolean {
  return (
    db
      .prepare("UPDATE memories SET revalidation_status = NULL WHERE id = ?")
      .run(memoryId).changes > 0
  );
}

/** List currently-valid memories flagged stale (for `memory_insights`/revalidate). */
export function listStaleMemories(
  db: Database.Database,
  filter: { scope?: string; namespace?: string; limit?: number; access_level_ceiling?: string[] } = {},
): Array<{ id: string; title: string | null; scope: string; namespace: string | null }> {
  const conds = ["revalidation_status = 'stale'", 'valid_to IS NULL', 'tx_expired IS NULL'];
  const params: unknown[] = [];
  if (filter.scope !== undefined) {
    conds.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.namespace !== undefined) {
    conds.push('namespace = ?');
    params.push(filter.namespace);
  }
  // §6 (re-battle-5): list mode returns stale {id,title} — gate over-ceiling
  // titles for a capped principal. No-op when undefined (legacy/local).
  if (filter.access_level_ceiling && filter.access_level_ceiling.length > 0) {
    conds.push(`access_level IN (${filter.access_level_ceiling.map(() => '?').join(',')})`);
    params.push(...filter.access_level_ceiling);
  }
  params.push(filter.limit ?? 100);
  return db
    .prepare<unknown[], { id: string; title: string | null; scope: string; namespace: string | null }>(
      `SELECT id, title, scope, namespace FROM memories
        WHERE ${conds.join(' AND ')}
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(...params);
}
