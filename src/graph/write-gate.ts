import type { ConflictResult } from './conflict-resolver.js';

/**
 * mem0-style write classification. Every store maps to exactly one operation:
 *   ADD    — insert a new memory.
 *   UPDATE — merge into an existing memory (append + re-embed + version bump).
 *   DELETE — invalidate (retire) the conflicting memory, then ADD the new one.
 *   NOOP   — exact duplicate already present; nothing changes.
 */
export type WriteOp = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

export interface WriteDecision {
  op: WriteOp;
  /** The existing memory the op targets (NOOP/UPDATE/DELETE). Absent for ADD. */
  targetId?: string;
  reason: string;
}

export type OnConflict = 'add' | 'update' | 'supersede';

/**
 * Pure classifier: turns conflict-detection output + an `on_conflict` policy
 * into a single {@link WriteDecision}. No I/O, no DB.
 *
 * Precedence:
 *   1. An exact `duplicate` is NEVER re-added → NOOP, regardless of policy.
 *   2. `on_conflict='update'` + a `superseded`-band conflict → UPDATE (merge).
 *   3. `on_conflict='supersede'` + a `superseded` OR `contradicted` conflict →
 *      DELETE (retire the old, then add the new).
 *   4. Otherwise → ADD.
 *
 * The default policy ('add') can only ever return NOOP or ADD, so it is
 * byte-identical to the pre-T9 store behaviour.
 */
export function decideWriteOperation(
  conflicts: ConflictResult[],
  onConflict: OnConflict,
): WriteDecision {
  const duplicate = conflicts.find((c) => c.type === 'duplicate');
  if (duplicate) {
    return {
      op: 'NOOP',
      targetId: duplicate.existing_memory_id,
      reason: `Exact duplicate of ${duplicate.existing_memory_id} — not re-added`,
    };
  }

  if (onConflict === 'update') {
    const superseded = conflicts.find((c) => c.type === 'superseded');
    if (superseded) {
      return {
        op: 'UPDATE',
        targetId: superseded.existing_memory_id,
        reason: `Merged into ${superseded.existing_memory_id} (on_conflict=update)`,
      };
    }
  }

  if (onConflict === 'supersede') {
    const target = conflicts.find(
      (c) => c.type === 'superseded' || c.type === 'contradicted',
    );
    if (target) {
      return {
        op: 'DELETE',
        targetId: target.existing_memory_id,
        reason: `Retired ${target.existing_memory_id} (on_conflict=supersede)`,
      };
    }
  }

  return { op: 'ADD', reason: 'No blocking conflict — inserted as new memory' };
}
