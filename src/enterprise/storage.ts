// ── Storage Backend Abstraction ────────────────────────────────────────────
//
// Allows swapping between SQLite (local/dev) and PostgreSQL (production).

import type {
  Memory, MemoryRow, MemoryInput, MemoryUpdate, SearchOptions,
  SearchResult, ListOptions, PaginatedResult, MemoryStats,
  ExportData, VersionRecord, EmbeddingProvider, IngestOptions, IngestResult,
} from '../types.js';
import type { TenantContext } from './tenant.js';

export interface StorageBackend {
  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;

  // CRUD
  storeMemory(ctx: TenantContext, input: MemoryInput, embedding: Float32Array): Promise<Memory>;
  getMemory(ctx: TenantContext, id: string): Promise<Memory | null>;
  updateMemory(ctx: TenantContext, id: string, updates: MemoryUpdate, newEmbedding?: Float32Array): Promise<Memory | null>;
  deleteMemory(ctx: TenantContext, id: string): Promise<boolean>;
  deleteMemoriesByFilter(ctx: TenantContext, filter: DeleteFilter): Promise<number>;

  // Search
  hybridSearch(ctx: TenantContext, options: SearchOptions, queryEmbedding: Float32Array): Promise<SearchResult[]>;

  // List
  listMemories(ctx: TenantContext, options: ListOptions): Promise<PaginatedResult<Memory>>;

  // Related
  findRelated(ctx: TenantContext, memoryId: string, embedding: Float32Array, limit: number, minSimilarity?: number): Promise<SearchResult[]>;

  // Versions
  getVersions(ctx: TenantContext, memoryId: string, limit: number): Promise<{ current_version: number; history: VersionRecord[] }>;

  // Stats
  getStats(ctx: TenantContext, filter?: { scope?: string; namespace?: string; department?: string }): Promise<MemoryStats>;

  // Export/Import
  exportMemories(ctx: TenantContext, filter?: { scope?: string; namespace?: string; department?: string }): Promise<ExportData>;
  importMemories(ctx: TenantContext, data: MemoryInput[], embeddings: Float32Array[], overwrite: boolean): Promise<{ imported: number; skipped: number; errors: number }>;

  // Ingest (chunked documents)
  ingestDocument(ctx: TenantContext, options: IngestOptions, chunks: { content: string; embedding: Float32Array; chunkIndex: number }[]): Promise<IngestResult>;

  // Chunks
  getChunks(ctx: TenantContext, parentId: string): Promise<Memory[]>;

  // Tenant management
  createTenantSchema?(tenantId: string): Promise<void>;
  deleteTenantData?(tenantId: string): Promise<void>;
}

export interface DeleteFilter {
  scope?: string;
  namespace?: string;
  department?: string;
  document_type?: string;
  before_date?: string;
  expired_only?: boolean;
}
