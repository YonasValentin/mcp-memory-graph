# PureGate Knowledge Platform - Enterprise Evaluation

## Executive Summary

MCP Memory Server is a local-first vector knowledge system built for Claude Code. This document evaluates its suitability for **PureGate Knowledge** - an enterprise, multi-tenant web platform - and provides a concrete roadmap for scaling it up.

**Verdict:** The core is solid (hybrid search, smart chunking, versioning, metadata model). But significant architectural changes are needed for enterprise multi-tenant web usage. This document maps out exactly what to build.

---

## 1. Current Architecture Assessment

### What We Have Today

```
Claude Code (stdio)
    |
MCP Memory Server (Node.js)
    |
    +-- 15 MCP Tools (store, search, ingest, vault sync, etc.)
    +-- Hybrid Search (vector + keyword + RRF fusion)
    +-- SQLite + sqlite-vec + FTS5
    +-- Transformers.js (local CPU embeddings)
    +-- Document Chunking (text, markdown, code, legal)
    +-- Version History + Audit Trail
    +-- Obsidian Vault Integration
```

### Strengths for PureGate

| Feature | Enterprise Value |
|---------|-----------------|
| **Hybrid search (vector + keyword + RRF)** | Best-in-class retrieval quality |
| **Smart chunking** (markdown, code, legal, text) | Handles diverse document types |
| **Multi-scope hierarchy** (global/project/user/team/dept) | Maps to org structure |
| **Access levels** (public/internal/confidential/restricted) | Security classification ready |
| **Version history** | Audit compliance |
| **Rich metadata** (tags, author, department, document_type) | Enterprise taxonomy |
| **Expiration support** | Data lifecycle management |
| **Export/import** | Backup and migration |

### Current Limitations

| Limitation | Impact |
|------------|--------|
| Single SQLite file, no connection pooling | Cannot handle concurrent users |
| stdio transport (serial, 1 client) | No web API |
| CPU-only embeddings (~10-50 queries/sec) | Performance ceiling |
| No authentication/authorization | No user identity |
| No tenant isolation (filter-based only) | Data leakage risk |
| ~100K vector limit | Scale ceiling |
| No caching layer | Redundant computation |
| No monitoring/observability | Blind in production |

---

## 2. Target Architecture: PureGate Knowledge Platform

```
                        +-------------------+
                        |   Load Balancer   |
                        |   (nginx/ALB)     |
                        +--------+----------+
                                 |
                    +------------+------------+
                    |            |            |
              +-----+----+ +----+-----+ +----+-----+
              | API Node | | API Node | | API Node |
              | (Fastify)| | (Fastify)| | (Fastify)|
              +-----+----+ +----+-----+ +----+-----+
                    |            |            |
          +---------+------------+------------+---------+
          |                      |                      |
   +------+-------+    +--------+--------+    +--------+--------+
   | Auth Service  |    | Embedding Svc   |    | Redis Cache     |
   | (JWT/OAuth)   |    | (GPU workers)   |    | (query + embed) |
   +---------------+    +-----------------+    +-----------------+
          |                      |
   +------+----------------------------------------------+
   |                  PostgreSQL + pgvector               |
   |  +----------+ +------------+ +--------------------+  |
   |  | tenants  | | memories   | | memories_embedding |  |
   |  | users    | | mem_fts    | | (vector index)     |  |
   |  | api_keys | | versions   | | (IVFFlat/HNSW)     |  |
   |  +----------+ +------------+ +--------------------+  |
   +------------------------------------------------------+
```

---

## 3. Migration Roadmap

### Phase 1: HTTP API Layer (Week 1-2)

**Goal:** Replace stdio with a web-accessible REST/GraphQL API.

**Changes:**

```
src/
  api/                    # NEW - HTTP layer
    server.ts             # Fastify HTTP server
    routes/
      memories.ts         # REST endpoints for all memory operations
      vault.ts            # Vault sync endpoints
      health.ts           # Health check + readiness probe
    middleware/
      auth.ts             # JWT validation middleware
      tenant.ts           # Tenant context extraction
      rate-limit.ts       # Per-tenant rate limiting
      error-handler.ts    # Standardized error responses
  index.ts                # Updated: dual-mode (stdio + HTTP)
```

