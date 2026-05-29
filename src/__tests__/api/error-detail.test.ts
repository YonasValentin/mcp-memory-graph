/**
 * Finding 5 (MINOR): the 500 error envelope must be safe-by-default.
 * Previously `detail` was exposed unless NODE_ENV === 'production', so the raw
 * internal error (e.g. a better-sqlite3 message or a filesystem path) leaked
 * whenever NODE_ENV was unset (the default for a locally-run binary). Now detail
 * is only included when NODE_ENV === 'development'.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { buildApp } from '../../cli/serve.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { RateLimiter } from '../../api/rate-limit.js';

function request(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { host: '127.0.0.1' } },
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

let db: Database.Database;
let server: http.Server | undefined;
let port: number;
let prevNodeEnv: string | undefined;

async function bootBrokenDb(): Promise<void> {
  process.env.MCP_AUTH_OPTIONAL = '1';
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
  // Closing the DB makes the next query throw → unhandled → 500 INTERNAL.
  db.close();
}

afterEach(async () => {
  delete process.env.MCP_AUTH_OPTIONAL;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('500 error detail is safe-by-default', () => {
  it('does NOT leak detail when NODE_ENV is unset', async () => {
    prevNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    await bootBrokenDb();
    const res = await request(port, '/api/stats');
    expect([500, 503]).toContain(res.status);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('INTERNAL');
    expect(body.error).toBe('Internal Server Error');
    expect(body.detail).toBeUndefined();
  });

  it('does NOT leak detail when NODE_ENV=production', async () => {
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    await bootBrokenDb();
    const res = await request(port, '/api/stats');
    expect([500, 503]).toContain(res.status);
    expect(JSON.parse(res.body).detail).toBeUndefined();
  });

  it('DOES include detail when NODE_ENV=development', async () => {
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    await bootBrokenDb();
    const res = await request(port, '/api/stats');
    expect([500, 503]).toContain(res.status);
    expect(typeof JSON.parse(res.body).detail).toBe('string');
  });
});
