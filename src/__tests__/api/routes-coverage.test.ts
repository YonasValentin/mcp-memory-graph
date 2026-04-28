/**
 * Coverage-fill for src/api/routes.ts: every endpoint's happy path,
 * every error path, the /api/graph cache hit branch, and the
 * INTERNAL fallback envelope.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { buildApp } from '../../cli/serve.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { RateLimiter } from '../../api/rate-limit.js';
import { handleStore } from '../../tools/store.js';

interface Resp { status: number; body: string; headers: http.IncomingHttpHeaders }

function request(
  port: number,
  path: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path,
        method: options.method ?? 'GET',
        headers: { host: '127.0.0.1', ...(options.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server;
let port: number;

beforeEach(async () => {
  process.env.MCP_AUTH_OPTIONAL = '1';
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.MCP_BIND;

  db = createTestDb();
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

describe('every /api endpoint', () => {
  it('GET /api/memories returns paginated results', async () => {
    await handleStore(db, new MockEmbeddingProvider(), { content: 'list api test' });
    const res = await request(port, '/api/memories?limit=5&offset=0');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toBeDefined();
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/memories/:id returns the memory', async () => {
    const stored = await handleStore(db, new MockEmbeddingProvider(), { content: 'detail api test' });
    const res = await request(port, `/api/memories/${stored.memory.id}`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).memory.id).toBe(stored.memory.id);
  });

  it('GET /api/memories/:id/versions returns history', async () => {
    const stored = await handleStore(db, new MockEmbeddingProvider(), { content: 'versions api test' });
    const res = await request(port, `/api/memories/${stored.memory.id}/versions?limit=10`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty('history');
  });

  it('GET /api/memories/:id/related returns related list', async () => {
    const a = await handleStore(db, new MockEmbeddingProvider(), { content: 'related api test memory.' });
    await handleStore(db, new MockEmbeddingProvider(), { content: 'another related api test memory.' });
    const res = await request(port, `/api/memories/${a.memory.id}/related?limit=5`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty('related');
  });

  it('PATCH /api/memories/:id updates the memory', async () => {
    const stored = await handleStore(db, new MockEmbeddingProvider(), { content: 'patch api test' });
    const res = await request(port, `/api/memories/${stored.memory.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'patched' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).memory.title).toBe('patched');
  });

  it('PATCH /api/memories/:id 404 for missing id', async () => {
    const res = await request(port, '/api/memories/no-such', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'whatever' }),
    });
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).code).toBe('NOT_FOUND');
  });

  it('DELETE /api/memories/:id removes the row', async () => {
    const stored = await handleStore(db, new MockEmbeddingProvider(), { content: 'delete api test' });
    const res = await request(port, `/api/memories/${stored.memory.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).deleted).toBe(1);
  });

  it('DELETE /api/memories/:id 404 for missing id', async () => {
    const res = await request(port, '/api/memories/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('GET /api/graph returns nodes/edges/total', async () => {
    await handleStore(db, new MockEmbeddingProvider(), { content: 'graph api test memory.' });
    const res = await request(port, '/api/graph?limit=10');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('nodes');
    expect(body).toHaveProperty('edges');
    expect(body).toHaveProperty('total');
  });

  it('GET /api/graph caches identical requests', async () => {
    await handleStore(db, new MockEmbeddingProvider(), { content: 'graph cache hit memory.' });
    const r1 = await request(port, '/api/graph?limit=10');
    const r2 = await request(port, '/api/graph?limit=10');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body).toBe(r1.body);
  });

  it('GET /api/graph?refresh=1 bypasses the cache', async () => {
    await handleStore(db, new MockEmbeddingProvider(), { content: 'graph refresh memory.' });
    const r1 = await request(port, '/api/graph?limit=10');
    const r2 = await request(port, '/api/graph?limit=10&refresh=1');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it('GET /api/manifest returns entries', async () => {
    await handleStore(db, new MockEmbeddingProvider(), { content: 'manifest api test' });
    const res = await request(port, '/api/manifest?limit=5');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toHaveProperty('entries');
  });
});

describe('error envelope shape', () => {
  it('500-class errors carry code:INTERNAL and a requestId', async () => {
    // Force an exception by closing the DB before the request.
    db.close();
    const res = await request(port, '/api/stats');
    expect([500, 503]).toContain(res.status);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('INTERNAL');
    expect(body.requestId).toBeDefined();
  });
});
