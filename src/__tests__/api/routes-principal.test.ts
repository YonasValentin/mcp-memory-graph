/**
 * RBAC v1 §5 — REST routes under a principal context. The pre-RBAC sites read
 * `forcedApiNamespace() ?? q.namespace`, which under a principal would SILENTLY
 * redirect a caller-chosen namespace to namespaces[0]. They now reuse
 * scopeToNamespace: member → kept, unset → key default, foreign → the tenancy
 * throw, mapped to a 403 NAMESPACE_NOT_PERMITTED in the error handler.
 *
 * The harness installs a runWithPrincipal middleware in front of the real
 * registerApiRoutes — the exact mechanism the §4 auth middleware will use
 * (ALS propagates through Express's downstream sync/async chain).
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
import { registerApiRoutes, registerPublishRoutes } from '../../api/routes.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';

const KEY: PrincipalContext = {
  principal: 'multi-bot',
  keyId: 'key-1',
  namespaces: ['sales', 'marketing'],
  maxAccessLevel: 'internal',
};

let db: Database.Database;
let server: http.Server | undefined;
const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());

function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          host: '127.0.0.1',
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

beforeEach(async () => {
  delete process.env.MCP_API_NAMESPACE;
  db = createTestDb();
  await handleStore(db, embedder, { content: 'alpha in sales', namespace: 'sales', scope: 'project' });
  await handleStore(db, embedder, { content: 'beta in marketing', namespace: 'marketing', scope: 'project' });
  await handleStore(db, embedder, { content: 'gamma in hr', namespace: 'hr', scope: 'project' });

  // The §4 auth middleware will wrap `next()` in runWithPrincipal exactly
  // like this; everything downstream (handlers, awaits) sees the context.
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    runWithPrincipal(KEY, () => next());
  });
  registerApiRoutes(app as Application, () => db, async () => embedder);
  // /api/insights + /api/health + /api/webhooks live in registerPublishRoutes.
  registerPublishRoutes(app as Application, () => db, async () => embedder);
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

describe('REST reads under a principal context', () => {
  it('unset namespace defaults to namespaces[0]', async () => {
    const res = await request(port(), 'GET', '/api/memories');
    expect(res.status).toBe(200);
    const items = (JSON.parse(res.body) as { items: Array<{ namespace: string }> }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((m) => m.namespace === 'sales')).toBe(true);
  });

  it('a MEMBER namespace param is honored (multi-namespace key switches per call)', async () => {
    const res = await request(port(), 'GET', '/api/memories?namespace=marketing');
    expect(res.status).toBe(200);
    const items = (JSON.parse(res.body) as { items: Array<{ namespace: string }> }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((m) => m.namespace === 'marketing')).toBe(true);
  });

  it('a FOREIGN namespace param is a 403 NAMESPACE_NOT_PERMITTED — not a silent redirect', async () => {
    const res = await request(port(), 'GET', '/api/memories?namespace=hr');
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body) as { error: string; code: string };
    expect(body.code).toBe('NAMESPACE_NOT_PERMITTED');
    expect(body.error).toBe('Namespace not permitted');
  });

  it('search + stats enforce the same rule', async () => {
    const ok = await request(port(), 'GET', '/api/search?q=beta&namespace=marketing');
    expect(ok.status).toBe(200);
    const denied = await request(port(), 'GET', '/api/search?q=gamma&namespace=hr');
    expect(denied.status).toBe(403);
    const stats = await request(port(), 'GET', '/api/stats?namespace=hr');
    expect(stats.status).toBe(403);
  });

  it('webhook register refuses a foreign namespace with 403 (not a 400 wrap)', async () => {
    const res = await request(port(), 'POST', '/api/webhooks', {
      url: 'https://hook.example.com/x',
      namespace: 'hr',
    });
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('NAMESPACE_NOT_PERMITTED');
  });
});
