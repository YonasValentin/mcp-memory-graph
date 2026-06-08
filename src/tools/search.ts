import type Database from 'better-sqlite3';
import type {
  EmbeddingProvider,
  SearchOptions,
  SearchResult,
  SearchMode,
  MemoryScope,
  AccessLevel,
  TemporalDecayConfig,
  DetailLevel,
} from '../types.js';
import { hybridSearch, toSummary, toIdOnly } from '../search/hybrid.js';
import { CrossEncoderReranker, type Reranker } from '../search/reranker.js';
import { recordAccess, recordSearch } from '../db/repository.js';
import { getComputeGovernor } from '../lib/compute-governor.js';

// Module-level singleton so the cross-encoder model loads at most once across
// requests. Lazily constructed only when reranking is requested — never touched
// (and thus never downloads a model) on the default search path.
let rerankerSingleton: Reranker | null = null;
function getReranker(): Reranker {
  if (!rerankerSingleton) {
    rerankerSingleton = new CrossEncoderReranker();
  }
  return rerankerSingleton;
}

interface SearchInput {
  query: string;
  scope?: MemoryScope;
  namespace?: string;
  department?: string;
  document_type?: string;
  tags?: string[];
  access_level?: AccessLevel;
  language?: string;
  limit?: number;
  offset?: number;
  search_mode?: SearchMode;
  temporal_decay?: TemporalDecayConfig;
  date_from?: string;
  date_to?: string;
  min_confidence?: number;
  as_of?: string;
  use_graph?: boolean;
  rerank?: boolean;
  rerank_top_n?: number;
  detail_level?: DetailLevel;
  max_tokens?: number;
}

export async function handleSearch(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: SearchInput,
): Promise<{ results: unknown[]; total: number; truncated: boolean; detail_level: string; token_budget?: { limit: number; estimated_used: number } }> {
  const options: SearchOptions = {
    query: input.query,
    scope: input.scope,
    namespace: input.namespace,
    department: input.department,
    document_type: input.document_type,
    tags: input.tags,
    access_level: input.access_level,
    language: input.language,
    limit: input.limit ?? 10,
    offset: input.offset ?? 0,
    search_mode: input.search_mode ?? 'hybrid',
    temporal_decay: input.temporal_decay,
    date_from: input.date_from,
    date_to: input.date_to,
    min_confidence: input.min_confidence,
    as_of: input.as_of,
    use_graph: input.use_graph,
    rerank: input.rerank,
    rerank_top_n: input.rerank_top_n,
  };

  // M6.2 compute governor: reranking runs a cross-encoder over the candidate
  // set — the heaviest per-search op. When over budget (throttle/block mode) the
  // governor withholds it and we drop to the FREE vector+FTS RRF path. Default
  // 'off' mode always allows, so this is a no-op unless the governor is enabled.
  const rerankPreflight = input.rerank ? getComputeGovernor().preflight('rerank') : null;
  const doRerank = input.rerank === true && (rerankPreflight?.allow ?? true);

  const { results, total, truncated } = doRerank
    ? await hybridSearch(db, embedder, options, getReranker())
    : await hybridSearch(db, embedder, { ...options, rerank: false });

  if (results.length > 0) {
    recordAccess(
      db,
      results.map((r, index) => ({
        memory_id: r.memory.id,
        access_type: 'search' as const,
        query_text: input.query,
        result_rank: index,
        score: r.score,
      })),
    );
  }

  // v15 search telemetry — one row per user-facing search, partitioned by the
  // EFFECTIVE (scope, namespace), feeding tenancy-scoped knowledge-gap detection
  // in the dream cycle. Best-effort (never throws into the search path).
  recordSearch(db, {
    query: input.query,
    results_count: total,
    top_confidence: results[0]?.score,
    scope: input.scope,
    namespace: input.namespace,
  });

  const detailLevel = input.detail_level ?? 'summary';
  let projected: unknown[];

  switch (detailLevel) {
    case 'ids_only':
      projected = results.map(toIdOnly);
      break;
    case 'summary':
      projected = results.map(toSummary);
      break;
    case 'full':
    default:
      projected = results;
      break;
  }

  // Token budgeting
  if (input.max_tokens) {
    const CHARS_PER_TOKEN = 3.4; // ~4 chars/token with 15% safety margin
    const maxChars = input.max_tokens * CHARS_PER_TOKEN;
    let totalChars = 0;
    const budgeted: unknown[] = [];

    for (const result of projected) {
      const resultChars = JSON.stringify(result).length;
      if (totalChars + resultChars > maxChars && budgeted.length > 0) {
        break;
      }
      budgeted.push(result);
      totalChars += resultChars;
    }

    return {
      results: budgeted,
      total,
      truncated: budgeted.length < projected.length || truncated,
      detail_level: detailLevel,
      token_budget: {
        limit: input.max_tokens,
        estimated_used: Math.ceil(totalChars / CHARS_PER_TOKEN),
      },
    };
  }

  return { results: projected, total, truncated, detail_level: detailLevel };
}