**API Design:**

```
POST   /api/v1/memories          -> memory_store
GET    /api/v1/memories/:id      -> memory_get
PUT    /api/v1/memories/:id      -> memory_update
DELETE /api/v1/memories/:id      -> memory_delete
GET    /api/v1/memories          -> memory_list
POST   /api/v1/memories/search   -> memory_search
POST   /api/v1/memories/ingest   -> memory_ingest
GET    /api/v1/memories/:id/related  -> memory_related
GET    /api/v1/memories/:id/versions -> memory_versions
GET    /api/v1/stats             -> memory_stats
POST   /api/v1/export            -> memory_export
POST   /api/v1/import            -> memory_import
POST   /api/v1/vault/sync        -> vault_sync
GET    /api/v1/vault/status      -> vault_status
POST   /api/v1/vault/search      -> vault_search
GET    /api/v1/health            -> health check
```

**New Dependencies:**
- `fastify` - HTTP framework (faster than Express)
- `@fastify/cors` - CORS support
- `@fastify/rate-limit` - Rate limiting
- `jsonwebtoken` / `jose` - JWT handling

---

### Phase 2: Multi-Tenancy (Week 2-3)

**Goal:** Complete tenant isolation with authentication.

**Strategy: Database-per-tenant** (recommended for data isolation + GDPR compliance)

```typescript
// Tenant context flows through every request
interface TenantContext {
  tenantId: string;
  userId: string;
  orgName: string;
  plan: 'free' | 'pro' | 'enterprise';
  permissions: Permission[];
}

// Connection manager maintains per-tenant databases
class TenantDatabaseManager {
  private connections: Map<string, Database> = new Map();
  private configs: Map<string, TenantConfig> = new Map();

  getDatabase(tenantId: string): Database { ... }
  createTenant(config: TenantConfig): void { ... }
  deleteTenant(tenantId: string): void { ... }  // GDPR right to erasure
  backupTenant(tenantId: string): ReadableStream { ... }
}
```

**Schema Changes:**

```sql
-- Central metadata database (shared)
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  storage_limit_bytes BIGINT DEFAULT 1073741824,  -- 1GB
  api_key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  suspended_at TEXT
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',  -- admin, member, viewer
  created_at TEXT NOT NULL
);

-- Per-tenant databases remain unchanged (existing schema works!)
-- Each tenant gets: memories + memories_fts + memories_vec + memory_versions
```

**Auth Flow:**

```
Request → JWT/API Key validation → Extract tenant_id
        → Load tenant config → Check plan limits
        → Route to tenant database → Execute operation
        → Audit log → Response
```

---

### Phase 3: Database Migration - PostgreSQL + pgvector (Week 3-5)

**Goal:** Replace SQLite with a scalable, concurrent database.

**Why PostgreSQL + pgvector:**
- Native vector similarity search (replaces sqlite-vec)
- Full-text search built-in (replaces FTS5)
- Connection pooling (PgBouncer)
- Row-Level Security for additional tenant protection
- Read replicas for search scaling
- Battle-tested at enterprise scale

**Schema:**

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- fuzzy text matching

CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  scope TEXT NOT NULL,
  namespace TEXT,
  title TEXT,
  content TEXT NOT NULL,
  embedding vector(384) NOT NULL,
  document_type TEXT,
  source TEXT,
  author TEXT,
  department TEXT,
  tags JSONB DEFAULT '[]',
  access_level TEXT DEFAULT 'internal',
  language TEXT DEFAULT 'en',
  metadata JSONB DEFAULT '{}',
  parent_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  chunk_index INTEGER,
  version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- Row-Level Security
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memories
  USING (tenant_id = current_setting('app.tenant_id')::UUID);

-- Vector index (HNSW for fast approximate nearest neighbor)
CREATE INDEX idx_memories_embedding ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Full-text search index
CREATE INDEX idx_memories_fts ON memories
  USING gin (to_tsvector('english', coalesce(title, '') || ' ' || content));

