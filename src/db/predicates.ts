/**
 * Single source of truth for the "is this row currently live" SQL predicate and
 * the scope/namespace/department filter builder.
 *
 * A memory row is LIVE when it is bitemporally valid (`valid_to IS NULL`) and
 * not transaction-retracted (`tx_expired IS NULL`). This predicate was hand-
 * written many slightly-different ways across search/graph/hooks and was
 * *missing entirely* from export/stats/manifest — so backups resurrected
 * soft-deleted facts and stats over-counted retired rows (BATTLE-PLAN #3/#4/#7).
 * Centralizing it guarantees every surface agrees on what "live" means.
 */

export interface LiveConditionOptions {
  /** Also exclude superseded rows (`superseded_at IS NULL`). Search-grade strictness. */
  excludeSuperseded?: boolean;
  /** Also restrict to top-level documents (`parent_id IS NULL`), excluding chunk children. */
  topLevelOnly?: boolean;
  /** Also exclude rows whose TTL has passed (`expires_at IS NULL OR expires_at > now`). */
  excludeExpired?: boolean;
}

/**
 * Returns the SQL conditions (to be joined with ` AND `) that select only
 * currently-live memory rows. Always includes the bitemporal validity guard.
 */
export function liveConditions(opts: LiveConditionOptions = {}): string[] {
  const conditions = ['valid_to IS NULL', 'tx_expired IS NULL'];
  if (opts.excludeSuperseded) conditions.push('superseded_at IS NULL');
  if (opts.topLevelOnly) conditions.push('parent_id IS NULL');
  if (opts.excludeExpired) {
    conditions.push("(expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
  }
  return conditions;
}

/**
 * Builds the common `scope = ? / namespace = ? / department = ?` conditions and
 * their bound params from a filter input. Only defined fields are constrained.
 */
export function scopeConditions(input: {
  scope?: string;
  namespace?: string;
  department?: string;
}): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.scope !== undefined) {
    conditions.push('scope = ?');
    params.push(input.scope);
  }
  if (input.namespace !== undefined) {
    conditions.push('namespace = ?');
    params.push(input.namespace);
  }
  if (input.department !== undefined) {
    conditions.push('department = ?');
    params.push(input.department);
  }
  return { conditions, params };
}
