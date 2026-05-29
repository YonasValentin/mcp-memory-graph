export type MemoryScope = 'global' | 'project' | 'user' | 'team' | 'department';

export type AccessLevel = 'public' | 'internal' | 'confidential' | 'restricted';

export type SearchMode = 'hybrid' | 'vector' | 'keyword';

export type DecayType = 'exponential' | 'linear' | 'none' | 'forgetting';

export type ContentType = 'text' | 'markdown' | 'code' | 'legal' | 'structured';

export type SortField = 'created_at' | 'updated_at' | 'title' | 'importance_score' | 'confidence_score' | 'access_count';

export type SortOrder = 'asc' | 'desc';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type CondensationLevel = 'full' | 'summary' | 'one_liner';

export type EntityType = 'person' | 'project' | 'tool' | 'concept' | 'organization' | 'file' | 'package' | 'pattern';

export type ProvenanceType = 'manual' | 'vault_sync' | 'learning_extraction' | 'consolidation_merge' | 'import' | 'ingest' | 'reflection';

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
  access_count: number;
  last_accessed_at: string | null;
  importance_score: number;
  confidence_score: number;
  /** How this memory came to exist (manual, vault_sync, reflection, …). */
  provenance: ProvenanceType;
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
  access_count: number;
  last_accessed_at: string | null;
  importance_score: number;
  confidence_score: number;
  /** Spaced-repetition stability: grows on access, drives the forgetting curve. */
  stability: number;
  /** How this memory came to exist (manual, vault_sync, reflection, …). */
  provenance?: string;
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
  confidence_score?: number;
  /**
   * mem0-style write policy on conflict. 'add' (default) preserves today's
   * behaviour (NOOP on exact dup, otherwise ADD). 'update' merges into a
   * superseded-band match; 'supersede' retires the conflicting match and adds
   * the new memory. UPDATE/DELETE are strictly opt-in.
   */
  on_conflict?: 'add' | 'update' | 'supersede';
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
  /** ISO-8601 instant: return what was valid at this point in time instead of currently-valid. */
  as_of?: string;
  /**
   * Opt-in HippoRAG multi-hop recall. When true, seed entities are linked from
   * the query and Personalized PageRank fuses graph-reachable memories into the
   * results as a third ranker. Default false — leaves the vector+keyword path
   * unchanged.
   */
  use_graph?: boolean;
  /**
   * Opt-in local cross-encoder reranking of the top-N candidates. When true and
   * a reranker is supplied to {@link hybridSearch}, the top `rerank_top_n`
   * results are reordered by joint (query, doc) relevance — the biggest
   * precision win for a weak bi-encoder. Default false — leaves fused order
   * unchanged.
   */
  rerank?: boolean;
  /** How many top candidates to rerank (default 50). Ignored unless `rerank`. */
  rerank_top_n?: number;
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
  age_days: number;
  freshness_warning: string | null;
}

export type DetailLevel = 'summary' | 'full' | 'ids_only';

export interface SearchResultSummary {
  id: string;
  title: string | null;
  snippet: string;
  tags: string[];
  score: number;
  confidence_level: ConfidenceLevel;
  importance_score: number;
  freshness_warning?: string;
}

export interface SearchResultIdOnly {
  id: string;
  title: string | null;
  score: number;
}

export interface ManifestEntry {
  id: string;
  title: string | null;
  scope: MemoryScope;
  namespace: string | null;
  document_type: string | null;
  tags: string[];
  importance_score: number;
  access_count: number;
  age_days: number;
  updated_at: string;
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
  /** ISO-8601 instant: return what was valid at this point in time instead of currently-valid. */
  as_of?: string;
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

// ── Vault Integration Types ─────────────────────────────────────────────

export interface VaultSyncMeta {
  vault_path: string;
  file_path: string;
  mtime_ms: number;
  memory_id: string;
  synced_at: string;
}

export interface VaultSyncResult {
  vault_path: string;
  vault_name: string;
  files_added: number;
  files_updated: number;
  files_deleted: number;
  files_unchanged: number;
  files_errored: number;
  total_memories: number;
  errors: string[];
  duration_ms: number;
}

export interface VaultStatus {
  vault_path: string;
  vault_name: string;
  total_files: number;
  synced_files: number;
  pending_files: number;
  changed_files: number;
  deleted_files: number;
  memory_count: number;
  last_synced_at: string | null;
}

export interface ParsedVaultFile {
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  links: string[];
  relativePath: string;
  absolutePath: string;
  mtimeMs: number;
}

export interface VaultFileEntry {
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
}

// ── Self-Improvement Types ──────────────────────────────────────────────

export interface AccessLogEntry {
  memory_id: string;
  access_type: 'search' | 'get' | 'related';
  query_text?: string;
  result_rank?: number;
  score?: number;
}

export interface IngestSourceRecord {
  id: string;
  source_path: string;
  source_hash: string;
  memory_id: string;
  chunk_ids: string | null;
  content_length: number;
  ingested_at: string;
  last_checked_at: string;
  status: 'current' | 'stale' | 'deleted';
}

export interface ConsolidationReport {
  duplicates_found: number;
  duplicates_merged: number;
  expired_pruned: number;
  low_quality_pruned: number;
  /** Memories pruned by the opt-in forgetting-curve pass (0 unless `forgetting_floor` set). */
  forgetting_pruned: number;
  scores_updated: number;
  /** True execution failures only — see `knowledge_gaps` for missing-knowledge signals. */
  errors: string[];
  /** Repeated zero-result searches surfaced from the search log. */
  knowledge_gaps: string[];
  duration_ms: number;
}

export interface ExtractedLearning {
  type: 'decision' | 'pattern' | 'error_fix' | 'convention';
  title: string;
  content: string;
  tags: string[];
  confidence: number;
}

export interface ExtractLearningsResult {
  learnings: ExtractedLearning[];
  stored_count: number;
  memory_ids: string[];
}

export interface ServerConfig {
  defaults: {
    scope: MemoryScope;
    namespace: string;
  };
  projects: Array<{
    path: string;
    namespace: string;
    watch: string[];
  }>;
  consolidation: {
    similarity_threshold: number;
    prune_after_days: number;
    min_importance_to_keep: number;
    max_operations: number;
  };
  hooks: {
    extract_on_compact: boolean;
    extract_on_session_end: boolean;
    track_searches: boolean;
  };
  extraction: {
    categories: ExtractedLearning['type'][];
    min_confidence: number;
  };
  /** Where the memory database lives (set by `memory init`). */
  storage: {
    db_path?: string;
  };
  /** Solo-vs-team sharing config written by the interactive init wizard. */
  sharing: {
    mode: 'solo' | 'team';
    /** Commit the graph artifact to git so teammates share recall. */
    commit_graph: boolean;
    /** Optional remote MCP endpoint for team-shared memory. */
    remote_endpoint?: string;
  };
  /** Optional Markdown vault for round-tripping memories to/from files. */
  vault: {
    path?: string;
  };
  /** Auto-capture (Claude Code hooks) preference from the init wizard. */
  capture: {
    auto_capture: boolean;
  };
}
