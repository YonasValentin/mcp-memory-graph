import type Database from 'better-sqlite3';

const DEFAULT_LIMIT = 20;
const SNIPPET_LEN = 60;
const MIN_CONTRADICTIONS = 2;

export type InsightType =
  | 'unresolved_conflict'
  | 'stale'
  | 'most_contradicted'
  | 'no_evidence_decision';

export interface Insight {
  type: InsightType;
  insight: string;
  evidence: string;
  memory_id?: string;
}

export interface InsightsResult {
  insights: Insight[];
  count: number;
}

function scopeFilter(
  alias: string,
  input: { scope?: string; namespace?: string },
): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.scope !== undefined) {
    conditions.push(`${alias}.scope = ?`);
    params.push(input.scope);
  }
  if (input.namespace !== undefined) {
    conditions.push(`${alias}.namespace = ?`);
    params.push(input.namespace);
  }
  return { sql: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', params };
}

/**
 * Active advisor surface (M3.2): `memory_insights`. Where `memory_questions`
 * asks "what should I capture next", insights answers "what in the store needs
 * attention right now" — the maintenance backlog the graph can detect itself.
 * Purely additive READ over currently-valid, top-level memories, optionally
 * scoped. Every signal is deterministic-ordered so identical stores yield
 * identical digests.
 *
 * Signals (emitted in this order, then capped at `limit`):
 *   1. unresolved_conflict — a recorded memory_conflict with resolved_at NULL.
 *   2. stale — a memory flagged needs_revalidation by change-propagation (M3.3):
 *      a source it was derived from changed/retired and it wasn't re-confirmed.
 *   3. most_contradicted — a memory that appears in the most conflict records
 *      (a repeatedly-disputed fact worth resolving once, properly).
 *   4. no_evidence_decision — a `decision` memory with no outgoing edges: a call
 *      recorded with nothing linking it to the facts it rests on.
 */
