import type Database from 'better-sqlite3';
import type { EmbeddingProvider, MemoryScope } from '../types.js';
import { handleStore } from './store.js';
import { createMemoryLink } from '../graph/memory-links.js';

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
 * stamps it provenance='reflection', and `derived_from`-links it to each valid
 * source memory.
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
  const conditions: string[] = [
    'parent_id IS NULL',
    'valid_to IS NULL',
    'tx_expired IS NULL',
  ];
  const params: unknown[] = [];

  if (input.scope !== undefined) {
    conditions.push('scope = ?');
    params.push(input.scope);
  }
  if (input.namespace !== undefined) {
    conditions.push('namespace = ?');
    params.push(input.namespace);
  }

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

  const stored = await handleStore(db, embedder, {
    content: input.insight,
    scope: input.scope,
    namespace: input.namespace,
    document_type: 'insight',
    title: input.title,
  });
  const insightId = stored.memory.id;

  // Mark the insight's provenance so it's distinguishable from manual memories.
  db.prepare("UPDATE memories SET provenance = 'reflection' WHERE id = ?").run(insightId);

  // Link the insight to each valid source memory; skip ids that don't exist.
  let linksCreated = 0;
  for (const sourceId of input.source_ids) {
    const exists = db
      .prepare<[string], { id: string }>('SELECT id FROM memories WHERE id = ?')
      .get(sourceId);
    if (!exists) continue;
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
