import type { Router, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { EmbeddingProvider, MemoryScope, SortField, SortOrder, SearchMode } from '../types.js';
import { handleSearch } from '../tools/search.js';
import { handleList } from '../tools/list.js';
import { handleGet } from '../tools/get.js';
import { handleUpdate } from '../tools/update.js';
import { handleDelete } from '../tools/delete.js';
import { handleRelated } from '../tools/related.js';
import { handleVersions } from '../tools/versions.js';
import { handleStats } from '../tools/stats.js';
import { handleManifest } from '../tools/manifest.js';

type GetDb = () => Database.Database;
type GetEmbedder = () => Promise<EmbeddingProvider>;

function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : val;
}

function str(val: unknown): string | undefined {
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function int(val: unknown, fallback: number): number {
  const n = parseInt(String(val), 10);
  return Number.isFinite(n) ? n : fallback;
}

function float(val: unknown): number | undefined {
  const n = parseFloat(String(val));
  return Number.isFinite(n) ? n : undefined;
}

function tags(val: unknown): string[] | undefined {
  if (typeof val === 'string' && val.length > 0) {
    return val.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return undefined;
}

export function registerApiRoutes(
  router: Router,
  getDb: GetDb,
  getEmbedder: GetEmbedder,
): void {
  // ── GET /api/stats ──────────────────────────────────────────────────────
  router.get('/api/stats', (req: Request, res: Response) => {
    try {
      const result = handleStats(getDb(), {
        scope: str(req.query.scope),
        namespace: str(req.query.namespace),
        department: str(req.query.department),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /api/search ─────────────────────────────────────────────────────
  router.get('/api/search', async (req: Request, res: Response) => {
    try {
      const q = str(req.query.q);
      if (!q) {
        res.status(400).json({ error: 'Missing required query parameter: q' });
        return;
      }
      const result = await handleSearch(getDb(), await getEmbedder(), {
        query: q,
        scope: str(req.query.scope) as MemoryScope | undefined,
        namespace: str(req.query.namespace),
        department: str(req.query.department),
        document_type: str(req.query.document_type),
        tags: tags(req.query.tags),
        language: str(req.query.language),
        limit: int(req.query.limit, 20),
        offset: int(req.query.offset, 0),
        search_mode: (str(req.query.mode) as SearchMode) ?? 'hybrid',
        min_confidence: float(req.query.min_confidence),
        date_from: str(req.query.date_from),
        date_to: str(req.query.date_to),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /api/memories ───────────────────────────────────────────────────
  router.get('/api/memories', (req: Request, res: Response) => {
    try {
      const result = handleList(getDb(), {
        scope: str(req.query.scope) as MemoryScope | undefined,
        namespace: str(req.query.namespace),
        department: str(req.query.department),
        document_type: str(req.query.document_type),
        limit: int(req.query.limit, 20),
        offset: int(req.query.offset, 0),
        sort_by: (str(req.query.sort_by) as SortField) ?? 'created_at',
        sort_order: (str(req.query.sort_order) as SortOrder) ?? 'desc',
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /api/memories/:id ───────────────────────────────────────────────
  router.get('/api/memories/:id', (req: Request, res: Response) => {
    try {
      const result = handleGet(getDb(), {
        id: param(req, 'id'),
        include_chunks: req.query.include_chunks === 'true',
      });
      if (!result) {
        res.status(404).json({ error: 'Memory not found' });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /api/memories/:id/versions ──────────────────────────────────────
  router.get('/api/memories/:id/versions', (req: Request, res: Response) => {
    try {
      const result = handleVersions(getDb(), {
        id: param(req, 'id'),
        limit: int(req.query.limit, 50),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /api/memories/:id/related ───────────────────────────────────────
  router.get('/api/memories/:id/related', async (req: Request, res: Response) => {
    try {
      const result = await handleRelated(getDb(), await getEmbedder(), {
        id: param(req, 'id'),
        limit: int(req.query.limit, 10),
        min_similarity: float(req.query.min_similarity),
      });
      res.json({ related: result, count: result.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── PATCH /api/memories/:id ─────────────────────────────────────────────
  router.patch('/api/memories/:id', async (req: Request, res: Response) => {
    try {
      const result = await handleUpdate(getDb(), await getEmbedder(), {
        id: param(req, 'id'),
        content: req.body.content,
        title: req.body.title,
        tags: req.body.tags,
        metadata: req.body.metadata,
        expires_at: req.body.expires_at,
        changed_by: req.body.changed_by ?? 'web-dashboard',
      });
      if (!result) {
        res.status(404).json({ error: 'Memory not found' });
        return;
      }
      res.json({ updated: true, memory: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── DELETE /api/memories/:id ────────────────────────────────────────────
  router.delete('/api/memories/:id', (req: Request, res: Response) => {
    try {
      const result = handleDelete(getDb(), { id: param(req, 'id') });
      if (result.deleted === 0) {
        res.status(404).json({ error: 'Memory not found' });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /api/graph ──────────────────────────────────────────────────────
  router.get('/api/graph', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const embedder = await getEmbedder();
      const limit = int(req.query.limit, 200);
      const minImportance = float(req.query.min_importance) ?? 0;

      // Get top memories by importance (non-chunks only)
      const listResult = handleList(db, {
        limit,
        offset: 0,
        sort_by: 'importance_score',
        sort_order: 'desc',
      });

      const nodes = listResult.items.filter(
        (m) => m.parent_id === null && m.importance_score >= minImportance,
      );

      // Build edges from related memories (top 5 per node)
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
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── GET /api/manifest ─────────────────────────────────────────────────
  router.get('/api/manifest', (req: Request, res: Response) => {
    try {
      const result = handleManifest(getDb(), {
        scope: str(req.query.scope) as MemoryScope | undefined,
        namespace: str(req.query.namespace),
        department: str(req.query.department),
        document_type: str(req.query.document_type),
        limit: int(req.query.limit, 500),
        offset: int(req.query.offset, 0),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
