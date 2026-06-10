/**
 * GET /api/search `detail` parameter.
 *
 * Pre-fix: the route always returned handleSearch's default summary
 * projection (flat {id, title, snippet, ...}), while the bundled web
 * dashboard's Search page was built against the full nested
 * {memory, score, confidence, match_type} shape — every search from the UI
 * crashed on `r.memory.id`. The route now forwards an optional
 * `detail=id_only|summary|full` (default summary, preserving the existing
 * REST contract).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../cli/serve.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { RateLimiter } from '../../api/rate-limit.js';
import { handleStore } from '../../tools/store.js';

let server: http.Server;
let port: number;

function request(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { host: '127.0.0.1' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  process.env.MCP_AUTH_OPTIONAL = '1';
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.MCP_BIND;

  const db = createTestDb();
  const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
  await handleStore(db, embedder, {
    title: 'Pooling decision',
    content: 'We use pgBouncer in transaction mode for connection pooling.',
    document_type: 'decision',
  });
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

describe('GET /api/search detail parameter', () => {
  it('defaults to the flat summary projection (existing REST contract)', async () => {
    const res = await request('/api/search?q=pooling');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].id).toBeDefined();
    expect(body.results[0].snippet).toBeDefined();
    expect(body.results[0].memory).toBeUndefined();
  });

  it('detail=full returns the nested {memory, ...} shape the dashboard renders', async () => {
    const res = await request('/api/search?q=pooling&detail=full');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results.length).toBeGreaterThan(0);
    const r = body.results[0];
    expect(r.memory.id).toBeDefined();
    expect(r.memory.content).toContain('pgBouncer');
    expect(r.memory.tags).toBeDefined();
    expect(r.confidence_level).toBeDefined();
    expect(r.match_type).toBeDefined();
  });

  it('rejects an unknown detail value with 400 INVALID_INPUT', async () => {
    const res = await request('/api/search?q=pooling&detail=garbage');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_INPUT');
  });
});
