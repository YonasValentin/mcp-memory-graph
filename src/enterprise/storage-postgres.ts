// ── PostgreSQL + pgvector Storage Backend ──────────────────────────────────

import { v4 as uuidv4 } from 'uuid';
import type {
  Memory, MemoryInput, MemoryUpdate, SearchOptions,
  SearchResult, ListOptions, PaginatedResult, MemoryStats,
  ExportData, VersionRecord, IngestOptions, IngestResult,
} from '../types.js';
import type { TenantContext } from './tenant.js';
import type { StorageBackend, DeleteFilter } from './storage.js';
import { computeConfidence, confidenceLabel } from '../search/scoring.js';
import { applyTemporalDecay } from '../search/temporal.js';

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

interface PgClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number }>;
  release(): void;
}

export class PostgresStorageBackend implements StorageBackend {
  private pool: PgPool | null = null;
  private connectionUrl: string;
  private poolMin: number;
  private poolMax: number;
  private pgvector: any = null;

  constructor(connectionUrl: string, poolMin: number = 2, poolMax: number = 20) {
    this.connectionUrl = connectionUrl;
    this.poolMin = poolMin;
    this.poolMax = poolMax;
  }

  async initialize(): Promise<void> {
    const pg = await import('pg');
    this.pgvector = await import('pgvector/pg');

    this.pool = new pg.default.Pool({
      connectionString: this.connectionUrl,
      min: this.poolMin,
      max: this.poolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Register pgvector types on each new connection
    (this.pool as any).on('connect', async (client: any) => {
      await this.pgvector.registerTypes(client);
    });

    // Create schema
    await this.createSchema();
  }

  private async createSchema(): Promise<void> {
    const pool = this.getPool();

    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        storage_limit_bytes BIGINT DEFAULT 1073741824,
        memory_limit INTEGER DEFAULT 100000,
        api_key_hash TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        suspended_at TIMESTAMPTZ
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tenant_id, email)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        namespace TEXT,
        title TEXT,
        content TEXT NOT NULL,
        embedding vector(384),
        document_type TEXT,
        source TEXT,
        author TEXT,
        department TEXT,
        tags JSONB DEFAULT '[]',
        access_level TEXT NOT NULL DEFAULT 'internal',
        language TEXT NOT NULL DEFAULT 'en',
        metadata JSONB DEFAULT '{}',
        parent_id UUID REFERENCES memories(id) ON DELETE CASCADE,
        chunk_index INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS memory_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        title TEXT,
        metadata JSONB,
        version INTEGER NOT NULL,
        changed_by TEXT,
        changed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        details JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        url TEXT NOT NULL,
        events TEXT[] NOT NULL DEFAULT '{}',
        secret TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes (IF NOT EXISTS)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_tenant ON memories(tenant_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_tenant_scope ON memories(tenant_id, scope)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_tenant_dept ON memories(tenant_id, department)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_tenant_ns ON memories(tenant_id, namespace)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_parent ON memories(parent_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING gin(tags)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_memory_versions_mid ON memory_versions(memory_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, created_at DESC)`);

    // Full-text search index
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories
      USING gin (to_tsvector('english', coalesce(title, '') || ' ' || content))
    `);

    // Vector index (HNSW) - create only if it doesn't exist
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
      `);
    } catch {
      // Index might already exist with different parameters
    }

    // Row-Level Security
    await pool.query(`ALTER TABLE memories ENABLE ROW LEVEL SECURITY`).catch(() => {});
    await pool.query(`
      DO $$ BEGIN
        CREATE POLICY tenant_isolation ON memories
          FOR ALL
          USING (tenant_id = current_setting('app.tenant_id', true)::UUID);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }

  private getPool(): PgPool {
    if (!this.pool) throw new Error('PostgreSQL pool not initialized');
    return this.pool;
  }

  private toSql(embedding: Float32Array): string {
    return this.pgvector.toSql(Array.from(embedding));
  }

  private rowToMemory(row: any): Memory {
    return {
      id: row.id,
      scope: row.scope,
      namespace: row.namespace,
      title: row.title,
      content: row.content,
      document_type: row.document_type,
      source: row.source,
      author: row.author,
      department: row.department,
      tags: row.tags ?? [],
      access_level: row.access_level,
      language: row.language,
      metadata: row.metadata,
      parent_id: row.parent_id,
      chunk_index: row.chunk_index,
      version: row.version,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async storeMemory(ctx: TenantContext, input: MemoryInput, embedding: Float32Array): Promise<Memory> {
    const id = uuidv4();
    const result = await this.getPool().query(
      `INSERT INTO memories (id, tenant_id, scope, namespace, title, content, embedding,
        document_type, source, author, department, tags, access_level, language, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        id, ctx.tenantId, input.scope ?? 'global', input.namespace ?? null,
        input.title ?? null, input.content, this.toSql(embedding),
        input.document_type ?? null, input.source ?? null, input.author ?? ctx.userId,
        input.department ?? null, JSON.stringify(input.tags ?? []),
        input.access_level ?? 'internal', input.language ?? 'en',
        JSON.stringify(input.metadata ?? {}), input.expires_at ?? null,
      ]
    );
    return this.rowToMemory(result.rows[0]);
  }

  async getMemory(ctx: TenantContext, id: string): Promise<Memory | null> {
    const result = await this.getPool().query(
      'SELECT * FROM memories WHERE id = $1 AND tenant_id = $2',
      [id, ctx.tenantId]
    );
    return result.rows.length > 0 ? this.rowToMemory(result.rows[0]) : null;
  }

  async updateMemory(ctx: TenantContext, id: string, updates: MemoryUpdate, newEmbedding?: Float32Array): Promise<Memory | null> {
    const pool = this.getPool();

    // Check ownership
    const existing = await pool.query(
      'SELECT * FROM memories WHERE id = $1 AND tenant_id = $2',
      [id, ctx.tenantId]
    );
    if (existing.rows.length === 0) return null;
    const old = existing.rows[0];

    // Save version
    await pool.query(
      `INSERT INTO memory_versions (memory_id, content, title, metadata, version, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, old.content, old.title, JSON.stringify(old.metadata), old.version, updates.changed_by ?? ctx.userId]
    );

    // Build update
    const setClauses: string[] = ['version = version + 1', 'updated_at = NOW()'];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (updates.content !== undefined) { setClauses.push(`content = $${paramIdx}`); params.push(updates.content); paramIdx++; }
    if (updates.title !== undefined) { setClauses.push(`title = $${paramIdx}`); params.push(updates.title); paramIdx++; }
    if (updates.tags !== undefined) { setClauses.push(`tags = $${paramIdx}`); params.push(JSON.stringify(updates.tags)); paramIdx++; }
    if (updates.metadata !== undefined) { setClauses.push(`metadata = $${paramIdx}`); params.push(JSON.stringify(updates.metadata)); paramIdx++; }
    if (updates.expires_at !== undefined) { setClauses.push(`expires_at = $${paramIdx}`); params.push(updates.expires_at); paramIdx++; }
    if (newEmbedding) { setClauses.push(`embedding = $${paramIdx}`); params.push(this.toSql(newEmbedding)); paramIdx++; }

    params.push(id, ctx.tenantId);
    const result = await pool.query(
      `UPDATE memories SET ${setClauses.join(', ')} WHERE id = $${paramIdx} AND tenant_id = $${paramIdx + 1} RETURNING *`,
      params
    );
    return result.rows.length > 0 ? this.rowToMemory(result.rows[0]) : null;
  }

  async deleteMemory(ctx: TenantContext, id: string): Promise<boolean> {
    const result = await this.getPool().query(
      'DELETE FROM memories WHERE id = $1 AND tenant_id = $2',
      [id, ctx.tenantId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteMemoriesByFilter(ctx: TenantContext, filter: DeleteFilter): Promise<number> {
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [ctx.tenantId];
    let idx = 2;

    if (filter.scope) { conditions.push(`scope = $${idx}`); params.push(filter.scope); idx++; }
    if (filter.namespace) { conditions.push(`namespace = $${idx}`); params.push(filter.namespace); idx++; }
    if (filter.department) { conditions.push(`department = $${idx}`); params.push(filter.department); idx++; }
    if (filter.document_type) { conditions.push(`document_type = $${idx}`); params.push(filter.document_type); idx++; }
    if (filter.before_date) { conditions.push(`created_at < $${idx}`); params.push(filter.before_date); idx++; }
    if (filter.expired_only) { conditions.push(`expires_at IS NOT NULL AND expires_at < NOW()`); }

    const result = await this.getPool().query(
      `DELETE FROM memories WHERE ${conditions.join(' AND ')}`,
      params
    );
    return result.rowCount ?? 0;
  }

  async hybridSearch(ctx: TenantContext, options: SearchOptions, queryEmbedding: Float32Array): Promise<SearchResult[]> {
    const pool = this.getPool();
    const doVector = options.search_mode === 'hybrid' || options.search_mode === 'vector';
    const doKeyword = options.search_mode === 'hybrid' || options.search_mode === 'keyword';
    const oversampleLimit = options.limit * 3;

    // Build filter conditions
    const conditions: string[] = ['m.tenant_id = $1'];
    const filterParams: unknown[] = [ctx.tenantId];
    let paramIdx = 2;

    if (options.scope) { conditions.push(`m.scope = $${paramIdx}`); filterParams.push(options.scope); paramIdx++; }
    if (options.namespace) { conditions.push(`m.namespace = $${paramIdx}`); filterParams.push(options.namespace); paramIdx++; }
    if (options.department) { conditions.push(`m.department = $${paramIdx}`); filterParams.push(options.department); paramIdx++; }
    if (options.document_type) { conditions.push(`m.document_type = $${paramIdx}`); filterParams.push(options.document_type); paramIdx++; }
    if (options.access_level) { conditions.push(`m.access_level = $${paramIdx}`); filterParams.push(options.access_level); paramIdx++; }
    if (options.language) { conditions.push(`m.language = $${paramIdx}`); filterParams.push(options.language); paramIdx++; }
    if (options.date_from) { conditions.push(`m.created_at >= $${paramIdx}`); filterParams.push(options.date_from); paramIdx++; }
    if (options.date_to) { conditions.push(`m.created_at <= $${paramIdx}`); filterParams.push(options.date_to); paramIdx++; }
    if (options.tags && options.tags.length > 0) {
      conditions.push(`m.tags @> $${paramIdx}`);
      filterParams.push(JSON.stringify(options.tags));
      paramIdx++;
    }
    conditions.push('(m.expires_at IS NULL OR m.expires_at > NOW())');

    const whereClause = conditions.join(' AND ');
    const embeddingSql = this.toSql(queryEmbedding);

    // Hybrid search with RRF in PostgreSQL
    let sql: string;
    const queryParams = [...filterParams];

    if (doVector && doKeyword) {
      queryParams.push(embeddingSql, oversampleLimit, options.query, oversampleLimit);
      sql = `
        WITH vector_results AS (
          SELECT m.id, m.embedding <=> $${paramIdx}::vector AS distance,
                 ROW_NUMBER() OVER (ORDER BY m.embedding <=> $${paramIdx}::vector) AS v_rank
          FROM memories m
          WHERE ${whereClause}
          ORDER BY m.embedding <=> $${paramIdx}::vector
          LIMIT $${paramIdx + 1}
        ),
        keyword_results AS (
          SELECT m.id,
                 ts_rank(to_tsvector('english', coalesce(m.title, '') || ' ' || m.content),
                         plainto_tsquery('english', $${paramIdx + 2})) AS relevance,
                 ROW_NUMBER() OVER (ORDER BY ts_rank(to_tsvector('english', coalesce(m.title, '') || ' ' || m.content),
                         plainto_tsquery('english', $${paramIdx + 2})) DESC) AS k_rank
          FROM memories m
          WHERE ${whereClause}
            AND to_tsvector('english', coalesce(m.title, '') || ' ' || m.content)
                @@ plainto_tsquery('english', $${paramIdx + 2})
          LIMIT $${paramIdx + 3}
        ),
        fused AS (
          SELECT COALESCE(v.id, k.id) AS id,
                 COALESCE(1.0 / (60 + v.v_rank), 0) + COALESCE(1.0 / (60 + k.k_rank), 0) AS rrf_score,
                 v.distance AS v_distance,
                 k.k_rank AS k_rank
          FROM vector_results v
          FULL OUTER JOIN keyword_results k ON v.id = k.id
          ORDER BY rrf_score DESC
        )
        SELECT m.*, f.rrf_score, f.v_distance, f.k_rank
        FROM fused f
        JOIN memories m ON m.id = f.id
        ORDER BY f.rrf_score DESC
        LIMIT ${options.limit} OFFSET ${options.offset}
      `;
    } else if (doVector) {
      queryParams.push(embeddingSql, oversampleLimit);
      sql = `
        SELECT m.*, m.embedding <=> $${paramIdx}::vector AS v_distance, NULL::bigint AS k_rank,
               1.0 / (60 + ROW_NUMBER() OVER (ORDER BY m.embedding <=> $${paramIdx}::vector)) AS rrf_score
        FROM memories m
        WHERE ${whereClause}
        ORDER BY m.embedding <=> $${paramIdx}::vector
        LIMIT $${paramIdx + 1}
      `;
    } else {
      queryParams.push(options.query, oversampleLimit);
      sql = `
        SELECT m.*, NULL::float AS v_distance,
               ROW_NUMBER() OVER (ORDER BY ts_rank(to_tsvector('english', coalesce(m.title, '') || ' ' || m.content),
                       plainto_tsquery('english', $${paramIdx})) DESC) AS k_rank,
               1.0 / (60 + ROW_NUMBER() OVER (ORDER BY ts_rank(to_tsvector('english', coalesce(m.title, '') || ' ' || m.content),
                       plainto_tsquery('english', $${paramIdx})) DESC)) AS rrf_score
        FROM memories m
        WHERE ${whereClause}
          AND to_tsvector('english', coalesce(m.title, '') || ' ' || m.content)
              @@ plainto_tsquery('english', $${paramIdx})
        LIMIT $${paramIdx + 1}
      `;
    }

    const result = await pool.query(sql, queryParams);

    const totalResults = result.rows.length;
    let results: SearchResult[] = result.rows.map((row, index) => {
      const vDist = row.v_distance != null ? parseFloat(row.v_distance) : null;
      const kRank = row.k_rank != null ? parseInt(row.k_rank) : null;
      const confidence = computeConfidence(vDist, kRank, index, totalResults);

      let matchType: SearchResult['match_type'];
      if (vDist !== null && kRank !== null) matchType = 'hybrid';
      else if (vDist !== null) matchType = 'vector';
      else matchType = 'keyword';

      let score = parseFloat(row.rrf_score) || 0;
      if (options.temporal_decay) {
        const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
        score = applyTemporalDecay(score, createdAt, options.temporal_decay);
      }

      return {
        memory: this.rowToMemory(row),
        score,
        confidence,
        confidence_level: confidenceLabel(confidence),
        match_type: matchType,
      };
    });

    if (options.temporal_decay) {
      results.sort((a, b) => b.score - a.score);
    }

    if (options.min_confidence) {
      results = results.filter(r => r.confidence >= options.min_confidence!);
    }

    return results;
  }

  async listMemories(ctx: TenantContext, options: ListOptions): Promise<PaginatedResult<Memory>> {
    const pool = this.getPool();
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [ctx.tenantId];
    let idx = 2;

    if (options.scope) { conditions.push(`scope = $${idx}`); params.push(options.scope); idx++; }
    if (options.namespace) { conditions.push(`namespace = $${idx}`); params.push(options.namespace); idx++; }
    if (options.department) { conditions.push(`department = $${idx}`); params.push(options.department); idx++; }
    if (options.document_type) { conditions.push(`document_type = $${idx}`); params.push(options.document_type); idx++; }

    const where = conditions.join(' AND ');
    const allowedSort = ['created_at', 'updated_at', 'title'];
    const sortField = allowedSort.includes(options.sort_by) ? options.sort_by : 'created_at';
    const sortOrder = options.sort_order === 'asc' ? 'ASC' : 'DESC';

    const countResult = await pool.query(`SELECT COUNT(*) as cnt FROM memories WHERE ${where}`, params);
    const total = parseInt(countResult.rows[0].cnt);

    const listResult = await pool.query(
      `SELECT * FROM memories WHERE ${where} ORDER BY ${sortField} ${sortOrder} LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, options.limit, options.offset]
    );

    return {
      items: listResult.rows.map(r => this.rowToMemory(r)),
      total,
      limit: options.limit,
      offset: options.offset,
      has_more: options.offset + options.limit < total,
    };
  }

  async findRelated(ctx: TenantContext, memoryId: string, embedding: Float32Array, limit: number, minSimilarity?: number): Promise<SearchResult[]> {
    const pool = this.getPool();
    const result = await pool.query(
      `SELECT *, embedding <=> $1::vector AS distance
       FROM memories
       WHERE tenant_id = $2 AND id != $3
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [this.toSql(embedding), ctx.tenantId, memoryId, limit * 2]
    );

    const results: SearchResult[] = [];
    for (const row of result.rows) {
      const similarity = Math.max(0, 1 - parseFloat(row.distance) / 2);
      if (minSimilarity && similarity < minSimilarity) continue;
      const confidence = computeConfidence(parseFloat(row.distance), null, results.length, result.rows.length);
      results.push({
        memory: this.rowToMemory(row),
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
    const pool = this.getPool();
    const mem = await pool.query('SELECT version FROM memories WHERE id = $1 AND tenant_id = $2', [memoryId, ctx.tenantId]);
    if (mem.rows.length === 0) return { current_version: 0, history: [] };

    const versions = await pool.query(
      'SELECT * FROM memory_versions WHERE memory_id = $1 ORDER BY version DESC LIMIT $2',
      [memoryId, limit]
    );

    return {
      current_version: mem.rows[0].version,
      history: versions.rows.map(r => ({
        id: r.id,
        memory_id: r.memory_id,
        content: r.content,
        title: r.title,
        metadata: r.metadata ? JSON.stringify(r.metadata) : null,
        version: r.version,
        changed_by: r.changed_by,
        changed_at: r.changed_at instanceof Date ? r.changed_at.toISOString() : r.changed_at,
      })),
    };
  }

  async getStats(ctx: TenantContext, filter?: { scope?: string; namespace?: string; department?: string }): Promise<MemoryStats> {
    const pool = this.getPool();
    const conditions: string[] = ['tenant_id = $1'];
    const params: unknown[] = [ctx.tenantId];
    let idx = 2;

    if (filter?.scope) { conditions.push(`scope = $${idx}`); params.push(filter.scope); idx++; }
    if (filter?.namespace) { conditions.push(`namespace = $${idx}`); params.push(filter.namespace); idx++; }
    if (filter?.department) { conditions.push(`department = $${idx}`); params.push(filter.department); idx++; }

    const where = conditions.join(' AND ');

    const [totalR, chunksR, docsR, expiredR, sizeR, scopeR, deptR, typeR] = await Promise.all([
      pool.query(`SELECT COUNT(*) as cnt FROM memories WHERE ${where}`, params),
      pool.query(`SELECT COUNT(*) as cnt FROM memories WHERE ${where} AND parent_id IS NOT NULL`, params),
      pool.query(`SELECT COUNT(*) as cnt FROM memories WHERE ${where} AND parent_id IS NULL AND chunk_index IS NULL`, params),
      pool.query(`SELECT COUNT(*) as cnt FROM memories WHERE ${where} AND expires_at IS NOT NULL AND expires_at < NOW()`, params),
      pool.query(`SELECT COALESCE(SUM(LENGTH(content)), 0) as total_size FROM memories WHERE ${where}`, params),
      pool.query(`SELECT scope, COUNT(*) as cnt FROM memories WHERE ${where} GROUP BY scope`, params),
      pool.query(`SELECT department, COUNT(*) as cnt FROM memories WHERE ${where} AND department IS NOT NULL GROUP BY department`, params),
      pool.query(`SELECT document_type, COUNT(*) as cnt FROM memories WHERE ${where} AND document_type IS NOT NULL GROUP BY document_type`, params),
    ]);

    const byScope: Record<string, number> = {};
    for (const r of scopeR.rows) byScope[r.scope] = parseInt(r.cnt);
    const byDept: Record<string, number> = {};
    for (const r of deptR.rows) byDept[r.department] = parseInt(r.cnt);
    const byType: Record<string, number> = {};
    for (const r of typeR.rows) byType[r.document_type] = parseInt(r.cnt);

    return {
      total_memories: parseInt(totalR.rows[0].cnt),
      total_chunks: parseInt(chunksR.rows[0].cnt),
      total_documents: parseInt(docsR.rows[0].cnt),
      by_scope: byScope,
      by_department: byDept,
      by_document_type: byType,
      total_content_bytes: parseInt(sizeR.rows[0].total_size),
      database_size_bytes: 0,
      expired_count: parseInt(expiredR.rows[0].cnt),
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
    const chunkIds: string[] = [];

    // Store parent
    await this.getPool().query(
      `INSERT INTO memories (id, tenant_id, scope, namespace, title, content, embedding,
        document_type, source, author, department, tags, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        parentId, ctx.tenantId, options.scope ?? 'global', options.namespace ?? null,
        options.title ?? null, options.content.substring(0, 500),
        this.toSql(chunks[0]?.embedding ?? new Float32Array(384)),
        options.document_type ?? null, options.source ?? null, options.author ?? ctx.userId,
        options.department ?? null, JSON.stringify(options.tags ?? []),
        JSON.stringify(options.metadata ?? {}),
      ]
    );

    // Store chunks
    for (const chunk of chunks) {
      const chunkId = uuidv4();
      chunkIds.push(chunkId);
      await this.getPool().query(
        `INSERT INTO memories (id, tenant_id, scope, namespace, title, content, embedding,
          document_type, source, author, department, tags, parent_id, chunk_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          chunkId, ctx.tenantId, options.scope ?? 'global', options.namespace ?? null,
          options.title ? `${options.title} [chunk ${chunk.chunkIndex}]` : null,
          chunk.content, this.toSql(chunk.embedding),
          options.document_type ?? null, options.source ?? null, options.author ?? ctx.userId,
          options.department ?? null, JSON.stringify(options.tags ?? []),
          parentId, chunk.chunkIndex,
        ]
      );
    }

    return { parent_id: parentId, chunk_count: chunks.length, chunk_ids: chunkIds };
  }

  async getChunks(ctx: TenantContext, parentId: string): Promise<Memory[]> {
    const result = await this.getPool().query(
      'SELECT * FROM memories WHERE parent_id = $1 AND tenant_id = $2 ORDER BY chunk_index',
      [parentId, ctx.tenantId]
    );
    return result.rows.map(r => this.rowToMemory(r));
  }

  async createTenantSchema(tenantId: string): Promise<void> {
    await this.getPool().query(
      `INSERT INTO tenants (id, name, plan) VALUES ($1, $2, 'free') ON CONFLICT (id) DO NOTHING`,
      [tenantId, `Tenant ${tenantId}`]
    );
  }

  async deleteTenantData(tenantId: string): Promise<void> {
    await this.getPool().query('DELETE FROM memories WHERE tenant_id = $1', [tenantId]);
    await this.getPool().query('DELETE FROM audit_log WHERE tenant_id = $1', [tenantId]);
  }
}
