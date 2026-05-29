import type { Application, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import type { z, ZodTypeAny } from 'zod';
import type { EmbeddingProvider } from '../types.js';
import { handleSearch } from '../tools/search.js';
import { handleList } from '../tools/list.js';
import { handleGet } from '../tools/get.js';
import { handleUpdate } from '../tools/update.js';
import { handleDelete } from '../tools/delete.js';
import { handleRelated } from '../tools/related.js';
import { handleVersions } from '../tools/versions.js';
import { handleStats } from '../tools/stats.js';
import { handleManifest } from '../tools/manifest.js';
import { getLinksAmong } from '../graph/memory-links.js';
import {
  getPublishedPages,
  getPublishedPage,
  getPublishedGraph,
  getPublishedIdSet,
  renderIndexHtml,
  renderPageHtml,
} from '../publish/wiki.js';
import {
  ApiSearchQuerySchema,
  ApiListQuerySchema,
  ApiManifestQuerySchema,
  ApiGraphQuerySchema,
  ApiStatsQuerySchema,
  ApiGetQuerySchema,
  ApiVersionsQuerySchema,
  ApiRelatedQuerySchema,
  ApiPatchBodySchema,
} from '../schemas/index.js';
import { logger } from '../lib/logger.js';
import { metrics } from './metrics.js';

type GetDb = () => Database.Database;
type GetEmbedder = () => Promise<EmbeddingProvider>;

// Per-process cache for /api/graph. Recomputing the graph runs N embedder
// calls + N vec queries — typical dashboard refresh patterns slam this on
// every slider change, so a small TTL gives us idempotent re-renders for
// free.
const GRAPH_CACHE_TTL_MS = 60_000;
const graphCache = new Map<string, { ts: number; payload: unknown }>();

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
  }
}

function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

function parseOrThrow<S extends ZodTypeAny>(schema: S, raw: unknown): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, 'INVALID_INPUT', 'Invalid request input', parsed.error.flatten());
  }
  return parsed.data;
}

function sendError(res: Response, err: unknown): void {
  const requestId = res.locals.requestId as string | undefined;
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.message,
      code: err.code,
      requestId,
      issues: err.issues,
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({
    error: 'Internal Server Error',
    code: 'INTERNAL',
    requestId,
    detail: process.env.NODE_ENV === 'production' ? undefined : message,
  });
}

function asyncHandler(
  routeName: string,
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  // Use async/try-catch so synchronous throws (e.g. zod parse failures from
  // parseOrThrow) are also routed to sendError. Promise.resolve(fn()) misses
  // sync throws because fn is invoked before resolve wraps it.
  return async (req, res, next) => {
    const startNs = process.hrtime.bigint();
    try {
      await fn(req, res, next);
    } catch (err) {
      sendError(res, err);
    } finally {
      const durationMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      const status = res.statusCode;
      const statusClass = `${Math.floor(status / 100)}xx`;
      metrics.apiRequests.inc({ route: routeName, method: req.method, status: statusClass });
      metrics.apiLatency.observe({ route: routeName }, durationMs / 1000);
      logger.info({
        event: 'http_request',
        requestId: res.locals.requestId,
        route: routeName,
        method: req.method,
        status,
        duration_ms: Math.round(durationMs),
      });
    }
  };
}

