export type MemoryScope = 'global' | 'project' | 'user' | 'team' | 'department';

export type AccessLevel = 'public' | 'internal' | 'confidential' | 'restricted';

export type SearchMode = 'hybrid' | 'vector' | 'keyword';

export type DecayType = 'exponential' | 'linear' | 'none';

export type ContentType = 'text' | 'markdown' | 'code' | 'legal' | 'structured';

export type SortField = 'created_at' | 'updated_at' | 'title';

export type SortOrder = 'asc' | 'desc';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface Memory {
  readonly id: string;
  scope: MemoryScope;
  namespace: string | null;
  title: string | null;
  content: string;
  document_type: string | null;
  source: string | null;
  author: string | null;
  department: string | null;
  tags: string[];
  access_level: AccessLevel;
  language: string;
  metadata: Record<string, unknown> | null;
  parent_id: string | null;
  chunk_index: number | null;
  version: number;
  readonly created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface MemoryRow {
  id: string;
  scope: string;
  namespace: string | null;
  title: string | null;
  content: string;
  document_type: string | null;
  source: string | null;
  author: string | null;
  department: string | null;
  tags: string | null;
  access_level: string;
  language: string;
  metadata: string | null;
  parent_id: string | null;
  chunk_index: number | null;
  version: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  rowid?: number;
}

export interface MemoryInput {
  content: string;
  title?: string;
  scope?: MemoryScope;
  namespace?: string;
  document_type?: string;
  source?: string;
  author?: string;
  department?: string;
  tags?: string[];
  access_level?: AccessLevel;
  language?: string;
  metadata?: Record<string, unknown>;
  expires_at?: string;
}

export interface MemoryUpdate {
  content?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  expires_at?: string | null;
  changed_by?: string;
}

export interface SearchOptions {
  query: string;
  scope?: MemoryScope;
  namespace?: string;
  department?: string;
  document_type?: string;
  tags?: string[];
  access_level?: AccessLevel;
  language?: string;
  limit: number;
  offset: number;
  search_mode: SearchMode;
  temporal_decay?: TemporalDecayConfig;
  date_from?: string;
  date_to?: string;
  min_confidence?: number;
}

export interface TemporalDecayConfig {
  type: DecayType;
  half_life_days?: number;
  max_age_days?: number;
}

export interface SearchResult {
  memory: Memory;
  score: number;
  confidence: number;
  confidence_level: ConfidenceLevel;
  match_type: 'vector' | 'keyword' | 'hybrid';
}

export interface ChunkingOptions {
  content_type: ContentType;
  chunk_size: number;
  overlap: number;
}

export interface ChunkResult {
  content: string;
  start_offset: number;
  end_offset: number;
  chunk_index: number;
}

export interface EmbeddingProvider {
  readonly dimensions: number;
  readonly modelName: string;
  initialize(): Promise<void>;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  isReady(): boolean;
}

export interface VersionRecord {
  id: string;
  memory_id: string;
  content: string;
  title: string | null;
  metadata: string | null;
  version: number;
  changed_by: string | null;
  changed_at: string;
}

export interface MemoryStats {
  total_memories: number;
  total_chunks: number;
  total_documents: number;
  by_scope: Record<string, number>;
  by_department: Record<string, number>;
  by_document_type: Record<string, number>;
  total_content_bytes: number;
  database_size_bytes: number;
  expired_count: number;
}

export interface ListOptions {
  scope?: MemoryScope;
  namespace?: string;
  department?: string;
  document_type?: string;
  limit: number;
  offset: number;
  sort_by: SortField;
  sort_order: SortOrder;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ExportData {
  version: string;
  exported_at: string;
  count: number;
  memories: Memory[];
}

export interface IngestOptions {
  content: string;
  title?: string;
  source?: string;
  document_type?: string;
  content_type?: ContentType;
  chunk_size?: number;
  chunk_overlap?: number;
  scope?: MemoryScope;
  namespace?: string;
  department?: string;
  author?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface IngestResult {
  parent_id: string;
  chunk_count: number;
  chunk_ids: string[];
}
