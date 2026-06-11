// Y1/E1/E2: enum unions are DERIVED from the canonical tuples in
// constants/enums.ts so the TS types and the Zod validators share one source.
import type {
  SCOPES,
  ACCESS_LEVELS,
  SEARCH_MODES,
  CONTENT_TYPES,
  ENTITY_TYPES,
  SORT_FIELDS,
  LEARNING_CATEGORIES,
} from './constants/enums.js';

export type MemoryScope = (typeof SCOPES)[number];

export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export type SearchMode = (typeof SEARCH_MODES)[number];

export type DecayType = 'exponential' | 'linear' | 'none' | 'forgetting';

export type ContentType = (typeof CONTENT_TYPES)[number];

export type SortField = (typeof SORT_FIELDS)[number];

export type SortOrder = 'asc' | 'desc';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export type CondensationLevel = 'full' | 'summary' | 'one_liner';

export type EntityType = (typeof ENTITY_TYPES)[number];

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
  /** Bi-temporal validity start (= created_at at insert). */
  valid_from: string | null;
  /** When the fact stopped being true (NULL = live). Stamped by forget/supersede — why a memory left default recall. */
  valid_to: string | null;
  /** When a newer memory superseded this one (NULL = never superseded). */
  superseded_at: string | null;
  access_count: number;
  last_accessed_at: string | null;
  importance_score: number;
  confidence_score: number;
  /** How this memory came to exist (manual, vault_sync, reflection, …). */
  provenance: ProvenanceType;
  /** Which agent wrote this memory (multi-agent attribution), distinct from `author`. */
  agent_id: string | null;
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
  /** Bi-temporal validity (schema v6): when the fact was true; superseded_at stamps replacement by a newer memory. */
  valid_from?: string | null;
  valid_to?: string | null;
  superseded_at?: string | null;
  /** How this memory came to exist (manual, vault_sync, reflection, …). */
  provenance?: string;
  /** Which agent wrote this memory (multi-agent attribution), distinct from `author`. */
  agent_id?: string | null;
  /** M2 signed-provenance envelope (NULL = unsigned — today's default). */
  content_hash?: string | null;
  signature?: string | null;
  pubkey?: string | null;
  signed_at?: string | null;
  /**
   * M3.3 change-propagation. 'stale' when a source/dependency this memory was
   * derived from has been retired or edited and the memory has not been
   * re-confirmed. NULL = never flagged (today's behaviour).
   */
  revalidation_status?: string | null;
  /** M6.4 which embedder produced this row's vector (NULL = deployment default). */
  embedding_model?: string | null;
  embedding_dim?: number | null;
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
  /** Explicit importance 0-1 (governance/criticality); falls back to a content-derived signal. */
  importance_score?: number;
  /** Identifier of the writing agent for multi-agent attribution (distinct from author). */
  agent_id?: string;
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
  importance_score?: number;
}

export interface SearchOptions {
  query: string;
  scope?: MemoryScope;
  namespace?: string;
  department?: string;
  document_type?: string;
  tags?: string[];
  access_level?: AccessLevel;
  /**
   * RBAC v1 §6 — egress ceiling: when set, only rows whose `access_level` is IN
   * this allow-list are returned (a MAX, distinct from the positive single-level
   * `access_level` filter above — both apply as an intersection). Threaded from
   * the tenancy chokepoint via {@link import('../lib/tenancy.js').principalAccessCeiling};
   * undefined leaves the result set unchanged (legacy/local modes).
   */
  access_level_ceiling?: AccessLevel[];
  language?: string;
  limit: number;
  /** Pagination start; defaults to 0 when omitted (an omitted offset means "from the start"). */
  offset?: number;
  search_mode: SearchMode;
  temporal_decay?: TemporalDecayConfig;
  date_from?: string;
  date_to?: string;
  min_confidence?: number;
  /** Trust floor (M2.4): drop results whose groundedness < this. Distinct from
   *  min_confidence (relevance). */
  min_groundedness?: number;
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
  /** Trust signal (M2.4) — distinct from `confidence` (pure relevance). Folds
   *  the stored confidence_score, provenance tier, and recency into [0,1]. */
  groundedness: number;
  groundedness_level: ConfidenceLevel;
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
  /**
   * Releases any native resources (e.g. the onnxruntime InferenceSession behind
   * the real transformers.js provider) for graceful shutdown. Optional —
   * mock/in-memory providers have nothing to free. Idempotent (BATTLE-V3 P14).
   */
  dispose?(): Promise<void>;
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
  /** Whole-DB size (page_count * page_size). null on a namespace-forced
   *  deployment, where a whole-DB metric would leak other tenants' write volume
   *  (battle-v14 F4). */
  database_size_bytes: number | null;
  expired_count: number;
  /** M6.2 compute-governor window snapshot — present only when the governor is
   *  enabled (MCP_COMPUTE_GOVERNOR_MODE != off), so warn mode is observable. */
  compute_window?: {
    mode: string;
    capacity: number;
    refill_per_sec: number;
    remaining: number;
    window_seconds: number;
    degraded: boolean;
  };
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
  /** RBAC v1 §6 — egress ceiling: only rows with access_level IN this allow-list. */
  access_level_ceiling?: AccessLevel[];
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
  /** Number of memories in this page. */
  count: number;
  /** Total live, top-level memories matching the filter (across all pages). */
  total: number;
  /** True when more memories remain beyond this page. */
  has_more: boolean;
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
  /**
   * Incremental-ingest outcome (keyed on `source`): 'new' = first ingest of
   * this source (or no source given), 'unchanged' = same source + identical
   * content, skipped (no re-embed/insert), 'updated' = same source, changed
   * content → the parent was versioned in place and its chunks replaced.
   */
  status?: 'new' | 'unchanged' | 'updated';
  /** True when the content was identical to the last ingest and nothing was written. */
  skipped?: boolean;
}

// ── Vault Integration Types ─────────────────────────────────────────────

export interface VaultSyncMeta {
  vault_path: string;
  file_path: string;
  mtime_ms: number;
  memory_id: string;
  synced_at: string;
  /** M6.1 sha256 of the raw file bytes — the authoritative change signal (mtime
   * is only a cheap pre-filter; a git checkout rewrites mtime but not content). */
  content_hash?: string | null;
}

export interface VaultSyncResult {
  vault_path: string;
  vault_name: string;
  files_added: number;
  files_updated: number;
  files_deleted: number;
  files_unchanged: number;
  files_errored: number;
  /**
   * Files quarantined because their body carried git conflict markers (a
   * sloppily-resolved 3-way merge) — skipped, never indexed. Mirrors
   * RebuildResult.conflicted: the two import paths apply the same guard.
   */
  conflicted: number;
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
  /** M6.1 sha256 of the raw file bytes; computed lazily for new/changed files. */
  contentHash?: string;
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
  type: (typeof LEARNING_CATEGORIES)[number];
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
    /** Mirror every top-level memory write to a per-memory .md file. */
    write_through: boolean;
  };
  /** Auto-capture (Claude Code hooks) preference from the init wizard. */
  capture: {
    auto_capture: boolean;
  };
}