export function registerApiRoutes(
  router: Application,
  getDb: GetDb,
  getEmbedder: GetEmbedder,
): void {
  // ── GET /api/stats ──────────────────────────────────────────────────────
  router.get('/api/stats', asyncHandler('GET /api/stats', (req, res) => {
    const q = parseOrThrow(ApiStatsQuerySchema, req.query);
    const result = handleStats(getDb(), q);
    res.json(result);
  }));

  // ── GET /api/search ─────────────────────────────────────────────────────
  router.get('/api/search', asyncHandler('GET /api/search', async (req, res) => {
    const q = parseOrThrow(ApiSearchQuerySchema, req.query);
    const result = await handleSearch(getDb(), await getEmbedder(), {
      query: q.q,
      scope: q.scope,
      namespace: q.namespace,
      department: q.department,
      document_type: q.document_type,
      tags: q.tags,
      language: q.language,
      limit: q.limit,
      offset: q.offset,
      search_mode: q.mode,
      min_confidence: q.min_confidence,
      date_from: q.date_from,
      date_to: q.date_to,
    });
    res.json(result);
  }));

  // ── GET /api/memories ───────────────────────────────────────────────────
  router.get('/api/memories', asyncHandler('GET /api/memories', (req, res) => {
    const q = parseOrThrow(ApiListQuerySchema, req.query);
    const result = handleList(getDb(), q);
    res.json(result);
  }));

  // ── GET /api/memories/:id ───────────────────────────────────────────────
  router.get('/api/memories/:id', asyncHandler('GET /api/memories/:id', (req, res) => {
    const q = parseOrThrow(ApiGetQuerySchema, req.query);
    const result = handleGet(getDb(), {
      id: param(req, 'id'),
      include_chunks: q.include_chunks ?? false,
    });
    if (!result) {
      throw new HttpError(404, 'NOT_FOUND', 'Memory not found');
    }
    res.json(result);
  }));

  // ── GET /api/memories/:id/versions ──────────────────────────────────────
  router.get('/api/memories/:id/versions', asyncHandler('GET /api/memories/:id/versions', (req, res) => {
    const q = parseOrThrow(ApiVersionsQuerySchema, req.query);
    const result = handleVersions(getDb(), {
      id: param(req, 'id'),
      limit: q.limit,
    });
    res.json(result);
  }));

  // ── GET /api/memories/:id/related ───────────────────────────────────────
  router.get('/api/memories/:id/related', asyncHandler('GET /api/memories/:id/related', async (req, res) => {
    const q = parseOrThrow(ApiRelatedQuerySchema, req.query);
    const result = await handleRelated(getDb(), await getEmbedder(), {
      id: param(req, 'id'),
      limit: q.limit,
      min_similarity: q.min_similarity,
    });
    res.json({ related: result, count: result.length });
  }));

  // ── PATCH /api/memories/:id ─────────────────────────────────────────────
  router.patch('/api/memories/:id', asyncHandler('PATCH /api/memories/:id', async (req, res) => {
    const body = parseOrThrow(ApiPatchBodySchema, req.body);
    const result = await handleUpdate(getDb(), await getEmbedder(), {
      id: param(req, 'id'),
      content: body.content,
      title: body.title,
      tags: body.tags,
      metadata: body.metadata,
      expires_at: body.expires_at,
      changed_by: body.changed_by ?? 'web-dashboard',
    });
    if (!result) {
      throw new HttpError(404, 'NOT_FOUND', 'Memory not found');
    }
    res.json({ updated: true, memory: result });
  }));

  // ── DELETE /api/memories/:id ────────────────────────────────────────────
  router.delete('/api/memories/:id', asyncHandler('DELETE /api/memories/:id', (req, res) => {
    const result = handleDelete(getDb(), { id: param(req, 'id') });
    if (result.deleted === 0) {
      throw new HttpError(404, 'NOT_FOUND', 'Memory not found');
    }
    res.json(result);
  }));

  // ── GET /api/graph ──────────────────────────────────────────────────────
  // The graph endpoint is structurally O(N) embeddings + O(N) vec queries
  // per request (handleRelated re-embeds each node's content). For dashboard
  // refreshes we cache the assembled nodes+edges for GRAPH_CACHE_TTL_MS keyed
  // on (limit, min_importance). Pass ?refresh=1 to bypass.
  router.get('/api/graph', asyncHandler('GET /api/graph', async (req, res) => {
    const q = parseOrThrow(ApiGraphQuerySchema, req.query);
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const cacheKey = `${q.limit}|${q.min_importance ?? 0}`;
    const now = Date.now();

    const cached = !refresh ? graphCache.get(cacheKey) : undefined;
    if (cached && now - cached.ts < GRAPH_CACHE_TTL_MS) {
      res.json(cached.payload);
      return;
    }

    const db = getDb();
    const minImportance = q.min_importance ?? 0;

    const listResult = handleList(db, {
      limit: q.limit,
      offset: 0,
      sort_by: 'importance_score',
      sort_order: 'desc',
    });

    const nodes = listResult.items.filter(
      (m) => m.parent_id === null && m.importance_score >= minImportance,
    );

    // Edges come from the persistent multi-signal edge store (wikilink +
    // co-occurrence + similarity), not from per-node re-embedding. Each edge
    // carries its relation, source_kind, and confidence tag. `similarity` is
    // kept (= confidence_score) for backward compatibility with the D3 view.
    const links = getLinksAmong(db, nodes.map((n) => n.id));
    const edges = links.map((l) => ({
      source: l.source_memory_id,
      target: l.target_memory_id,
      similarity: l.confidence_score,
      relation: l.relation,
      kind: l.source_kind,
      confidence: l.confidence,
    }));

    const payload = { nodes, edges, total: nodes.length };
    graphCache.set(cacheKey, { ts: now, payload });
    res.json(payload);
  }));

  // ── GET /api/manifest ─────────────────────────────────────────────────
  router.get('/api/manifest', asyncHandler('GET /api/manifest', (req, res) => {
    const q = parseOrThrow(ApiManifestQuerySchema, req.query);
    const result = handleManifest(getDb(), q);
    res.json(result);
  }));
}

