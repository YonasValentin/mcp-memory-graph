import type Database from 'better-sqlite3';
import {
  computeBlastRadius,
  clearRevalidation,
  listStaleMemories,
  type AffectedNode,
} from '../graph/propagate.js';

/**
 * `memory_revalidate` (M3.3) — the read/confirm surface for change-propagation.
 *   - list    : the memories currently flagged needs_revalidation (stale).
 *   - preview : the blast radius of a change to `id` — which dependents WOULD be
 *               flagged stale — WITHOUT mutating anything (dry-run).
 *   - confirm : clear `id`'s stale flag (an agent re-verified it).
 */

export interface RevalidateInput {
  action?: 'list' | 'preview' | 'confirm';
  id?: string;
  scope?: string;
  namespace?: string;
  limit?: number;
  /** RBAC §6 (re-battle-5): list mode returns stale {id,title} — ceiling-gate it. */
  access_level_ceiling?: string[];
}

export interface RevalidateResult {
  action: 'list' | 'preview' | 'confirm';
  stale?: Array<{ id: string; title: string | null; scope: string; namespace: string | null }>;
  blast_radius?: AffectedNode[];
  confirmed?: boolean;
  count?: number;
}

export function handleRevalidate(db: Database.Database, input: RevalidateInput): RevalidateResult {
  const action = input.action ?? 'list';

  if (action === 'preview') {
    if (!input.id) throw new Error('memory_revalidate action=preview requires an id');
    const blast = computeBlastRadius(db, input.id);
    // battle-v9 rebattle-4 (LOW cross-tenant id enumeration): computeBlastRadius
    // walks the shared memory_links graph (a cross-namespace derived_from IS a
    // real dependency the WRITE path must still flag), but this READ surface must
    // not RETURN foreign dependent ids. When forced (input.namespace/scope set by
    // withForcedNs), drop dependents whose memory is not in the caller's
    // partition. The seed id is already ownership-guarded at the server.
    let visible = blast;
    if ((input.namespace !== undefined || input.scope !== undefined) && blast.length > 0) {
      const conds: string[] = ['id = ?'];
      const tail: unknown[] = [];
      if (input.scope !== undefined) { conds.push('scope = ?'); tail.push(input.scope); }
      if (input.namespace !== undefined) { conds.push('namespace = ?'); tail.push(input.namespace); }
      const inPartition = db.prepare<unknown[], { id: string }>(
        `SELECT id FROM memories WHERE ${conds.join(' AND ')}`,
      );
      visible = blast.filter((n) => inPartition.get(n.id, ...tail) !== undefined);
    }
    return { action, blast_radius: visible, count: visible.length };
  }

  if (action === 'confirm') {
    if (!input.id) throw new Error('memory_revalidate action=confirm requires an id');
    return { action, confirmed: clearRevalidation(db, input.id) };
  }

  const stale = listStaleMemories(db, {
    scope: input.scope,
    namespace: input.namespace,
    limit: input.limit,
    access_level_ceiling: input.access_level_ceiling,
  });
  return { action: 'list', stale, count: stale.length };
}
