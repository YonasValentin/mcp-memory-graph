/**
 * RBAC v1 §6 — access-level egress ceiling, ENFORCED end-to-end.
 *
 * Part A (REST): a runWithPrincipal middleware (the exact mechanism the §4 auth
 * middleware uses) in front of the real registerApiRoutes proves the ceiling is
 * THREADED at the route chokepoint (principalAccessCeiling()) — an 'internal'
 * key never receives confidential/restricted rows via /api/search, /api/memories,
 * /api/memories/:id (404 non-confirmation), /related, /api/manifest, /api/graph.
 *
 * Part B (tool handlers): the MCP-only content-egress tools (memory_query,
 * memory_query_structured, memory_export, memory_export_dataset, memory_related)
 * get the ceiling via the SAME helper — driven here by calling the handler with
 * access_level_ceiling = principalAccessCeiling() inside runWithPrincipal, which
 * is what server.ts's scopedRead/withCeiling pass.
 *
 * Legacy/local mode (no principal) returns undefined ceiling → every row visible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Application } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { handleStore } from '../../tools/store.js';
import { handleQuery } from '../../tools/query.js';
import { handleExport } from '../../tools/export.js';
import { handleExportDataset } from '../../tools/export-dataset.js';
import { handleRelated } from '../../tools/related.js';
import { runStructuredQuery } from '../../search/structured-query.js';
import { registerApiRoutes } from '../../api/routes.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';
import { principalAccessCeiling } from '../../lib/tenancy.js';
import type { AccessLevel } from '../../types.js';

const NS = 'edc';
const INTERNAL_KEY: PrincipalContext = {
  principal: 'internal-bot',
  keyId: 'k-int',
  namespaces: [NS],
  maxAccessLevel: 'internal',
};

const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
let db: Database.Database;
let server: http.Server | undefined;
const ids: Record<AccessLevel, string> = {} as Record<AccessLevel, string>;

function request(port: number, method: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { host: '127.0.0.1' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  delete process.env.MCP_API_NAMESPACE;
  delete process.env.MCP_DATASET_MAX_ACCESS_LEVEL;
  db = createTestDb();
  // One row per access level, all in the same namespace + scope, with linkable
  // content so search/related/query all find them.
  for (const level of ['public', 'internal', 'confidential', 'restricted'] as AccessLevel[]) {
    const stored = await handleStore(db, embedder, {
      content: `apollo rocket telemetry ${level} band`,
      title: `apollo-${level}`,
      namespace: NS,
      scope: 'project',
      access_level: level,
      // 'decision' makes it eligible for export_dataset's high-signal filter.
      document_type: 'decision',
      importance_score: 0.9,
      confidence_score: 0.9,
    });
    ids[level] = stored.memory.id;
  }

  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runWithPrincipal(INTERNAL_KEY, () => next()));
  registerApiRoutes(app as Application, () => db, async () => embedder);
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
});

afterEach(async () => {
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((r) => s.close(() => r()));
  }
  db?.close();
});

function port(): number {
  return (server!.address() as AddressInfo).port;
}

describe('§6 REST — an internal key never receives confidential/restricted rows', () => {
  it('/api/memories (list) hides confidential + restricted', async () => {
    const res = await request(port(), 'GET', '/api/memories?limit=50');
    expect(res.status).toBe(200);
    const items = (JSON.parse(res.body) as { items: Array<{ access_level: string }> }).items;
    const levels = new Set(items.map((m) => m.access_level));
    expect(levels.has('public')).toBe(true);
    expect(levels.has('internal')).toBe(true);
    expect(levels.has('confidential')).toBe(false);
    expect(levels.has('restricted')).toBe(false);
  });

  it('/api/search hides confidential + restricted (positive access_level filter still composes)', async () => {
    const res = await request(port(), 'GET', '/api/search?q=apollo%20telemetry&limit=50&detail=full');
    expect(res.status).toBe(200);
    const results = (JSON.parse(res.body) as { results: Array<{ memory: { access_level: string } }> }).results;
    const levels = new Set(results.map((r) => r.memory.access_level));
    expect(levels.has('confidential')).toBe(false);
    expect(levels.has('restricted')).toBe(false);
    // at least the permitted ones are reachable
    expect(results.length).toBeGreaterThan(0);
  });

  it('/api/memories/:id of a confidential row → 404 (non-confirmation), permitted row → 200', async () => {
    const ok = await request(port(), 'GET', `/api/memories/${ids.internal}`);
    expect(ok.status).toBe(200);
    const conf = await request(port(), 'GET', `/api/memories/${ids.confidential}`);
    expect(conf.status).toBe(404);
    const restr = await request(port(), 'GET', `/api/memories/${ids.restricted}`);
    expect(restr.status).toBe(404);
  });

  it('/api/memories/:id/related of a confidential SEED → 404; permitted seed never returns over-ceiling neighbours', async () => {
    const denied = await request(port(), 'GET', `/api/memories/${ids.confidential}/related?limit=50`);
    expect(denied.status).toBe(404);
    const ok = await request(port(), 'GET', `/api/memories/${ids.public}/related?limit=50`);
    expect(ok.status).toBe(200);
    const related = (JSON.parse(ok.body) as { related: Array<{ memory: { access_level: string } }> }).related;
    for (const r of related) {
      expect(['public', 'internal']).toContain(r.memory.access_level);
    }
  });

  it('/api/manifest hides confidential + restricted titles', async () => {
    const res = await request(port(), 'GET', '/api/manifest?limit=50');
    expect(res.status).toBe(200);
    const entries = (JSON.parse(res.body) as { entries: Array<{ title: string | null }> }).entries;
    const titles = entries.map((e) => e.title);
    expect(titles).toContain('apollo-internal');
    expect(titles).not.toContain('apollo-confidential');
    expect(titles).not.toContain('apollo-restricted');
  });

  it('/api/graph emits only nodes at/below the ceiling', async () => {
    const res = await request(port(), 'GET', '/api/graph?limit=50&refresh=1');
    expect(res.status).toBe(200);
    const nodes = (JSON.parse(res.body) as { nodes: Array<{ access_level: string }> }).nodes;
    const levels = new Set(nodes.map((n) => n.access_level));
    expect(levels.has('confidential')).toBe(false);
    expect(levels.has('restricted')).toBe(false);
  });
});

describe('§6 tool handlers — ceiling threaded the same way server.ts does', () => {
  it('memory_export omits confidential/restricted under the ceiling', () => {
    runWithPrincipal(INTERNAL_KEY, () => {
      const ceiling = principalAccessCeiling();
      const data = handleExport(db, { namespace: NS, access_level_ceiling: ceiling });
      const levels = new Set(data.memories.map((m) => m.access_level));
      expect(levels.has('public')).toBe(true);
      expect(levels.has('internal')).toBe(true);
      expect(levels.has('confidential')).toBe(false);
      expect(levels.has('restricted')).toBe(false);
    });
  });

  it('memory_query_structured omits confidential/restricted under the ceiling', () => {
    runWithPrincipal(INTERNAL_KEY, () => {
      const ceiling = principalAccessCeiling();
      const res = runStructuredQuery(db, {
        filter: { namespace: NS },
        limit: 50,
        access_level_ceiling: ceiling,
      });
      const levels = new Set(res.items.map((i) => (i as { access_level: string }).access_level));
      expect(levels.has('confidential')).toBe(false);
      expect(levels.has('restricted')).toBe(false);
      expect(levels.has('internal')).toBe(true);
    });
  });

  it('memory_query (graph traversal) renders only at/below-ceiling nodes', async () => {
    await runWithPrincipal(INTERNAL_KEY, async () => {
      const ceiling = principalAccessCeiling();
      const res = await handleQuery(db, embedder, {
        query: 'apollo rocket telemetry',
        namespace: NS,
        access_level_ceiling: ceiling,
      });
      // Rendered context must not name the over-ceiling rows.
      expect(res.context).not.toContain('apollo-confidential');
      expect(res.context).not.toContain('apollo-restricted');
    });
  });

  it('memory_related (handler) filters over-ceiling neighbours', async () => {
    await runWithPrincipal(INTERNAL_KEY, async () => {
      const ceiling = principalAccessCeiling();
      const related = await handleRelated(db, embedder, {
        id: ids.public,
        limit: 50,
        access_level_ceiling: ceiling,
      });
      for (const r of related) {
        expect(['public', 'internal']).toContain(r.memory.access_level);
      }
    });
  });

  it('memory_export_dataset composes the principal ceiling with the env cap (MIN)', () => {
    // env cap = confidential, principal ceiling = internal → effective = internal.
    process.env.MCP_DATASET_MAX_ACCESS_LEVEL = 'confidential';
    runWithPrincipal(INTERNAL_KEY, () => {
      const ceiling = principalAccessCeiling();
      const out = handleExportDataset(db, { namespace: NS, access_level_ceiling: ceiling });
      // Reconstruct the access level of each emitted prompt by matching titles.
      // (export_dataset emits prompt/completion, not access_level — assert via count:
      // only public+internal decisions qualify, so confidential/restricted are out.)
      // Each sample's prompt is the title; check none are the confidential/restricted ones.
      const prompts = out.samples.map((s) => JSON.stringify(s));
      expect(prompts.some((p) => p.includes('apollo-internal'))).toBe(true);
      expect(prompts.some((p) => p.includes('apollo-confidential'))).toBe(false);
      expect(prompts.some((p) => p.includes('apollo-restricted'))).toBe(false);
    });
    delete process.env.MCP_DATASET_MAX_ACCESS_LEVEL;
  });
});

describe('§6 legacy/local mode — no ceiling, everything visible', () => {
  it('with NO principal, /api/memories returns all four levels', async () => {
    // Re-mount routes WITHOUT the principal middleware.
    const app2 = express();
    app2.use(express.json());
    registerApiRoutes(app2 as Application, () => db, async () => embedder);
    const s2 = app2.listen(0, '127.0.0.1');
    await new Promise<void>((r) => s2.on('listening', () => r()));
    const p2 = (s2.address() as AddressInfo).port;
    try {
      const res = await request(p2, 'GET', '/api/memories?limit=50');
      const items = (JSON.parse(res.body) as { items: Array<{ access_level: string }> }).items;
      const levels = new Set(items.map((m) => m.access_level));
      expect(levels.has('confidential')).toBe(true);
      expect(levels.has('restricted')).toBe(true);
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
    }
  });
});
