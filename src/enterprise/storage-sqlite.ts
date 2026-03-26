// ── SQLite Storage Backend ─────────────────────────────────────────────────
//
// Wraps the existing SQLite-based storage for use in the enterprise layer.
// Adds tenant_id scoping via namespace for backward compatibility.

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  Memory, MemoryRow, MemoryInput, MemoryUpdate, SearchOptions,
  SearchResult, ListOptions, PaginatedResult, MemoryStats,
  ExportData, VersionRecord, IngestOptions, IngestResult,
} from '../types.js';
import type { TenantContext } from './tenant.js';
import type { StorageBackend, DeleteFilter } from './storage.js';
import { getDatabase, closeDatabase } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { runMigrations } from '../db/migrations.js';
import {
  insertMemory, updateMemory as repoUpdate, deleteMemory as repoDelete,
  deleteMemoriesByFilter as repoDeleteByFilter, getMemoryById, listMemories as repoList,
  rowToMemory,
} from '../db/repository.js';
import { hybridSearch } from '../search/hybrid.js';
import { computeConfidence, confidenceLabel } from '../search/scoring.js';

export class SqliteStorageBackend implements StorageBackend {
  private db: Database.Database | null = null;
  private dbPath?: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath;
  }

  private getDb(): Database.Database {
    if (!this.db) {
      this.db = getDatabase(this.dbPath);
      initializeSchema(this.db);
      runMigrations(this.db);
    }
    return this.db;
  }

  async initialize(): Promise<void> {
    this.getDb();
  }

  async close(): Promise<void> {
    closeDatabase();
    this.db = null;
  }

  private tenantNamespace(ctx: TenantContext, ns?: string | null): string {
    return `t:${ctx.tenantId}${ns ? `:${ns}` : ''}`;
  }

  async storeMemory(ctx: TenantContext, input: MemoryInput, embedding: Float32Array): Promise<Memory> {
    const now = new Date().toISOString();
    const row: MemoryRow = {
      id: uuidv4(),
      scope: input.scope ?? 'global',
      namespace: this.tenantNamespace(ctx, input.namespace),
      title: input.title ?? null,
      content: input.content,
      document_type: input.document_type ?? null,
      source: input.source ?? null,
      author: input.author ?? ctx.userId,
      department: input.department ?? null,
      tags: input.tags ? JSON.stringify(input.tags) : null,
      access_level: input.access_level ?? 'internal',
      language: input.language ?? 'en',
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      parent_id: null,
      chunk_index: null,
      version: 1,
      created_at: now,
      updated_at: now,
      expires_at: input.expires_at ?? null,
    };
    insertMemory(this.getDb(), row, embedding);
    return rowToMemory(row);
  }

  async getMemory(ctx: TenantContext, id: string): Promise<Memory | null> {
    const row = getMemoryById(this.getDb(), id);
    if (!row) return null;
    if (!row.namespace?.startsWith(`t:${ctx.tenantId}`)) return null;
    return rowToMemory(row);
  }

  async updateMemory(ctx: TenantContext, id: string, updates: MemoryUpdate, newEmbedding?: Float32Array): Promise<Memory | null> {
    const existing = getMemoryById(this.getDb(), id);
    if (!existing || !existing.namespace?.startsWith(`t:${ctx.tenantId}`)) return null;

    const partialRow: Partial<MemoryRow> = {};
    if (updates.content !== undefined) partialRow.content = updates.content;
    if (updates.title !== undefined) partialRow.title = updates.title;
    if (updates.tags !== undefined) partialRow.tags = JSON.stringify(updates.tags);
    if (updates.metadata !== undefined) partialRow.metadata = JSON.stringify(updates.metadata);
    if (updates.expires_at !== undefined) partialRow.expires_at = updates.expires_at;
    if (updates.changed_by !== undefined) partialRow.author = updates.changed_by;

    const updated = repoUpdate(this.getDb(), id, partialRow, newEmbedding);
    return updated ? rowToMemory(updated) : null;
  }

  async deleteMemory(ctx: TenantContext, id: string): Promise<boolean> {
    const existing = getMemoryById(this.getDb(), id);
    if (!existing || !existing.namespace?.startsWith(`t:${ctx.tenantId}`)) return false;
    return repoDelete(this.getDb(), id);
  }

  async deleteMemoriesByFilter(ctx: TenantContext, filter: DeleteFilter): Promise<number> {
    return repoDeleteByFilter(this.getDb(), {
      scope: filter.scope,
      namespace: this.tenantNamespace(ctx),
      department: filter.department,
      document_type: filter.document_type,
    });
  }

  async hybridSearch(ctx: TenantContext, options: SearchOptions, _queryEmbedding: Float32Array): Promise<SearchResult[]> {
    // We override the namespace to scope to tenant
    const scopedOptions: SearchOptions = {
      ...options,
      namespace: this.tenantNamespace(ctx, options.namespace),
    };

    // Use the existing hybrid search which handles embedding internally
    // Note: we need to create a lightweight wrapper for the embedder
    // This is called from the API layer which already has the embedding
    return hybridSearch(this.getDb(), {
      dimensions: 384,
      modelName: 'passthrough',
      async initialize() {},
      async embed() { return _queryEmbedding; },
      async embedBatch(texts: string[]) { return texts.map(() => _queryEmbedding); },
      isReady() { return true; },
    }, scopedOptions);
  }

  async listMemories(ctx: TenantContext, options: ListOptions): Promise<PaginatedResult<Memory>> {
    const scopedOptions: ListOptions = {
      ...options,
      namespace: this.tenantNamespace(ctx, options.namespace),
    };
    const { memories, total } = repoList(this.getDb(), scopedOptions);
    return {
      items: memories.map(rowToMemory),
      total,
      limit: options.limit,
      offset: options.offset,
      has_more: options.offset + options.limit < total,
    };
  }

  async findRelated(ctx: TenantContext, memoryId: string, embedding: Float32Array, limit: number, minSimilarity?: number): Promise<SearchResult[]> {
    const db = this.getDb();
    const rows = db.prepare(
      `SELECT rowid, distance FROM memories_vec
       WHERE embedding MATCH ? AND k = ?
       ORDER BY distance`
    ).all(Buffer.from(embedding.buffer), limit * 2) as { rowid: number; distance: number }[];

    const results: SearchResult[] = [];
    for (const row of rows) {
      const memRow = db.prepare<[number], MemoryRow>('SELECT * FROM memories WHERE rowid = ?').get(row.rowid);
      if (!memRow || memRow.id === memoryId) continue;
      if (!memRow.namespace?.startsWith(`t:${ctx.tenantId}`)) continue;

      const similarity = Math.max(0, 1 - row.distance / 2);
      if (minSimilarity && similarity < minSimilarity) continue;

      const confidence = computeConfidence(row.distance, null, results.length, rows.length);
      results.push({
        memory: rowToMemory(memRow),
        score: similarity,
        confidence,
        confidence_level: confidenceLabel(confidence),
        match_type: 'vector',
      });
      if (results.length >= limit) break;
    }
    return results;
  }

  async getVersions(ctx: TenantContext, memoryId: string, limit: number): Promise<{ current_version: number; history: VersionRecord[] }> {
    const existing = getMemoryById(this.getDb(), memoryId);
    if (!existing || !existing.namespace?.startsWith(`t:${ctx.tenantId}`)) {
      return { current_version: 0, history: [] };
    }
    const history = this.getDb()
      .prepare<[string, number], VersionRecord>(
        'SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC LIMIT ?'
      )
      .all(memoryId, limit);
    return { current_version: existing.version, history };
  }

  async getStats(ctx: TenantContext, filter?: { scope?: string; namespace?: string; department?: string }): Promise<MemoryStats> {
    const db = this.getDb();
    const ns = this.tenantNamespace(ctx, filter?.namespace);
    const conditions: string[] = ['namespace LIKE ?'];
    const params: unknown[] = [`t:${ctx.tenantId}%`];

    if (filter?.scope) { conditions.push('scope = ?'); params.push(filter.scope); }
    if (filter?.department) { conditions.push('department = ?'); params.push(filter.department); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const total = db.prepare<unknown[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM memories ${where}`).get(...params)?.cnt ?? 0;
    const chunks = db.prepare<unknown[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM memories ${where} AND parent_id IS NOT NULL`).get(...params)?.cnt ?? 0;
    const docs = db.prepare<unknown[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM memories ${where} AND parent_id IS NULL AND chunk_index IS NULL`).get(...params)?.cnt ?? 0;
    const expired = db.prepare<unknown[], { cnt: number }>(`SELECT COUNT(*) as cnt FROM memories ${where} AND expires_at IS NOT NULL AND expires_at < datetime('now')`).get(...params)?.cnt ?? 0;
    const sizeRow = db.prepare<unknown[], { total_size: number }>(`SELECT COALESCE(SUM(LENGTH(content)), 0) as total_size FROM memories ${where}`).get(...params);

    return {
      total_memories: total,
      total_chunks: chunks,
      total_documents: docs,
      by_scope: {},
      by_department: {},
      by_document_type: {},
      total_content_bytes: sizeRow?.total_size ?? 0,
      database_size_bytes: 0,
      expired_count: expired,
    };
  }

  async exportMemories(ctx: TenantContext, filter?: { scope?: string; namespace?: string; department?: string }): Promise<ExportData> {
    const result = await this.listMemories(ctx, {
      scope: filter?.scope as any,
      namespace: filter?.namespace,
      department: filter?.department,
      limit: 1000,
      offset: 0,
      sort_by: 'created_at',
      sort_order: 'desc',
    });
    return {
      version: '1.0.0',
      exported_at: new Date().toISOString(),
      count: result.items.length,
      memories: result.items,
    };
  }

  async importMemories(ctx: TenantContext, data: MemoryInput[], embeddings: Float32Array[], overwrite: boolean): Promise<{ imported: number; skipped: number; errors: number }> {
    let imported = 0, skipped = 0, errors = 0;
    for (let i = 0; i < data.length; i++) {
      try {
        await this.storeMemory(ctx, data[i], embeddings[i]);
        imported++;
      } catch {
        errors++;
      }
    }
    return { imported, skipped, errors };
  }

  async ingestDocument(ctx: TenantContext, options: IngestOptions, chunks: { content: string; embedding: Float32Array; chunkIndex: number }[]): Promise<IngestResult> {
    const parentId = uuidv4();
    const now = new Date().toISOString();
    const chunkIds: string[] = [];

    // Store parent (summary)
    const parentRow: MemoryRow = {
      id: parentId,
      scope: options.scope ?? 'global',
      namespace: this.tenantNamespace(ctx, options.namespace),
      title: options.title ?? null,
      content: options.content.substring(0, 500),
      document_type: options.document_type ?? null,
      source: options.source ?? null,
      author: options.author ?? ctx.userId,
      department: options.department ?? null,
      tags: options.tags ? JSON.stringify(options.tags) : null,
      access_level: 'internal',
      language: 'en',
      metadata: options.metadata ? JSON.stringify(options.metadata) : null,
      parent_id: null,
      chunk_index: null,
      version: 1,
      created_at: now,
      updated_at: now,
      expires_at: null,
    };
    insertMemory(this.getDb(), parentRow, chunks[0]?.embedding ?? new Float32Array(384));

    // Store chunks
    for (const chunk of chunks) {
      const chunkId = uuidv4();
      chunkIds.push(chunkId);
      const chunkRow: MemoryRow = {
        id: chunkId,
        scope: options.scope ?? 'global',
        namespace: this.tenantNamespace(ctx, options.namespace),
        title: options.title ? `${options.title} [chunk ${chunk.chunkIndex}]` : null,
        content: chunk.content,
        document_type: options.document_type ?? null,
        source: options.source ?? null,
        author: options.author ?? ctx.userId,
        department: options.department ?? null,
        tags: options.tags ? JSON.stringify(options.tags) : null,
        access_level: 'internal',
        language: 'en',
        metadata: null,
        parent_id: parentId,
        chunk_index: chunk.chunkIndex,
        version: 1,
        created_at: now,
        updated_at: now,
        expires_at: null,
      };
      insertMemory(this.getDb(), chunkRow, chunk.embedding);
    }

    return { parent_id: parentId, chunk_count: chunks.length, chunk_ids: chunkIds };
  }

  async getChunks(ctx: TenantContext, parentId: string): Promise<Memory[]> {
    const rows = this.getDb()
      .prepare<[string], MemoryRow>('SELECT * FROM memories WHERE parent_id = ? ORDER BY chunk_index')
      .all(parentId);
    return rows
      .filter(r => r.namespace?.startsWith(`t:${ctx.tenantId}`))
      .map(rowToMemory);
  }
}