-- Tenant + scope composite indexes
CREATE INDEX idx_memories_tenant_scope ON memories(tenant_id, scope);
CREATE INDEX idx_memories_tenant_dept ON memories(tenant_id, department);
CREATE INDEX idx_memories_tenant_tags ON memories USING gin(tags);
CREATE INDEX idx_memories_expires ON memories(expires_at) WHERE expires_at IS NOT NULL;
```

**Hybrid Search in PostgreSQL:**

```sql
-- Combined vector + full-text search with RRF
WITH vector_results AS (
  SELECT id, embedding <=> $1::vector AS distance,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS v_rank
  FROM memories
  WHERE tenant_id = $2
    AND (scope = $3 OR $3 IS NULL)
  ORDER BY embedding <=> $1::vector
  LIMIT $4 * 3
),
keyword_results AS (
  SELECT id,
         ts_rank(to_tsvector('english', coalesce(title,'') || ' ' || content),
                 plainto_tsquery('english', $5)) AS relevance,
         ROW_NUMBER() OVER (ORDER BY ts_rank(...) DESC) AS k_rank
  FROM memories
  WHERE tenant_id = $2
    AND to_tsvector('english', coalesce(title,'') || ' ' || content)
        @@ plainto_tsquery('english', $5)
  LIMIT $4 * 3
),
fused AS (
  SELECT COALESCE(v.id, k.id) AS id,
         COALESCE(1.0 / (60 + v.v_rank), 0) +
         COALESCE(1.0 / (60 + k.k_rank), 0) AS rrf_score
  FROM vector_results v
  FULL OUTER JOIN keyword_results k ON v.id = k.id
  ORDER BY rrf_score DESC
  LIMIT $4
)
SELECT m.*, f.rrf_score
FROM fused f JOIN memories m ON m.id = f.id
ORDER BY f.rrf_score DESC;
```

**Abstraction Layer:**

```typescript
// Storage backend interface (allows SQLite for dev, Postgres for prod)
interface StorageBackend {
  insertMemory(tenantId: string, memory: MemoryInput, embedding: Float32Array): Promise<string>;
  searchMemories(tenantId: string, query: SearchQuery, embedding: Float32Array): Promise<SearchResult[]>;
  getMemory(tenantId: string, id: string): Promise<Memory | null>;
  updateMemory(tenantId: string, id: string, updates: MemoryUpdate, embedding?: Float32Array): Promise<void>;
  deleteMemory(tenantId: string, id: string): Promise<void>;
  listMemories(tenantId: string, filters: ListFilters): Promise<PaginatedResult<Memory>>;
}

class SqliteBackend implements StorageBackend { /* existing logic */ }
class PostgresBackend implements StorageBackend { /* new pg implementation */ }
```

---

### Phase 4: Embedding Service (Week 4-6)

**Goal:** Scale embeddings beyond single-process CPU.

**Options (ranked by recommendation):**

| Option | Throughput | Latency | Cost | Complexity |
|--------|-----------|---------|------|------------|
| **External API (OpenAI/Cohere)** | 10,000+ q/s | 50-200ms | $0.02/1M tokens | Low |
| **Self-hosted GPU service** | 1,000+ q/s | 5-20ms | GPU infra cost | Medium |
| **Worker thread pool** | 100-200 q/s | 20-50ms | CPU cost | Low |
| **Current (single CPU)** | 10-50 q/s | 50-200ms | Included | None |

**Recommended: Pluggable embedding providers**

```typescript
interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  dimensions: number;
  modelName: string;
}

// Local (existing) - for development
class TransformersProvider implements EmbeddingProvider { ... }

// OpenAI API - for production
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<Float32Array> {
    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',  // 1536 dims, or use 384 with dimensions param
      input: text,
    });
    return new Float32Array(response.data[0].embedding);
  }
}

