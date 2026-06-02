/**
 * P2.5 — remote namespace scoping: when MCP_API_NAMESPACE is set, the read API
 * force-scopes every corpus query to that namespace, so a self-hosted instance
 * can expose exactly one shared namespace without leaking others.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { buildApp } from '../../cli/serve.js';
import { forcedApiNamespace as forcedFromRoutes } from '../../api/routes.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { RateLimiter } from '../../api/rate-limit.js';
import { handleStore } from '../../tools/store.js';

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { host: '127.0.0.1' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server | undefined;
const prev = process.env.MCP_API_NAMESPACE;

afterEach(async () => {
  if (prev === undefined) delete process.env.MCP_API_NAMESPACE;
  else process.env.MCP_API_NAMESPACE = prev;
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((r) => s.close(() => r()));
  }
  db?.close();
});

describe('forcedApiNamespace helper (P2.5)', () => {
  it('returns undefined when unset/empty, the value when set', () => {
    delete process.env.MCP_API_NAMESPACE;
    expect(forcedFromRoutes()).toBeUndefined();
    process.env.MCP_API_NAMESPACE = '';
    expect(forcedFromRoutes()).toBeUndefined();
    process.env.MCP_API_NAMESPACE = 'team';
    expect(forcedFromRoutes()).toBe('team');
  });
});

describe('read API force-scopes to MCP_API_NAMESPACE (P2.5)', () => {
  it('GET /api/memories returns only the forced namespace', async () => {
    process.env.MCP_AUTH_OPTIONAL = '1';
    process.env.MCP_API_NAMESPACE = 'nsA';
    db = createTestDb();
    const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
    await handleStore(db, embedder, { content: 'alpha in A', namespace: 'nsA', scope: 'project' });
    await handleStore(db, embedder, { content: 'beta in B', namespace: 'nsB', scope: 'project' });

    const { app } = buildApp({
      getDb: () => db,
      getEmbedder: async () => embedder,
      rateLimiter: new RateLimiter({ capacity: 1000, refillPerSec: 1000 }),
    });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    const port = (server!.address() as AddressInfo).port;

    // Even though the client requests namespace=nsB, the forced scope wins.
    const res = await get(port, '/api/memories?namespace=nsB');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    const namespaces = body.items.map((m: { namespace: string }) => m.namespace);
    expect(namespaces.length).toBeGreaterThan(0);
    expect(namespaces.every((n: string) => n === 'nsA')).toBe(true);
    delete process.env.MCP_AUTH_OPTIONAL;
  });
});
