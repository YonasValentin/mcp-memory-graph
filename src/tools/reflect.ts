import type Database from 'better-sqlite3';
import type { EmbeddingProvider, MemoryScope } from '../types.js';
import { handleStore } from './store.js';
import { ACCESS_LEVELS } from '../constants/enums.js';
import { createMemoryLink } from '../graph/memory-links.js';
import { liveConditions, scopeConditions, accessCeilingCondition } from '../db/predicates.js';
import { reconcileBlocked } from '../lib/reconcile-guard.js';
import { forcedNamespace } from '../lib/tenancy.js';

interface ReflectInput {
  /** 'gather' (default): collect reflection material. 'store': persist a synthesized insight. */
  mode?: 'gather' | 'store';
  scope?: MemoryScope;
  namespace?: string;
  /** gather: max material rows (default 10). */
  limit?: number;
  /** store: the agent-synthesized higher-level insight text. */
  insight?: string;
  /** store: ids of the source memories the insight was derived from. */
  source_ids?: string[];
  /** store: optional title for the stored insight. */
  title?: string;
  /**
   * RBAC §6 (re-battle-5, the 9th instance): gather is a corpus CONTENT read
   * (it returns id+title+content snippets) structurally identical to
   * memory_list — so it must honour the principal egress ceiling. The allow-list
   * of levels the caller may receive; undefined → legacy/local/full-clearance.
   */
  access_level_ceiling?: string[];
}

interface ReflectMaterial {
  id: string;
  title: string | null;
  snippet: string;
  importance_score: number;
}

interface GatherResult {
  mode: 'gather';
  material: ReflectMaterial[];
  count: number;
  instruction: string;
}

interface StoreResult {
  mode: 'store';
  insight_id: string;
  provenance: 'reflection';
  links_created: number;
}

interface ReflectError {
  error: string;
}

type ReflectResult = GatherResult | StoreResult | ReflectError;

/** Default number of reflection-material rows surfaced in gather mode. */
const DEFAULT_LIMIT = 10;

/** Characters of content kept in each material snippet. */
const SNIPPET_CHARS = 200;

type MaterialRow = {
  id: string;
  title: string | null;
  content: string;
  importance_score: number;
};

/**
 * Generative-Agents-style reflection — agent-driven, with NO LLM in the server.
 *
 * `gather` (default) does the cheap local work: SELECT the most
 * reflection-worthy top-level, currently-valid memories (high importance ×
 * recent) and return them as material plus an instruction telling the agent to
 * synthesize 1–3 higher-level insights and call back with mode 'store'.
 *
 * `store` persists an agent-synthesized insight via {@link handleStore},
 * stamps it provenance='reflection', and `derived_from`-links it to each
 * currently-valid, top-level source memory. When the insight near-duplicates an
 * existing memory (handleStore NOOP) it bails with an error rather than
 * corrupting that memory's provenance/graph.
 */
export async function handleReflect(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: ReflectInput = {},
): Promise<ReflectResult> {
  const mode = input.mode ?? 'gather';

  if (mode === 'store') {
    return storeInsight(db, embedder, input);
  }

  return gatherMaterial(db, input);
}

function gatherMaterial(db: Database.Database, input: ReflectInput): GatherResult {
  const limit = input.limit ?? DEFAULT_LIMIT;

  // Top-level, currently-valid memories only (bi-temporal filter), ranked by
  // importance then recency — the reflection-worthiness ordering.
  const scope = scopeConditions(input);
  // §6: an over-ceiling row's content must never reach a sub-ceiling principal
  // via the reflection material (the 9th-instance leak). No-op when undefined.
  const ceil = accessCeilingCondition(input.access_level_ceiling);
  const conditions: string[] = [
    ...liveConditions({ topLevelOnly: true }),
    ...scope.conditions,
    ...ceil.conditions,
  ];
  const params: unknown[] = [...scope.params, ...ceil.params];

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  const rows = db
    .prepare<unknown[], MaterialRow>(
      `SELECT id, title, content, importance_score
         FROM memories ${whereClause}
        ORDER BY importance_score DESC, COALESCE(last_accessed_at, created_at) DESC
        LIMIT ?`,
    )
    .all(...params, limit);

  const material: ReflectMaterial[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    snippet: row.content.slice(0, SNIPPET_CHARS),
    importance_score: row.importance_score,
  }));

  return {
    mode: 'gather',
    material,
    count: material.length,
    instruction:
      'Synthesize 1–3 higher-level insights from the material above — patterns, ' +
      'themes, or conclusions that span multiple memories rather than restating any ' +
      'single one. For each insight, call memory_reflect again with mode:"store", ' +
      'the insight text, and source_ids listing the material ids it was derived from.',
  };
}