// Self-hosted (TEI / vLLM)
class RemoteEmbeddingProvider implements EmbeddingProvider {
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(`${this.endpoint}/embed`, {
      method: 'POST',
      body: JSON.stringify({ inputs: texts }),
    });
    return response.json();
  }
}
```

**Embedding Cache (Redis):**

```typescript
class CachedEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private inner: EmbeddingProvider,
    private redis: Redis,
    private ttl: number = 86400  // 24 hours
  ) {}

  async embed(text: string): Promise<Float32Array> {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const cached = await this.redis.getBuffer(`emb:${hash}`);
    if (cached) return new Float32Array(cached.buffer);

    const embedding = await this.inner.embed(text);
    await this.redis.setex(`emb:${hash}`, this.ttl, Buffer.from(embedding.buffer));
    return embedding;
  }
}
```

---

### Phase 5: Caching, Monitoring & Operations (Week 5-7)

**Redis Caching Layer:**

```
+-- Search result cache (TTL: 5 min, invalidate on write)
+-- Embedding cache (TTL: 24h, content-addressed)
+-- Rate limit counters (per tenant, sliding window)
+-- Session cache (JWT validation results)
```

**Monitoring Stack:**

```typescript
// Prometheus metrics
const metrics = {
  searchLatency: new Histogram({ name: 'puregate_search_duration_seconds', labelNames: ['tenant', 'mode'] }),
  searchResults: new Histogram({ name: 'puregate_search_results_count', labelNames: ['tenant'] }),
  embeddingLatency: new Histogram({ name: 'puregate_embedding_duration_seconds', labelNames: ['provider'] }),
  memoriesStored: new Counter({ name: 'puregate_memories_stored_total', labelNames: ['tenant'] }),
  storageBytes: new Gauge({ name: 'puregate_storage_bytes', labelNames: ['tenant'] }),
  activeConnections: new Gauge({ name: 'puregate_active_connections' }),
  errorRate: new Counter({ name: 'puregate_errors_total', labelNames: ['tenant', 'operation', 'code'] }),
};
```

**Health Checks:**

```
GET /health          -> { status: 'ok', uptime, version }
GET /health/ready    -> { db: 'ok', embedder: 'ok', redis: 'ok' }
GET /health/live     -> 200 OK
GET /metrics         -> Prometheus format
```

**Operational Features:**
- Structured JSON logging (pino)
- Request tracing (OpenTelemetry)
- Per-tenant usage dashboards
- Alerting on error rate spikes
- Automated backup per tenant (pg_dump)

---

### Phase 6: Enterprise Features (Week 6-10)

| Feature | Description |
|---------|-------------|
| **SSO/SAML** | Enterprise login via Azure AD, Okta, Google Workspace |
| **RBAC** | Role-based access: admin, editor, viewer per namespace |
| **Audit log** | Immutable log of all operations per tenant |
| **Webhooks** | Notify external systems on memory create/update/delete |
| **SDK/Client libraries** | TypeScript, Python, Go clients |
| **Bulk operations** | Batch import/export via streaming |
| **Retention policies** | Auto-expire by department, document_type, age |
| **Search analytics** | Track popular queries, zero-result queries |
| **Multi-language** | Per-tenant embedding models for different languages |
| **File upload** | Direct PDF/DOCX/HTML ingestion with parsing |

---

## 4. Infrastructure & Deployment

### Recommended Stack

```
Production Environment:
  +-- Kubernetes (EKS/GKE) or Docker Compose
  |   +-- API pods (2-10 replicas, auto-scaling)
  |   +-- Embedding worker pods (1-4 GPU or 2-8 CPU)
  |   +-- Redis (ElastiCache or self-hosted)
  |
  +-- PostgreSQL (RDS/Cloud SQL or self-hosted)
  |   +-- Primary (writes)
  |   +-- Read replica (searches)
  |   +-- Automated backups
  |
  +-- Object Storage (S3/GCS)
  |   +-- Document uploads
  |   +-- Export archives
  |   +-- Backup storage
  |
  +-- Monitoring
      +-- Prometheus + Grafana
      +-- Structured logs (CloudWatch/Loki)
      +-- Alerting (PagerDuty/Slack)
