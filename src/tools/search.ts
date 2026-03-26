import type Database from 'better-sqlite3';
import type {
  EmbeddingProvider,
  SearchOptions,
  SearchResult,
  SearchMode,
  MemoryScope,
  AccessLevel,
  TemporalDecayConfig,
} from '../types.js';
import { hybridSearch } from '../search/hybrid.js';

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
}

export async function handleSearch(
  db: Database.Database,
  embedder: EmbeddingProvider,
  input: SearchInput,
): Promise<{ results: SearchResult[]; total: number }> {
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
  };

  const results = await hybridSearch(db, embedder, options);
  return { results, total: results.length };
}
