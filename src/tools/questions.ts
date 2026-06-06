import type Database from 'better-sqlite3';

/**
 * Pillar 8 (T23): active "questions to ask" digest.
 *
 * Turns the passive store into an ACTIVE one — surfaces open questions / gaps
 * the graph is uniquely positioned to find, so an agent knows what to verify or
 * learn next. Purely additive READ over currently-valid (bi-temporal:
 * valid_to/tx_expired NULL), top-level (parent_id IS NULL) memories, optionally
 * scoped by scope/namespace. No schema change.
 *
 * Three graph signals, emitted in this order then capped at `limit`:
 *   1. verify — AMBIGUOUS memory_links between two in-scope memories. The graph
 *      inferred a link it isn't sure about; ask the agent to confirm it.
 *   2. gap — entities mentioned often (mention_count ≥ MIN_MENTIONS) but linked
 *      to ≤ MAX_LINKED_MEMORIES in-scope memories: referenced a lot, barely
 *      documented.
 *   3. orphan — in-scope memories with no memory_links at all (neither source
 *      nor target): disconnected, possibly stale or mis-scoped.
 *
 * Ordering within each category is deterministic (by id / name) so identical
 * graphs always yield identical digests.
 */

const DEFAULT_LIMIT = 20;
/** An entity referenced at least this often is "frequently mentioned". */
const MIN_MENTIONS = 3;
/** …but linked to at most this many memories is "under-documented". */
const MAX_LINKED_MEMORIES = 1;
/** Display label length for memories without a title. */
const SNIPPET_LEN = 60;

export type QuestionType = 'verify' | 'gap' | 'orphan';

export interface Question {
  question: string;
  type: QuestionType;
  evidence: string;
}

export interface QuestionsResult {
  questions: Question[];
  count: number;
}

/** Build the `m.scope = ? AND m.namespace = ?` tail shared by every query. */
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

export function handleQuestions(
  db: Database.Database,
  input: { scope?: string; namespace?: string; limit?: number },
): QuestionsResult {
  const limit = input.limit ?? DEFAULT_LIMIT;
  // The currently-valid, top-level predicate every "in-scope memory" satisfies.
  // Always alias-qualified — memory_links also carries valid_to/tx_expired
  // (bi-temporal v6), so a bare column would be ambiguous in the JOINs below.
  const live = (a: string) =>
    `${a}.parent_id IS NULL AND ${a}.valid_to IS NULL AND ${a}.tx_expired IS NULL`;
  const questions: Question[] = [];

  // ── 1. verify — AMBIGUOUS edges between two in-scope memories. ──────────────
  {
    const s = scopeFilter('s', input);
    const t = scopeFilter('t', input);
    const rows = db
      .prepare<unknown[], { relation: string; source_kind: string; src: string; tgt: string }>(
        `SELECT l.relation AS relation, l.source_kind AS source_kind,
                COALESCE(s.title, substr(s.content, 1, ${SNIPPET_LEN})) AS src,
                COALESCE(t.title, substr(t.content, 1, ${SNIPPET_LEN})) AS tgt
           FROM memory_links l
           JOIN memories s ON s.id = l.source_memory_id
           JOIN memories t ON t.id = l.target_memory_id
          WHERE l.confidence = 'AMBIGUOUS'
            AND l.valid_to IS NULL
            AND l.tx_expired IS NULL
            AND ${live('s')}${s.sql}
            AND ${live('t')}${t.sql}
          ORDER BY l.id`,
      )
      .all(...s.params, ...t.params);
    for (const r of rows) {
      questions.push({
        type: 'verify',
        question: `Verify whether "${r.src}" is actually related to "${r.tgt}".`,
        evidence: `relation=${r.relation}, source_kind=${r.source_kind}`,
      });
    }
  }

  // ── 2. gap — frequently mentioned but under-documented entities. ────────────
  // A correlated subquery (not an INNER JOIN) computes the live-linked count so
  // the STRONGEST gap case — a frequently-mentioned entity with ZERO currently-
  // valid linked memories — is included instead of being dropped for yielding no
  // join row (G3-F9b).
  {
    // battle-v9 rebattle-2 (HIGH cross-tenant leak): the `entities` table is
    // GLOBAL (no namespace; one row per normalized_name with a global
    // mention_count). The old query scanned it with only a global
    // `e.mention_count >= N` filter, so a forced-namespace deployment surfaced a
    // FOREIGN-tenant entity name + its global mention_count in a tenant that
    // never mentioned it (linked=0 passed the HAVING). Mirror the graph/
    // communities fix: when a scope/namespace IS in play, gate the entity to the
    // tenant subgraph with an EXISTS over the caller's own memories (live OR
    // retired — the strongest gap case is "mentioned, but every link is now
    // retired"). The unforced path keeps the exact original query (no gate), so
    // mention_count semantics and the 0-live-link surfacing are unchanged.
    const f = scopeFilter('m', input); // linked subquery (alias m)
    const scoped = input.namespace !== undefined || input.scope !== undefined;
    const h = scopeFilter('m2', input); // tenant-membership gate (alias m2)
    const gate = scoped
      ? `AND EXISTS (SELECT 1 FROM memory_entities me2
                       JOIN memories m2 ON m2.id = me2.memory_id
                      WHERE me2.entity_id = e.id${h.sql})`
      : '';
    const rows = db
      .prepare<unknown[], { name: string; mention_count: number; linked: number }>(
        `SELECT e.name AS name, e.mention_count AS mention_count,
                (SELECT COUNT(DISTINCT m.id)
                   FROM memory_entities me
                   JOIN memories m ON m.id = me.memory_id
                  WHERE me.entity_id = e.id
                    AND ${live('m')}${f.sql}) AS linked
           FROM entities e
          WHERE e.mention_count >= ${MIN_MENTIONS}
          ${gate}
          GROUP BY e.id
         HAVING linked <= ${MAX_LINKED_MEMORIES}
          ORDER BY e.name`,
      )
      .all(...f.params, ...(scoped ? h.params : []));
    for (const r of rows) {
      questions.push({
        type: 'gap',
        question: `You reference "${r.name}" often but have little stored about it — capture what it is.`,
        evidence: `mention_count=${r.mention_count}, linked_memories=${r.linked}`,
      });
    }
  }

  // ── 3. orphan — in-scope memories with no links (neither side). ─────────────
  {
    const f = scopeFilter('m', input);
    const rows = db
      .prepare<unknown[], { id: string; label: string }>(
        `SELECT m.id AS id, COALESCE(m.title, substr(m.content, 1, ${SNIPPET_LEN})) AS label
           FROM memories m
          WHERE ${live('m')}${f.sql}
            AND NOT EXISTS (SELECT 1 FROM memory_links l WHERE l.source_memory_id = m.id)
            AND NOT EXISTS (SELECT 1 FROM memory_links l WHERE l.target_memory_id = m.id)
          ORDER BY m.id`,
      )
      .all(...f.params);
    for (const r of rows) {
      questions.push({
        type: 'orphan',
        question: `"${r.label}" has no connections — is it still relevant, or mis-scoped?`,
        evidence: `memory_id=${r.id}`,
      });
    }
  }

  const capped = questions.slice(0, limit);
  return { questions: capped, count: capped.length };
}