/**
 * Obsidian-Publish-style read-only "memory wiki" (Pillar 6 / T18).
 *
 * Mounted at /publish and intentionally NOT behind bearer auth — this is the
 * public sharing surface. Access control is enforced in the data layer
 * (`src/publish/wiki.ts`): every query is scoped to the namespace AND an
 * `access_level` allowlist, and link traversal re-applies the filter, so a
 * non-published memory is unreachable via the index, a direct page-by-id, the
 * graph, backlinks, OR search. All user data is HTML-escaped at render time.
 */
export function registerPublishRoutes(
  router: Application,
  getDb: GetDb,
  getEmbedder: GetEmbedder,
): void {
  // ── GET /publish/:namespace — HTML index ────────────────────────────────
  router.get('/publish/:namespace', asyncHandler('GET /publish/:namespace', (req, res) => {
    const namespace = param(req, 'namespace');
    const pages = getPublishedPages(getDb(), { namespace });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderIndexHtml(namespace, pages));
  }));

  // ── GET /publish/:namespace/graph — JSON (published only) ───────────────
  router.get('/publish/:namespace/graph', asyncHandler('GET /publish/:namespace/graph', (req, res) => {
    const namespace = param(req, 'namespace');
    res.json(getPublishedGraph(getDb(), { namespace }));
  }));

  // ── GET /publish/:namespace/search?q= — JSON, published pages only ──────
  router.get('/publish/:namespace/search', asyncHandler('GET /publish/:namespace/search', async (req, res) => {
    const namespace = param(req, 'namespace');
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (q.trim().length === 0) {
      res.json({ results: [], total: 0 });
      return;
    }
    const db = getDb();
    // Access gating is the post-filter against the published id set — it is the
    // single authority and honors the full MCP_PUBLISH_ACCESS_LEVELS allowlist
    // (same gate as index/page/graph). We deliberately do NOT pass access_level
    // to handleSearch: hardcoding 'public' would under-expose namespaces whose
    // allowlist also includes 'internal'. Search only scopes by namespace; the
    // intersection with publishedIds enforces which access levels are visible.
    const publishedIds = getPublishedIdSet(db, { namespace });
    const search = await handleSearch(db, await getEmbedder(), {
      query: q,
      namespace,
      detail_level: 'summary',
    });
    const results = (search.results as Array<{ id: string }>).filter((r) =>
      publishedIds.has(r.id),
    );
    res.json({ results, total: results.length });
  }));

  // ── GET /publish/:namespace/page/:id — HTML page or 404 JSON ────────────
  router.get('/publish/:namespace/page/:id', asyncHandler('GET /publish/:namespace/page/:id', (req, res) => {
    const namespace = param(req, 'namespace');
    const id = param(req, 'id');
    const page = getPublishedPage(getDb(), { namespace, id });
    if (!page) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderPageHtml(namespace, page));
  }));
}
