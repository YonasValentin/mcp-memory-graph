// ── Memory REST API Routes ────────────────────────────────────────────────

import type { StorageBackend } from '../../enterprise/storage.js';
import type { EmbeddingProvider } from '../../types.js';
import type { Logger } from '../../enterprise/logger.js';
import type { Metrics } from '../../enterprise/metrics.js';
import type { CacheService } from '../../enterprise/cache.js';
import type { TenantContext } from '../../enterprise/tenant.js';
import { requirePermission } from '../../enterprise/tenant.js';
import { chunkContent } from '../../chunking/chunker.js';
import type { ContentType } from '../../types.js';

interface RouteDeps {
  storage: StorageBackend;
  embedder: EmbeddingProvider;
  logger: Logger;
  metrics: Metrics;
  cache: CacheService;
}

export async function registerMemoryRoutes(app: any, deps: RouteDeps): Promise<void> {
  const { storage, embedder, logger, metrics, cache } = deps;

  // ── POST /api/v1/memories ─────────────────────────────────────────────
  app.post('/api/v1/memories', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const input = request.body;
    const start = performance.now();
    const embedding = await embedder.embed(input.content);
    const memory = await storage.storeMemory(ctx, input, embedding);

    metrics.incMemoriesStored(ctx.tenantId);
    metrics.observeSearchDuration(ctx.tenantId, 'store', (performance.now() - start) / 1000);

    // Invalidate search cache for this tenant
    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});

    reply.code(201).send({ stored: true, memory });
  });

  // ── POST /api/v1/memories/search ──────────────────────────────────────
  app.post('/api/v1/memories/search', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    const input = request.body;
    const start = performance.now();

    const queryEmbedding = await embedder.embed(input.query);
    const results = await storage.hybridSearch(ctx, {
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
    }, queryEmbedding);

    const duration = (performance.now() - start) / 1000;
    metrics.observeSearchDuration(ctx.tenantId, input.search_mode ?? 'hybrid', duration);

    reply.send({ results, total: results.length, duration_ms: Math.round(duration * 1000) });
  });

  // ── GET /api/v1/memories/:id ──────────────────────────────────────────
  app.get('/api/v1/memories/:id', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    const { id } = request.params;
    const memory = await storage.getMemory(ctx, id);
    if (!memory) {
      reply.code(404).send({ error: 'Not Found', message: 'Memory not found' });
      return;
    }

    const includeChunks = request.query.include_chunks === 'true';
    if (includeChunks) {
      const chunks = await storage.getChunks(ctx, id);
      reply.send({ memory, chunks });
    } else {
      reply.send({ memory });
    }
  });

  // ── PUT /api/v1/memories/:id ──────────────────────────────────────────
  app.put('/api/v1/memories/:id', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const { id } = request.params;
    const updates = request.body;

    let newEmbedding: Float32Array | undefined;
    if (updates.content) {
      newEmbedding = await embedder.embed(updates.content);
    }

    const memory = await storage.updateMemory(ctx, id, {
      ...updates,
      changed_by: ctx.userId,
    }, newEmbedding);

    if (!memory) {
      reply.code(404).send({ error: 'Not Found', message: 'Memory not found' });
      return;
    }

    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});
    reply.send({ updated: true, memory });
  });

  // ── DELETE /api/v1/memories/:id ───────────────────────────────────────
  app.delete('/api/v1/memories/:id', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'delete', 'memories');

    const { id } = request.params;
    const deleted = await storage.deleteMemory(ctx, id);

    if (!deleted) {
      reply.code(404).send({ error: 'Not Found', message: 'Memory not found' });
      return;
    }

    metrics.incMemoriesDeleted(ctx.tenantId, 1);
    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});
    reply.send({ deleted: true });
  });

  // ── DELETE /api/v1/memories (bulk) ────────────────────────────────────
  app.delete('/api/v1/memories', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'delete', 'memories');

    const filter = request.body;
    const count = await storage.deleteMemoriesByFilter(ctx, filter);

    metrics.incMemoriesDeleted(ctx.tenantId, count);
    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});
    reply.send({ deleted: count });
  });

  // ── GET /api/v1/memories ──────────────────────────────────────────────
  app.get('/api/v1/memories', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    const result = await storage.listMemories(ctx, {
      scope: request.query.scope as any,
      namespace: request.query.namespace,
      department: request.query.department,
      document_type: request.query.document_type,
      limit: parseInt(request.query.limit ?? '20', 10),
      offset: parseInt(request.query.offset ?? '0', 10),
      sort_by: request.query.sort_by ?? 'created_at',
      sort_order: request.query.sort_order ?? 'desc',
    });

    reply.send(result);
  });

  // ── POST /api/v1/memories/ingest ──────────────────────────────────────
  app.post('/api/v1/memories/ingest', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const input = request.body;
    const contentType = (input.content_type ?? 'text') as ContentType;
    const chunkSize = input.chunk_size ?? 512;
    const chunkOverlap = input.chunk_overlap ?? 50;

    const chunkResults = chunkContent(input.content, {
      content_type: contentType,
      chunk_size: chunkSize,
      overlap: chunkOverlap,
    });

    const chunkTexts = chunkResults.map(c => c.content);
    const chunkEmbeddings = await embedder.embedBatch(chunkTexts);

    const chunks = chunkResults.map((c, i) => ({
      content: c.content,
      embedding: chunkEmbeddings[i],
      chunkIndex: c.chunk_index,
    }));

    const result = await storage.ingestDocument(ctx, input, chunks);

    metrics.incMemoriesStored(ctx.tenantId);
    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});
    reply.code(201).send(result);
  });

  // ── GET /api/v1/memories/:id/related ──────────────────────────────────
  app.get('/api/v1/memories/:id/related', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    const { id } = request.params;
    const memory = await storage.getMemory(ctx, id);
    if (!memory) {
      reply.code(404).send({ error: 'Not Found', message: 'Memory not found' });
      return;
    }

    const embedding = await embedder.embed(memory.content);
    const limit = parseInt(request.query.limit ?? '5', 10);
    const minSimilarity = request.query.min_similarity ? parseFloat(request.query.min_similarity) : undefined;

    const related = await storage.findRelated(ctx, id, embedding, limit, minSimilarity);
    reply.send({ related, count: related.length });
  });

  // ── GET /api/v1/memories/:id/versions ─────────────────────────────────
  app.get('/api/v1/memories/:id/versions', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    const { id } = request.params;
    const limit = parseInt(request.query.limit ?? '10', 10);
    const result = await storage.getVersions(ctx, id, limit);
    reply.send(result);
  });

  // ── GET /api/v1/stats ─────────────────────────────────────────────────
  app.get('/api/v1/stats', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    const result = await storage.getStats(ctx, {
      scope: request.query.scope,
      namespace: request.query.namespace,
      department: request.query.department,
    });
    reply.send(result);
  });

  // ── POST /api/v1/export ───────────────────────────────────────────────
  app.post('/api/v1/export', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'read', 'memories');

    const filter = request.body ?? {};
    const result = await storage.exportMemories(ctx, filter);
    reply.send(result);
  });

  // ── POST /api/v1/import ───────────────────────────────────────────────
  app.post('/api/v1/import', async (request: any, reply: any) => {
    const ctx: TenantContext = request.tenantContext;
    requirePermission(ctx, 'write', 'memories');

    const { data, overwrite } = request.body;
    const embeddings = await embedder.embedBatch(data.map((d: any) => d.content));
    const result = await storage.importMemories(ctx, data, embeddings, overwrite ?? false);

    await cache.invalidateSearchCache(ctx.tenantId).catch(() => {});
    reply.send(result);
  });
}
