import type Database from 'better-sqlite3';
import path from 'node:path';
import type { EmbeddingProvider, SearchResult, SearchMode, MemoryScope } from '../types.js';
import { hybridSearch } from '../search/hybrid.js';

export async function handleVaultSearch(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: {
    vault_path: string;
    query: string;
    limit?: number;
    offset?: number;
    search_mode?: string;
    tags?: string[];
    min_confidence?: number;
  },
): Promise<{ results: SearchResult[]; total: number; truncated: boolean }> {
  const vaultName = path.basename(input.vault_path);

  const { results, total, truncated } = await hybridSearch(db, embedder, {
    query: input.query,
    scope: 'project' as MemoryScope,
    namespace: vaultName,
    limit: input.limit ?? 10,
    offset: input.offset ?? 0,
    search_mode: (input.search_mode ?? 'hybrid') as SearchMode,
    tags: input.tags,
    min_confidence: input.min_confidence,
  });

  return { results, total, truncated };
}