```

### Resource Estimates

| Component | Small (10 tenants) | Medium (100 tenants) | Large (1000+ tenants) |
|-----------|-------------------|---------------------|----------------------|
| **API Nodes** | 2x 1 vCPU, 2GB | 4x 2 vCPU, 4GB | 10x 4 vCPU, 8GB |
| **PostgreSQL** | db.t3.medium | db.r6g.large | db.r6g.xlarge + replica |
| **Redis** | cache.t3.small | cache.r6g.large | cache.r6g.xlarge |
| **Embedding** | 2x CPU workers | 1x GPU (T4) | 2x GPU (A10G) |
| **Storage** | 50GB | 500GB | 5TB+ |
| **Monthly Cost** | ~$200-400 | ~$800-1,500 | ~$3,000-8,000 |

---

## 5. Migration Strategy

### Zero-Downtime Migration Path

```
Step 1: Add HTTP API alongside MCP (dual-mode)
        - MCP still works for Claude Code users
        - HTTP available for web clients

Step 2: Introduce tenant_id + auth layer
        - Existing data assigned to "default" tenant
        - New tenants get isolated databases

Step 3: Abstract storage backend
        - SQLiteBackend (existing, for dev/testing)
        - PostgresBackend (new, for production)
        - Feature flag to switch per environment

Step 4: Migrate data SQLite -> PostgreSQL
        - Export via memory_export
        - Import with re-embedding into PostgreSQL
        - Verify data integrity

Step 5: Scale embedding service
        - Start with OpenAI API (fastest to ship)
        - Optionally migrate to self-hosted GPU later

Step 6: Add Redis caching + monitoring
        - Query cache, embedding cache
        - Prometheus metrics, Grafana dashboards
```

---

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Embedding model change breaks similarity | Search quality degrades | Version embedding model per tenant, re-embed on migration |
| PostgreSQL vector index rebuild is slow | Downtime during migration | Use concurrent index creation, blue/green deployment |
| Tenant data leak via query bug | Security breach | Row-Level Security + integration tests + audit logging |
| High embedding API costs at scale | Budget overrun | Embedding cache + batch processing + usage quotas per tenant |
| SQLite->Postgres migration data loss | Data integrity | Checksums, dual-write period, rollback plan |

---

## 7. What Can Be Reused As-Is

The following modules translate directly to the enterprise version:

| Module | Reusability | Notes |
|--------|-------------|-------|
| `search/hybrid.ts` | **90%** | Core RRF algorithm works; swap DB queries |
| `search/scoring.ts` | **100%** | Confidence scoring is DB-agnostic |
| `search/temporal.ts` | **100%** | Decay functions are pure math |
| `chunking/*` | **100%** | All chunking strategies are stateless |
| `embeddings/provider.ts` | **100%** | Interface already supports swapping providers |
| `tools/*.ts` | **70%** | Logic reusable; add tenant context parameter |
| `types.ts` | **90%** | Add tenant fields, otherwise complete |
| `vault/*` | **80%** | Needs tenant-scoped vault paths |
| `db/schema.ts` | **30%** | Rewrite for PostgreSQL |
| `db/repository.ts` | **40%** | Rewrite queries for PostgreSQL |
| `db/connection.ts` | **10%** | Replace with connection pool |

**Overall: ~60-70% of the business logic is reusable.** The core search algorithm, chunking, scoring, and tool logic carry over. The database and transport layers need replacement.

---

## 8. Conclusion

MCP Memory Server provides a strong foundation for PureGate Knowledge:

- **Hybrid search with RRF** is production-quality
- **Enterprise metadata model** already supports departments, access levels, versioning
- **Smart document chunking** handles diverse content types
- **Pluggable embedding interface** enables easy provider swapping

The primary work is:
1. **HTTP API layer** (~2 weeks)
2. **Multi-tenancy + auth** (~2 weeks)
3. **PostgreSQL + pgvector migration** (~3 weeks)
4. **Scalable embeddings** (~2 weeks)
5. **Caching + monitoring** (~2 weeks)

**Estimated total: 8-12 weeks** to production-ready enterprise platform, leveraging 60-70% of existing code.