async function storeInsight(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: ReflectInput,
): Promise<StoreResult | ReflectError> {
  if (!input.insight || input.insight.trim().length === 0) {
    return { error: 'store mode requires a non-empty "insight"' };
  }
  if (!input.source_ids || input.source_ids.length === 0) {
    return { error: 'store mode requires a non-empty "source_ids" array' };
  }

  // Inherit the most-restrictive access_level of the sources so a synthesized
  // insight is never classified MORE openly than the material it was derived
  // from. handleStore() otherwise falls back to 'public' (store.ts) — the Zod
  // tool-layer default 'internal' is bypassed on this direct call. Floor at
  // 'internal' so a reflection is never 'public'.
  const internalRank = ACCESS_LEVELS.indexOf('internal');
  const levelRank = (level: string): number => {
    const i = ACCESS_LEVELS.indexOf(level as (typeof ACCESS_LEVELS)[number]);
    return i < 0 ? internalRank : i;
  };
  const inheritedRank = input.source_ids.reduce((max, id) => {
    const row = db
      .prepare<[string], { access_level: string }>('SELECT access_level FROM memories WHERE id = ?')
      .get(id);
    return row ? Math.max(max, levelRank(row.access_level)) : max;
  }, internalRank);
  const inheritedLevel = ACCESS_LEVELS[inheritedRank];

  const stored = await handleStore(
    db,
    embedder,
    {
      content: input.insight,
      scope: input.scope,
      namespace: input.namespace,
      document_type: 'insight',
      title: input.title,
      access_level: inheritedLevel,
    },
    undefined,
    // §6 (RB-8): thread the principal ceiling so the insight's conflict scan can't
    // NOOP-echo (or retire) an over-ceiling same-namespace near-duplicate — the
    // memory_store registration passes this, storeInsight must too.
    input.access_level_ceiling,
  );

  // On the default on_conflict='add' path handleStore returns NOOP (stored:false)
  // when the insight near-duplicates an EXISTING memory, handing back that
  // memory's id/row. Writing provenance + derived_from edges to it would corrupt
  // an unrelated (possibly manual) memory's graph, so bail instead (G3-F4).
  if (!stored.stored) {
    return {
      error: `insight duplicates existing memory ${stored.memory.id} — not stored as a reflection`,
    };
  }

  const insightId = stored.memory.id;

  // Mark the insight's provenance so it's distinguishable from manual memories.
  db.prepare("UPDATE memories SET provenance = 'reflection' WHERE id = ?").run(insightId);

  // Link the insight to each currently-valid, top-level source memory. Skipping
  // invalidated (valid_to set), tx-expired, and chunk-child (parent_id set) rows
  // keeps the derived_from graph consistent with the 'valid source' docstring
  // and with gather mode's own bi-temporal filter (G3-F5).
  let linksCreated = 0;
  for (const sourceId of input.source_ids) {
    const exists = db
      .prepare<[string], { namespace: string | null; access_level: string }>(
        `SELECT namespace, access_level FROM memories
          WHERE id = ?
            AND valid_to IS NULL
            AND tx_expired IS NULL
            AND parent_id IS NULL`,
      )
      .get(sourceId);
    if (!exists) continue;
    // RBAC §6 (RB-9): a source_id pointing at a FOREIGN-namespace or OVER-ceiling
    // row must be treated EXACTLY like a non-existent id — never linked (a same-ns
    // over-ceiling derived_from edge would persist) and never counted. Counting it
    // (links_created++) even on a refused cross-ns edge was a 1-bit existence /
    // liveness oracle defeating the by-id non-confirmation invariant. Mirrors
    // import/store; unforced single-user (forcedNamespace + ceiling undefined) is
    // unchanged.
    if (reconcileBlocked(exists, forcedNamespace(), input.access_level_ceiling)) continue;
    createMemoryLink(db, {
      sourceId: insightId,
      targetId: sourceId,
      relation: 'derived_from',
      confidence: 'EXTRACTED',
      confidenceScore: 1,
      sourceKind: 'typed',
    });
    linksCreated += 1;
  }

  return {
    mode: 'store',
    insight_id: insightId,
    provenance: 'reflection',
    links_created: linksCreated,
  };
}
