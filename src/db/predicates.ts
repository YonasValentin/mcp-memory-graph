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

/**
 * SQLite expression for "now" in the ISO-8601-with-millis-Z format
 * (`YYYY-MM-DDTHH:MM:SS.sssZ`). Use this everywhere a timestamp is written or
 * lexically range-compared instead of `datetime('now')` — whose space separator
 * (0x20) sorts before `'T'` (0x54), so a same-day ISO-Z value mis-collates
 * against it (TTL leaks, stale tombstones out-sort live edits in git merge).
 */
export const NOW_ISO_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export interface LiveConditionOptions {
  /** Also exclude superseded rows (`superseded_at IS NULL`). Search-grade strictness. */
  excludeSuperseded?: boolean;
  /** Also restrict to top-level documents (`parent_id IS NULL`), excluding chunk children. */
  topLevelOnly?: boolean;
  /** Also exclude rows whose TTL has passed (`expires_at IS NULL OR expires_at > now`). */
  excludeExpired?: boolean;
  /**
   * Optional table alias to prefix every emitted column with (`<alias>.col`),
   * for use inside JOINs where a bare column would be ambiguous (e.g.
   * `liveConditions({ topLevelOnly: true, alias: 'm' })`). When omitted, output
   * is byte-identical to the historical bare-column form. The `NOW_ISO_SQL`
   * "now" expression is left bare (it references no table column).
   */
  alias?: string;
}

/**
 * Returns the SQL conditions (to be joined with ` AND `) that select only
 * currently-live memory rows. Always includes the bitemporal validity guard.
 */
export function liveConditions(opts: LiveConditionOptions = {}): string[] {
  const p = opts.alias ? `${opts.alias}.` : '';
  const conditions = [`${p}valid_to IS NULL`, `${p}tx_expired IS NULL`];
  if (opts.excludeSuperseded) conditions.push(`${p}superseded_at IS NULL`);
  if (opts.topLevelOnly) conditions.push(`${p}parent_id IS NULL`);
  if (opts.excludeExpired) {
    conditions.push(`(${p}expires_at IS NULL OR ${p}expires_at > ${NOW_ISO_SQL})`);
  }
  return conditions;
}

/**
 * Builds the common `scope = ? / namespace = ? / department = ?` conditions and
 * their bound params from a filter input. Only defined fields are constrained.
 *
 * An optional `alias` prefixes every emitted column with `<alias>.` (for use in
 * JOINs); the bound params are identical with or without it. When omitted,
 * output is byte-identical to the historical bare-column form.
 */
export function scopeConditions(
  input: {
    scope?: string;
    namespace?: string;
    department?: string;
  },
  alias?: string,
): { conditions: string[]; params: unknown[] } {
  const p = alias ? `${alias}.` : '';
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.scope !== undefined) {
    conditions.push(`${p}scope = ?`);
    params.push(input.scope);
  }
  if (input.namespace !== undefined) {
    conditions.push(`${p}namespace = ?`);
    params.push(input.namespace);
  }
  if (input.department !== undefined) {
    conditions.push(`${p}department = ?`);
    params.push(input.department);
  }
  return { conditions, params };
}
