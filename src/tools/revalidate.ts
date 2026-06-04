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
    return { action, blast_radius: blast, count: blast.length };
  }

  if (action === 'confirm') {
    if (!input.id) throw new Error('memory_revalidate action=confirm requires an id');
    return { action, confirmed: clearRevalidation(db, input.id) };
  }

  const stale = listStaleMemories(db, {
    scope: input.scope,
    namespace: input.namespace,
    limit: input.limit,
  });
  return { action: 'list', stale, count: stale.length };
}
