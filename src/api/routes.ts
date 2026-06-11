import type { Application, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import type { z, ZodTypeAny } from 'zod';
import type { EmbeddingProvider } from '../types.js';
import { handleSearch } from '../tools/search.js';
import { hybridSearch, toSummary } from '../search/hybrid.js';
import { handleList } from '../tools/list.js';
import { handleGet } from '../tools/get.js';
import { handleUpdate } from '../tools/update.js';
import { handleDelete } from '../tools/delete.js';
import { handleRelated } from '../tools/related.js';
import { handleVersions } from '../tools/versions.js';
import { handleStats } from '../tools/stats.js';
import { handleManifest } from '../tools/manifest.js';
import { handleInsights } from '../tools/insights.js';
import { handleHealth } from '../tools/health.js';
import { handleWebhook } from '../tools/webhooks.js';
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
// T1: shared MCP_API_NAMESPACE tenancy policy (one source for MCP + REST).
import {
  forcedNamespace,
  idIsInForcedNamespace,
  idIsWithinAccessCeiling,
  scopeToNamespace,
  principalAccessCeiling,
  NAMESPACE_NOT_PERMITTED,
} from '../lib/tenancy.js';
import { ReloadGate, maybeBustGraphCache } from '../lib/hot-reload.js';
import { resolveDbPath } from '../db/db-path.js';
import { metrics } from './metrics.js';

type GetDb = () => Database.Database;
type GetEmbedder = () => Promise<EmbeddingProvider>;

// Per-process cache for /api/graph. Recomputing the graph runs N embedder
// calls + N vec queries — typical dashboard refresh patterns slam this on
// every slider change, so a small TTL gives us idempotent re-renders for
// free.
const GRAPH_CACHE_TTL_MS = 60_000;
const graphCache = new Map<string, { ts: number; payload: unknown }>();

// (T26) Hot-reload gate over the DB file. SQLite already exposes committed
// writes from other connections to our live connection, so query freshness is
// automatic; the staleness risk is purely the derived `graphCache` above. When
// the DB file is rewritten out-of-band (background writer / git-hook rebuild /
// `git pull`), this gate detects it by (mtime_ns, size) and busts the cache —
// without reopening the connection. Resolve the path once: if env is unset and
// the default file is absent, the gate is a no-op (shouldReload stays false).
const dbFilePath = resolveDbPath();
const graphReloadGate = new ReloadGate(dbFilePath);

// Public /publish search cost bounds. The /publish surface is unauthenticated
// and runs a query embedding (and optionally rerank) per request — an attacker
// flooding distinct queries is a CPU DoS lever. Cap the query length so a single
// request can't pin the embedder, and oversample published results within a hard
// ceiling so the published post-filter never under-returns (F6) while still
// bounding work.
const PUBLISH_SEARCH_MAX_QUERY_LEN = 512;
const PUBLISH_SEARCH_DISPLAY_LIMIT = 20;
const PUBLISH_SEARCH_OVERSAMPLE = 100;

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
  // RBAC §5: the tenancy helpers throw an explicit deny when a principal names
  // a namespace outside its key's set — surface it as a clean 403, never a 500.
  if (message === NAMESPACE_NOT_PERMITTED) {
    res.status(403).json({ error: message, code: 'NAMESPACE_NOT_PERMITTED', requestId });
    return;
  }
  // Safe-by-default: only surface the raw internal message in explicit
  // development. When NODE_ENV is unset (the default for a locally-run binary)
  // or 'production', return a generic message so better-sqlite3 errors, file
  // paths, etc. don't leak in the JSON body.
  res.status(500).json({
    error: 'Internal Server Error',
    code: 'INTERNAL',
    requestId,
    detail: process.env.NODE_ENV === 'development' ? message : undefined,
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

/**
 * Remote-namespace scoping (P2.5). When MCP_API_NAMESPACE is set, the read API
 * force-scopes every corpus query to that namespace — so a single self-hosted
 * instance can safely expose exactly one shared namespace (a team points its
 * dashboard/clients at it) without leaking other namespaces. Unset → the global
 * view (today's behaviour). The forced value takes precedence over any
 * client-supplied `namespace`.
 */
export function forcedApiNamespace(): string | undefined {
  // T1: delegate to the shared policy reader. Kept as a named re-export so the
  // existing web/ and route imports (and remote-namespace tests) stay stable.
  return forcedNamespace();
}

export function registerApiRoutes(
  router: Application,
  getDb: GetDb,
  getEmbedder: GetEmbedder,
): void {
  /**
   * Enforce MCP_API_NAMESPACE tenancy on by-ID routes. The list/search/stats
   * endpoints already force the namespace into their query, but by-ID
   * read/update/delete bypassed that — a namespace-scoped instance must not
   * read, mutate, or delete a memory belonging to another namespace. Returns
   * 404 (not 403) so a scoped instance does not even confirm the id exists.
   */
  function assertNamespaceAllowed(id: string): void {
    // T1: shared ownership check; this surface throws 404 (does not even
    // confirm the id exists) instead of returning a boolean. RBAC §6: an
    // over-ceiling row is the SAME non-confirmation (a capped principal can't
    // tell "wrong level" from "absent"). assertNamespaceAllowed also fronts the
    // by-id WRITE routes (PATCH/DELETE) — a capped principal must not mutate a
    // row it isn't even allowed to read.
    if (!idIsInForcedNamespace(getDb(), id) || !idIsWithinAccessCeiling(getDb(), id)) {
      throw new HttpError(404, 'NOT_FOUND', 'Memory not found');
    }
  }
  // ── GET /api/stats ──────────────────────────────────────────────────────
  router.get('/api/stats', asyncHandler('GET /api/stats', (req, res) => {
    const q = parseOrThrow(ApiStatsQuerySchema, req.query);
    const result = handleStats(getDb(), { ...q, namespace: scopeToNamespace({ namespace: q.namespace }).namespace });
    res.json(result);
  }));

  // ── GET /api/search ─────────────────────────────────────────────────────
  router.get('/api/search', asyncHandler('GET /api/search', async (req, res) => {
    const q = parseOrThrow(ApiSearchQuerySchema, req.query);
    const result = await handleSearch(getDb(), await getEmbedder(), {
      query: q.q,
      scope: q.scope,
      // RBAC §5: scopeToNamespace replaces the ad-hoc `forcedApiNamespace() ??`
      // — env-forced/unforced byte-identical; a principal gets member-keep /
      // unset-default / foreign-throw (mapped to 403 in sendError).
      namespace: scopeToNamespace({ namespace: q.namespace }).namespace,
      // RBAC §6: a principal's egress ceiling (undefined in legacy/local modes →
      // no change). Distinct from any caller `access_level` filter; both apply.
      access_level_ceiling: principalAccessCeiling(),
      department: q.department,
      document_type: q.document_type,
      tags: q.tags,
      language: q.language,
      limit: q.limit,
      offset: q.offset,
      search_mode: q.mode,
      detail_level: q.detail,
      min_confidence: q.min_confidence,
      date_from: q.date_from,
      date_to: q.date_to,
    });
    res.json(result);
  }));

  // ── GET /api/memories ───────────────────────────────────────────────────
  router.get('/api/memories', asyncHandler('GET /api/memories', (req, res) => {
    const q = parseOrThrow(ApiListQuerySchema, req.query);
    const result = handleList(getDb(), {
      ...q,
      namespace: scopeToNamespace({ namespace: q.namespace }).namespace,
      access_level_ceiling: principalAccessCeiling(),
    });
    res.json(result);
  }));

  // ── GET /api/memories/:id ───────────────────────────────────────────────
  router.get('/api/memories/:id', asyncHandler('GET /api/memories/:id', (req, res) => {
    const q = parseOrThrow(ApiGetQuerySchema, req.query);
    assertNamespaceAllowed(param(req, 'id'));
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
    assertNamespaceAllowed(param(req, 'id'));
    const result = handleVersions(getDb(), {
      id: param(req, 'id'),
      limit: q.limit,
    });
    res.json(result);
  }));

  // ── GET /api/memories/:id/related ───────────────────────────────────────
  router.get('/api/memories/:id/related', asyncHandler('GET /api/memories/:id/related', async (req, res) => {
    const q = parseOrThrow(ApiRelatedQuerySchema, req.query);
    assertNamespaceAllowed(param(req, 'id'));
    const result = await handleRelated(getDb(), await getEmbedder(), {
      id: param(req, 'id'),
      limit: q.limit,
      min_similarity: q.min_similarity,
      // §6: assertNamespaceAllowed already 404'd an over-ceiling SEED above; this
      // bounds the returned NEIGHBOURS to the principal's ceiling too.
      access_level_ceiling: principalAccessCeiling(),
    });
    res.json({ related: result, count: result.length });
  }));

  // ── PATCH /api/memories/:id ─────────────────────────────────────────────
  router.patch('/api/memories/:id', asyncHandler('PATCH /api/memories/:id', async (req, res) => {
    const body = parseOrThrow(ApiPatchBodySchema, req.body);
    assertNamespaceAllowed(param(req, 'id'));
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
    assertNamespaceAllowed(param(req, 'id'));
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
    // RBAC §6/§5: the cache is process-wide but the namespace AND access ceiling
    // are now PER-REQUEST (principal mode), so the key MUST include both — else
    // principal B could be served principal A's cached nodes (cross-tenant /
    // over-ceiling leak via the cache). Legacy/local modes resolve these to
    // stable process values, so the key is unchanged there.
    const ceiling = principalAccessCeiling();
    const cacheKey = `${q.limit}|${q.min_importance ?? 0}|${forcedApiNamespace() ?? ''}|${ceiling ? ceiling.join(',') : ''}`;
    const now = Date.now();

    // If the DB file changed on disk since the last request, every cached graph
    // payload is potentially stale — drop them all before the TTL lookup so the
    // dashboard reflects an external rebuild without ?refresh=1 or a restart.
    maybeBustGraphCache(graphReloadGate, graphCache);

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
      namespace: forcedApiNamespace(),
      // RBAC §6: /api/graph emits node CONTENT (it renders list items), so cap it
      // to the principal's ceiling. Edges are derived only among the kept nodes,
      // so an over-ceiling node never appears as a graph endpoint either.
      access_level_ceiling: principalAccessCeiling(),
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
    const result = handleManifest(getDb(), {
      ...q,
      namespace: scopeToNamespace({ namespace: q.namespace }).namespace,
      access_level_ceiling: principalAccessCeiling(),
    });
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
    // Bound public search cost: reject an over-long query BEFORE embedding it so
    // a single unauthenticated request can't pin the CPU-heavy embedder (F3).
    if (q.length > PUBLISH_SEARCH_MAX_QUERY_LEN) {
      throw new HttpError(
        400,
        'INVALID_INPUT',
        `Query too long (max ${PUBLISH_SEARCH_MAX_QUERY_LEN} chars)`,
      );
    }
    const db = getDb();
    // Access gating is the intersection with the published id set — it is the
    // single authority and honors the full MCP_PUBLISH_ACCESS_LEVELS allowlist
    // (same gate as index/page/graph). We deliberately do NOT pass access_level
    // to the search: hardcoding 'public' would under-expose namespaces whose
    // allowlist also includes 'internal'. Search only scopes by namespace; the
    // intersection with publishedIds enforces which access levels are visible.
    //
    // SECURITY (F4): call hybridSearch DIRECTLY instead of handleSearch. The
    // /publish surface is unauthenticated and must be side-effect free —
    // handleSearch records access (bumps access_count/importance/stability and
    // writes memory_access_log) for EVERY hit BEFORE this post-filter, letting an
    // anonymous caller mutate non-published rows. hybridSearch is read-only.
    //
    // RECALL (F6): oversample, then intersect with publishedIds, THEN take the
    // display window — so higher-ranked non-published rows can't push published
    // pages out of a too-small top-N.
    const publishedIds = getPublishedIdSet(db, { namespace });
    const { results } = await hybridSearch(db, await getEmbedder(), {
      query: q,
      namespace,
      limit: PUBLISH_SEARCH_OVERSAMPLE,
      offset: 0,
      search_mode: 'hybrid',
    });
    const published = results
      .filter((r) => publishedIds.has(r.memory.id))
      .slice(0, PUBLISH_SEARCH_DISPLAY_LIMIT)
      .map(toSummary);
    res.json({ results: published, total: published.length });
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

  // ── M3.2 GET /api/insights ──────────────────────────────────────────────
  router.get('/api/insights', asyncHandler('GET /api/insights', (req, res) => {
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    res.json(
      handleInsights(getDb(), {
        scope: typeof req.query.scope === 'string' ? req.query.scope : undefined,
        namespace: scopeToNamespace({
          namespace: typeof req.query.namespace === 'string' ? req.query.namespace : undefined,
        }).namespace,
        limit: Number.isFinite(limit) ? limit : undefined,
      }),
    );
  }));

  // ── M3.2 GET /api/health ────────────────────────────────────────────────
  router.get('/api/health', asyncHandler('GET /api/health', (req, res) => {
    res.json(
      handleHealth(getDb(), {
        scope: typeof req.query.scope === 'string' ? req.query.scope : undefined,
        namespace: scopeToNamespace({
          namespace: typeof req.query.namespace === 'string' ? req.query.namespace : undefined,
        }).namespace,
      }),
    );
  }));

  // ── M3.1 webhook bus management (gated on MCP_WEBHOOKS inside the handler) ──
  // These sit behind the same bearer middleware as the rest of /api. The handler
  // SSRF-validates any URL before persisting and never returns secrets.
  // battle-v16 WH-TENANCY: every webhook route is namespace-pinned under a forced
  // deployment (forcedApiNamespace) — list/register/delete may only touch the
  // caller's own tenant. Mirrors the MCP memory_webhook boundary.
  router.get('/api/webhooks', asyncHandler('GET /api/webhooks', async (_req, res) => {
    res.json(await handleWebhook(getDb(), { action: 'list' }, forcedApiNamespace()));
  }));

  router.post('/api/webhooks', asyncHandler('POST /api/webhooks', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // RBAC §5: the pinned tenant for this register is scopeToNamespace over the
    // caller's namespace — env-forced byte-identical (override); a principal
    // gets member-keep / unset-default / foreign-throw. Computed BEFORE the
    // try so the deny surfaces as the 403 mapping, not the 400 wrap below.
    const pinnedNs =
      forcedApiNamespace() !== undefined
        ? scopeToNamespace({ namespace: typeof b.namespace === 'string' ? b.namespace : undefined })
            .namespace
        : undefined;
    try {
      res.json(
        await handleWebhook(getDb(), {
          action: 'register',
          url: typeof b.url === 'string' ? b.url : undefined,
          secret: typeof b.secret === 'string' ? b.secret : undefined,
          events: typeof b.events === 'string' ? b.events : undefined,
          scope: typeof b.scope === 'string' ? b.scope : undefined,
          namespace: typeof b.namespace === 'string' ? b.namespace : undefined,
        }, pinnedNs),
      );
    } catch (err) {
      throw new HttpError(400, 'INVALID_INPUT', err instanceof Error ? err.message : 'Invalid webhook target');
    }
  }));

  router.delete('/api/webhooks/:id', asyncHandler('DELETE /api/webhooks/:id', async (req, res) => {
    res.json(await handleWebhook(getDb(), { action: 'delete', id: param(req, 'id') }, forcedApiNamespace()));
  }));

  router.post('/api/webhooks/dispatch', asyncHandler('POST /api/webhooks/dispatch', async (_req, res) => {
    res.json(await handleWebhook(getDb(), { action: 'dispatch' }));
  }));
}