export function handleInsights(
  db: Database.Database,
  input: { scope?: string; namespace?: string; limit?: number },
): InsightsResult {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const live = (a: string) =>
    `${a}.parent_id IS NULL AND ${a}.valid_to IS NULL AND ${a}.tx_expired IS NULL`;
  const insights: Insight[] = [];

  // ── 1. unresolved_conflict ──────────────────────────────────────────────────
  {
    const o = scopeFilter('o', input);
    // battle-v9 rebattle-3: the conflict JOINs both the OLD (o) and NEW (n)
    // memory, but only `o` was scope-filtered — so a conflict whose old side is
    // in-tenant but new side is FOREIGN leaked the foreign memory's title/content
    // verbatim in the insight string. Scope `n` too (same shared-table tenancy
    // class as graph/communities/questions/health). The partitioned store path no
    // longer creates cross-namespace conflicts, but legacy/imported rows can.
    const n = scopeFilter('n', input);
    const rows = db
      .prepare<unknown[], { id: string; otype: string; oldl: string; newl: string }>(
        `SELECT c.id AS id, c.conflict_type AS otype,
                COALESCE(o.title, substr(o.content, 1, ${SNIPPET_LEN})) AS oldl,
                COALESCE(n.title, substr(n.content, 1, ${SNIPPET_LEN})) AS newl
           FROM memory_conflicts c
           JOIN memories o ON o.id = c.old_memory_id
           JOIN memories n ON n.id = c.new_memory_id
          WHERE c.resolved_at IS NULL
            AND o.valid_to IS NULL AND o.tx_expired IS NULL${o.sql}${n.sql}
          ORDER BY c.id`,
      )
      .all(...o.params, ...n.params);
    for (const r of rows) {
      insights.push({
        type: 'unresolved_conflict',
        insight: `Unresolved ${r.otype} conflict between "${r.oldl}" and "${r.newl}".`,
        evidence: `conflict_id=${r.id}`,
      });
    }
  }

  // ── 2. stale (needs_revalidation) ───────────────────────────────────────────
  {
    const f = scopeFilter('m', input);
    const rows = db
      .prepare<unknown[], { id: string; label: string }>(
        `SELECT m.id AS id, COALESCE(m.title, substr(m.content, 1, ${SNIPPET_LEN})) AS label
           FROM memories m
          WHERE m.revalidation_status = 'stale' AND ${live('m')}${f.sql}
          ORDER BY m.updated_at DESC, m.id`,
      )
      .all(...f.params);
    for (const r of rows) {
      insights.push({
        type: 'stale',
        insight: `"${r.label}" may be out of date — a source it was derived from changed. Re-confirm it.`,
        evidence: `memory_id=${r.id}`,
        memory_id: r.id,
      });
    }
  }

  // ── 3. most_contradicted ────────────────────────────────────────────────────
  // Count each memory's appearances across BOTH sides of memory_conflicts. A
  // UNION ALL of old+new ids, grouped, gives an honest "how often disputed".
  {
    const f = scopeFilter('m', input);
    const scoped = input.scope !== undefined || input.namespace !== undefined;
    let rows: Array<{ id: string; label: string; n: number }>;
    if (scoped) {
      // battle-v9 rebattle-4 (MED side-channel): the conflict count scanned the
      // WHOLE memory_conflicts table (no scope column), so a forced tenant saw a
      // count inflated by FOREIGN conflicts (and a memory false-flagged as
      // most_contradicted on foreign volume). Count only conflicts BOTH of whose
      // sides are in the caller's partition — mirroring the questions
      // tenant_mentions fix. Live store path no longer creates cross-namespace
      // conflicts; legacy/imported rows can.
      const co = scopeFilter('co', input);
      const cn = scopeFilter('cn', input);
      rows = db
        .prepare<unknown[], { id: string; label: string; n: number }>(
          `SELECT m.id AS id,
                  COALESCE(m.title, substr(m.content, 1, ${SNIPPET_LEN})) AS label,
                  cnt.n AS n
             FROM (
               SELECT mid, COUNT(*) AS n FROM (
                 SELECT c.old_memory_id AS mid FROM memory_conflicts c
                   JOIN memories co ON co.id = c.old_memory_id
                   JOIN memories cn ON cn.id = c.new_memory_id
                  WHERE 1=1${co.sql}${cn.sql}
                 UNION ALL
                 SELECT c.new_memory_id AS mid FROM memory_conflicts c
                   JOIN memories co ON co.id = c.old_memory_id
                   JOIN memories cn ON cn.id = c.new_memory_id
                  WHERE 1=1${co.sql}${cn.sql}
               ) GROUP BY mid
             ) cnt
             JOIN memories m ON m.id = cnt.mid
            WHERE cnt.n >= ${MIN_CONTRADICTIONS} AND ${live('m')}${f.sql}
            ORDER BY cnt.n DESC, m.id`,
        )
        .all(...co.params, ...cn.params, ...co.params, ...cn.params, ...f.params);
    } else {
      rows = db
        .prepare<unknown[], { id: string; label: string; n: number }>(
          `SELECT m.id AS id,
                  COALESCE(m.title, substr(m.content, 1, ${SNIPPET_LEN})) AS label,
                  cnt.n AS n
             FROM (
               SELECT mid, COUNT(*) AS n FROM (
                 SELECT old_memory_id AS mid FROM memory_conflicts
                 UNION ALL
                 SELECT new_memory_id AS mid FROM memory_conflicts
               ) GROUP BY mid
             ) cnt
             JOIN memories m ON m.id = cnt.mid
            WHERE cnt.n >= ${MIN_CONTRADICTIONS} AND ${live('m')}${f.sql}
            ORDER BY cnt.n DESC, m.id`,
        )
        .all(...f.params);
    }
    for (const r of rows) {
      insights.push({
        type: 'most_contradicted',
        insight: `"${r.label}" has been in ${r.n} conflicts — resolve it once, definitively.`,
        evidence: `conflict_count=${r.n}, memory_id=${r.id}`,
        memory_id: r.id,
      });
    }
  }

  // ── 4. no_evidence_decision ─────────────────────────────────────────────────
  {
    const f = scopeFilter('m', input);
    const rows = db
      .prepare<unknown[], { id: string; label: string }>(
        `SELECT m.id AS id, COALESCE(m.title, substr(m.content, 1, ${SNIPPET_LEN})) AS label
           FROM memories m
          WHERE m.document_type = 'decision' AND ${live('m')}${f.sql}
            AND NOT EXISTS (
              SELECT 1 FROM memory_links l
               WHERE l.source_memory_id = m.id
                 AND l.relation = 'derived_from'
                 AND l.valid_to IS NULL AND l.tx_expired IS NULL
            )
          ORDER BY m.id`,
      )
      .all(...f.params);
    for (const r of rows) {
      insights.push({
        type: 'no_evidence_decision',
        insight: `Decision "${r.label}" has no supporting evidence linked — record what it rests on.`,
        evidence: `memory_id=${r.id}`,
        memory_id: r.id,
      });
    }
  }

  const capped = insights.slice(0, limit);
  return { insights: capped, count: capped.length };
}
