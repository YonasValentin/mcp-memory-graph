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

type GetDb = () => Database.Database;
type GetEmbedder = () => Promise<EmbeddingProvider>;

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
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  // Use async/try-catch so synchronous throws (e.g. zod parse failures from
  // parseOrThrow) are also routed to sendError. Promise.resolve(fn()) misses
  // sync throws because fn is invoked before resolve wraps it.
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      sendError(res, err);
    }
  };
}

export function registerApiRoutes(
  router: Application,
  getDb: GetDb,
  getEmbedder: GetEmbedder,
): void {
  // ── GET /api/stats ──────────────────────────────────────────────────────
  router.get('/api/stats', asyncHandler((req, res) => {
    const q = parseOrThrow(ApiStatsQuerySchema, req.query);
    const result = handleStats(getDb(), q);
    res.json(result);
  }));

  // ── GET /api/search ─────────────────────────────────────────────────────
  router.get('/api/search', asyncHandler(async (req, res) => {
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
  router.get('/api/memories', asyncHandler((req, res) => {
    const q = parseOrThrow(ApiListQuerySchema, req.query);
    const result = handleList(getDb(), q);
    res.json(result);
  }));

  // ── GET /api/memories/:id ───────────────────────────────────────────────
  router.get('/api/memories/:id', asyncHandler((req, res) => {
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
  router.get('/api/memories/:id/versions', asyncHandler((req, res) => {
    const q = parseOrThrow(ApiVersionsQuerySchema, req.query);
    const result = handleVersions(getDb(), {
      id: param(req, 'id'),
      limit: q.limit,
    });
    res.json(result);
  }));

  // ── GET /api/memories/:id/related ───────────────────────────────────────
  router.get('/api/memories/:id/related', asyncHandler(async (req, res) => {
    const q = parseOrThrow(ApiRelatedQuerySchema, req.query);
    const result = await handleRelated(getDb(), await getEmbedder(), {
      id: param(req, 'id'),
      limit: q.limit,
      min_similarity: q.min_similarity,
    });
    res.json({ related: result, count: result.length });
  }));

  // ── PATCH /api/memories/:id ─────────────────────────────────────────────
  router.patch('/api/memories/:id', asyncHandler(async (req, res) => {
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
  router.delete('/api/memories/:id', asyncHandler((req, res) => {
    const result = handleDelete(getDb(), { id: param(req, 'id') });
    if (result.deleted === 0) {
      throw new HttpError(404, 'NOT_FOUND', 'Memory not found');
    }
    res.json(result);
  }));

  // ── GET /api/graph ──────────────────────────────────────────────────────
  router.get('/api/graph', asyncHandler(async (req, res) => {
    const q = parseOrThrow(ApiGraphQuerySchema, req.query);
    const db = getDb();
    const embedder = await getEmbedder();
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

    const edges: Array<{ source: string; target: string; similarity: number }> = [];
    const nodeIds = new Set(nodes.map((n) => n.id));

    for (const node of nodes) {
      const related = await handleRelated(db, embedder, {
        id: node.id,
        limit: 5,
        min_similarity: 0.3,
      });
      for (const rel of related) {
        if (nodeIds.has(rel.memory.id)) {
          edges.push({
            source: node.id,
            target: rel.memory.id,
            similarity: rel.score,
          });
        }
      }
    }

    res.json({ nodes, edges, total: nodes.length });
  }));

  // ── GET /api/manifest ─────────────────────────────────────────────────
  router.get('/api/manifest', asyncHandler((req, res) => {
    const q = parseOrThrow(ApiManifestQuerySchema, req.query);
    const result = handleManifest(getDb(), q);
    res.json(result);
  }));
}
