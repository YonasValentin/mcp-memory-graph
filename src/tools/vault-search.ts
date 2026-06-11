import type Database from 'better-sqlite3';
import path from 'node:path';
import type { EmbeddingProvider, SearchResult, SearchMode, MemoryScope, AccessLevel } from '../types.js';
import { hybridSearch } from '../search/hybrid.js';

export async function handleVaultSearch(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: {
    vault_path: string;
    query: string;
    scope?: MemoryScope;
    namespace?: string;
    limit?: number;
    offset?: number;
    search_mode?: string;
    tags?: string[];
    min_confidence?: number;
    // RBAC §6 (battle F3): a principal's egress ceiling, threaded by server.ts's
    // scopedRead wrapper. undefined in legacy/local modes → no-op, byte-identical.
    access_level_ceiling?: AccessLevel[];
  },
): Promise<{ results: SearchResult[]; total: number; truncated: boolean }> {
  // Default the namespace to the vault folder name (back-compat), but honour an
  // explicit override so callers whose memories live in a differently-named
  // namespace (the common post-export case) can still find them.
  const namespace = input.namespace ?? path.basename(input.vault_path);

  const { results, total, truncated } = await hybridSearch(db, embedder, {
    query: input.query,
    scope: input.scope ?? ('project' as MemoryScope),
    namespace,
    limit: input.limit ?? 10,
    offset: input.offset ?? 0,
    search_mode: (input.search_mode ?? 'hybrid') as SearchMode,
    tags: input.tags,
    min_confidence: input.min_confidence,
    access_level_ceiling: input.access_level_ceiling,
  });

  return { results, total, truncated };
}
