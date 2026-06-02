/**
 * Coverage for the Phase 3 hardening at the HTTP boundary (W3).
 *
 * Pre-fix: src/api/routes.ts cast query strings directly into typed enums
 * (`as MemoryScope`, `as SortField`, etc.) without validation. Junk like
 * `?mode=garbage` silently fell through. Post-fix: every /api route runs
 * its query/body through a Zod schema and returns a uniform 400 envelope.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../cli/serve.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { RateLimiter } from '../../api/rate-limit.js';

let server: http.Server;
let port: number;

function request(path: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { host: '127.0.0.1' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  process.env.MCP_AUTH_OPTIONAL = '1';
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.MCP_BIND;
  delete process.env.MCP_ALLOWED_ORIGINS;

  const db = createTestDb();
  const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
  const { app } = buildApp({
    getDb: () => db,
    getEmbedder: async () => embedder,
    rateLimiter: new RateLimiter({ capacity: 1000, refillPerSec: 1000 }),
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  delete process.env.MCP_AUTH_OPTIONAL;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/search input validation', () => {
  it('rejects an unknown search mode with 400 INVALID_INPUT', async () => {
    const res = await request('/api/search?q=hello&mode=garbage');
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('INVALID_INPUT');
    expect(body.requestId).toBeDefined();
    expect(body.issues).toBeDefined();
  });

  it('rejects a missing query with 400', async () => {
    const res = await request('/api/search');
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('INVALID_INPUT');
  });

  it('rejects out-of-range limit with 400', async () => {
    const res = await request('/api/search?q=hi&limit=9999');
    expect(res.status).toBe(400);
  });

  it('rejects an unknown scope with 400', async () => {
    const res = await request('/api/search?q=hi&scope=hacker');
    expect(res.status).toBe(400);
  });

  it('accepts a valid search', async () => {
    const res = await request('/api/search?q=hi&mode=hybrid&limit=10');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/memories input validation', () => {
  it('rejects unknown sort_by', async () => {
    const res = await request('/api/memories?sort_by=cheese');
    expect(res.status).toBe(400);
  });

  it('rejects unknown sort_order', async () => {
    const res = await request('/api/memories?sort_order=ascending');
    expect(res.status).toBe(400);
  });

  it('accepts default-only request', async () => {
    const res = await request('/api/memories');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/memories/:id', () => {
  it('returns 404 with NOT_FOUND code when the id does not exist', async () => {
    const res = await request('/api/memories/does-not-exist');
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('NOT_FOUND');
    expect(body.requestId).toBeDefined();
  });
});
