import type Database from 'better-sqlite3';
import {
  liveConditions,
  scopeConditions,
  accessCeilingCondition,
  countUnresolvedConflicts,
} from '../db/predicates.js';

export interface HealthReport {
  status: 'ok' | 'attention';
  memories: {
    live: number;
    retired: number;
    stale: number;
    aging_90d: number;
    aging_180d: number;
  };
  conflicts: { unresolved: number };
  webhooks: {
    targets: number;
    circuit_open: number;
    pending: number;
    dead: number;
  };
  attention_reasons: string[];
}

function scopeClause(
  alias: string,
  input: { scope?: string; namespace?: string },
): { sql: string; params: unknown[] } {
  const { conditions, params } = scopeConditions(input, alias);
  return { sql: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', params };
}

function count(db: Database.Database, sql: string, params: unknown[]): number {
  return db.prepare<unknown[], { n: number }>(sql).get(...params)?.n ?? 0;
}

/**
 * Store health report (M3.2): `memory_health`. A single read that answers "is my
 * memory healthy?" — volume, retired/stale ratios, unresolved conflicts,
 * by-time freshness, and (when the event bus is on) webhook delivery health.
 * Read-only; optionally scoped. `status` is a rolled-up verdict so a caller can
 * branch on one field.
 */
export function handleHealth(
  db: Database.Database,
  input: { scope?: string; namespace?: string; access_level_ceiling?: string[] } = {},
): HealthReport {
  const f = scopeClause('m', input);
  // RBAC §6 (RB-10): the memory volume counts (live/retired/stale/aging) are an
  // aggregate COUNT egress — without the ceiling a sub-ceiling principal observes
  // the count of OVER-ceiling rows in its namespace. Thread the ceiling into those
  // five counts (no-op when undefined). The conflict + webhook counts below are
  // not per-row access-classified, so they are left unchanged.
  const ceil = accessCeilingCondition(input.access_level_ceiling, 'm');
  const cSql = ceil.conditions.length ? ` AND ${ceil.conditions.join(' AND ')}` : '';
  const mp = [...f.params, ...ceil.params];
  const live = liveConditions({ topLevelOnly: true, alias: 'm' }).join(' AND ');
  // The retired predicate is the logical NEGATION of `live` (parent_id IS NULL
  // AND NOT valid) — there is no single-source-of-truth equivalent, so it stays
  // inline by design.
  const retired = `m.parent_id IS NULL AND (m.valid_to IS NOT NULL OR m.tx_expired IS NOT NULL)`;

  const liveCount = count(db, `SELECT COUNT(*) AS n FROM memories m WHERE ${live}${f.sql}${cSql}`, mp);
  const retiredCount = count(
    db,
    `SELECT COUNT(*) AS n FROM memories m WHERE ${retired}${f.sql}${cSql}`,
    mp,
  );
  const staleCount = count(
    db,
    `SELECT COUNT(*) AS n FROM memories m WHERE m.revalidation_status = 'stale' AND ${live}${f.sql}${cSql}`,
    mp,
  );
  // Aging by transaction-created time. created_at is ISO-8601-with-Z while
  // datetime('now',…) is space-separated — a raw lexical compare mis-collates on
  // the boundary. julianday() normalizes BOTH sides to a numeric day so the
  // comparison is format-independent.
  const aging = (days: number): number =>
    count(
      db,
      `SELECT COUNT(*) AS n FROM memories m
        WHERE ${live} AND julianday(m.created_at) < julianday('now', '-${days} days')${f.sql}${cSql}`,
      mp,
    );
  const aging90 = aging(90);
  const aging180 = aging(180);

  // battle-v9 rebattle-3 (HIGH cross-tenant leak): memory_conflicts has no scope
  // column, but each conflict IS created within a namespace (the vec0 conflict
  // scan is partitioned), so the count must be scoped via its OLD memory's
  // (scope,namespace) — otherwise a forced-namespace tenant sees a FOREIGN
  // tenant's unresolved-conflict count and its status flips to 'attention'. The
  // OLD-memory join already exists; just apply the same scope filter to it. A
  // conflict whose OLD memory is already retired (valid_to/tx_expired set) was
  // resolved by supersession even though resolved_at was never stamped, so
  // exclude it — otherwise every applied supersede shows 'unresolved' forever.
  // battle-v14 G4: require BOTH endpoints in scope. A migrated/pre-v14 conflict
  // can be cross-namespace (old in tenant-a, new in tenant-b); scoping only the
  // OLD side still counted it for tenant-a, disclosing that a foreign tenant's
  // memory contradicts one of theirs. Joining the NEW memory with the same scope
  // filter means a forced tenant only counts conflicts wholly within its namespace
  // (matches memory_insights, which already scopes both sides).
  const unresolved = countUnresolvedConflicts(db, input);

  // Webhook delivery health is a SINGLE global event bus (opt-in via
  // MCP_WEBHOOKS; webhook_targets/deliveries carry no namespace dimension), so it
  // is reported store-wide BY DESIGN — not a tenancy oversight. A multi-tenant
  // deployment would not share one webhook bus across tenants.
  const targets = count(db, `SELECT COUNT(*) AS n FROM webhook_targets`, []);
  const circuitOpen = count(
    db,
    // circuit_open_until is ISO-Z; julianday both sides to avoid the ISO-Z vs
    // space-separated false-open within the same wall-clock second.
    `SELECT COUNT(*) AS n FROM webhook_targets WHERE circuit_open_until IS NOT NULL AND julianday(circuit_open_until) > julianday('now')`,
    [],
  );
  const pending = count(
    db,
    `SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status IN ('pending','failed')`,
    [],
  );
  const dead = count(db, `SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'dead'`, []);

  const attention_reasons: string[] = [];
  if (unresolved > 0) attention_reasons.push(`${unresolved} unresolved conflict(s)`);
  if (staleCount > 0) attention_reasons.push(`${staleCount} memory(ies) need revalidation`);
  if (dead > 0) attention_reasons.push(`${dead} dead webhook delivery(ies)`);
  if (circuitOpen > 0) attention_reasons.push(`${circuitOpen} webhook target(s) with an open circuit`);

  return {
    status: attention_reasons.length > 0 ? 'attention' : 'ok',
    memories: {
      live: liveCount,
      retired: retiredCount,
      stale: staleCount,
      aging_90d: aging90,
      aging_180d: aging180,
    },
    conflicts: { unresolved },
    webhooks: { targets, circuit_open: circuitOpen, pending, dead },
    attention_reasons,
  };
}
