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

import type Database from 'better-sqlite3';

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

/**
 * RBAC v1 §6 — the access-level egress-ceiling predicate. Given a non-empty
 * allow-list of permitted access levels (from
 * {@link import('../lib/tenancy.js').principalAccessCeiling}), emits a single
 * `access_level IN (?, ?, …)` condition + its bound params so a principal never
 * receives a row above its key's ceiling. A SEPARATE predicate from the
 * positive single-level `access_level = ?` filter — both compose as an
 * intersection. No-op (empty result) when the ceiling is undefined OR empty, so
 * legacy/local callers are byte-identical. An optional `alias` prefixes the
 * column for JOIN sites (`<alias>.access_level`), mirroring the helpers above.
 */
export function accessCeilingCondition(
  ceiling: readonly string[] | undefined,
  alias?: string,
): { conditions: string[]; params: unknown[] } {
  if (!ceiling || ceiling.length === 0) return { conditions: [], params: [] };
  const col = alias ? `${alias}.access_level` : 'access_level';
  return {
    conditions: [`${col} IN (${ceiling.map(() => '?').join(',')})`],
    params: [...ceiling],
  };
}

/**
 * Single source of truth for the "how many conflicts are still pending?" count.
 * A conflict is PENDING when it is unresolved (`resolved_at IS NULL`) AND BOTH
 * endpoints are still live. A conflict whose OLD memory was retired by
 * supersession, OR whose NEW (correcting) memory was itself later retired
 * (`valid_to`/`tx_expired` set on either side), is moot even when `resolved_at`
 * was never stamped, so it must not count. Both endpoints are scoped to the
 * caller's (scope, namespace) so a tenant never sees a foreign tenant's count.
 * This mirrors `memory_health`/`memory_insights` exactly; the session-start hook
 * previously hand-rolled a naive `WHERE resolved_at IS NULL` and over-counted.
 */
export function countUnresolvedConflicts(
  db: Database.Database,
  input: { scope?: string; namespace?: string } = {},
): number {
  const o = scopeConditions(input, 'o');
  const n = scopeConditions(input, 'n');
  const scoped = [...o.conditions, ...n.conditions];
  const scopeSql = scoped.length ? ` AND ${scoped.join(' AND ')}` : '';
  return (
    db
      .prepare<unknown[], { n: number }>(
        `SELECT COUNT(*) AS n FROM memory_conflicts c
           JOIN memories o ON o.id = c.old_memory_id
           JOIN memories n ON n.id = c.new_memory_id
          WHERE c.resolved_at IS NULL
            AND o.valid_to IS NULL AND o.tx_expired IS NULL
            AND n.valid_to IS NULL AND n.tx_expired IS NULL${scopeSql}`,
      )
      .get(...o.params, ...n.params)?.n ?? 0
  );
}
