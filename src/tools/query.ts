import type Database from 'better-sqlite3';
import type { EmbeddingProvider, MemoryScope, AccessLevel } from '../types.js';
import { queryGraph, type GraphQueryResult } from '../graph/graph-query.js';

interface QueryInput {
  query: string;
  max_tokens?: number;
  max_hops?: number;
  seed_limit?: number;
  scope?: MemoryScope;
  namespace?: string;
  /** RBAC §6 egress ceiling (allow-list of permitted access levels). */
  access_level_ceiling?: AccessLevel[];
}

/**
 * `memory_query` — graphify-style token-budgeted graph traversal. Seeds from
 * hybrid search, walks the persistent `memory_links` graph (hub-avoiding), and
 * returns a TIGHT, relevant subgraph rendered into a token-budgeted `context`
 * string plus structured `nodes` — instead of flooding the agent's context.
 */
export async function handleQuery(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: QueryInput,
): Promise<GraphQueryResult> {
  return queryGraph(db, embedder, {
    query: input.query,
    max_tokens: input.max_tokens,
    max_hops: input.max_hops,
    seed_limit: input.seed_limit,
    scope: input.scope,
    namespace: input.namespace,
    access_level_ceiling: input.access_level_ceiling,
  });
}
