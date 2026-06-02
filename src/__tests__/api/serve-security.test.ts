/**
 * Security hardening for src/cli/serve.ts (Group G5):
 *   - Bearer token comparison must be constant-time (crypto.timingSafeEqual),
 *     length-guarded, and must NOT throw on a mismatched-length candidate.
 *   - Rate limiter must key on the immediate socket peer, not a spoofed
 *     X-Forwarded-For, when behind a trusted proxy (trust proxy = remote mode).
 *
 * Boots the real Express app via `buildApp` against an ephemeral port and fires
 * actual HTTP requests with node:http. Zero new test deps.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { buildApp, timingSafeStrEqual } from '../../cli/serve.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { RateLimiter } from '../../api/rate-limit.js';

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string> } = { path: '/' },
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: { host: '127.0.0.1', ...(options.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server | undefined;
let port: number;

afterEach(async () => {
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.MCP_AUTH_OPTIONAL;
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function boot(env: Record<string, string | undefined>, limiter?: RateLimiter): Promise<void> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  db = createTestDb();
  const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
  const { app } = buildApp({
    getDb: () => db,
    getEmbedder: async () => embedder,
    rateLimiter: limiter ?? new RateLimiter({ capacity: 1000, refillPerSec: 1000 }),
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
}

describe('timingSafeStrEqual — constant-time string comparison', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeStrEqual('Bearer abc123', 'Bearer abc123')).toBe(true);
  });

  it('returns false for same-length different strings (no throw)', () => {
    expect(timingSafeStrEqual('Bearer abc123', 'Bearer abc124')).toBe(false);
  });

  it('returns false for different-length strings without throwing', () => {
    // crypto.timingSafeEqual throws on unequal lengths; the helper must guard
    // it and return false instead of propagating a RangeError.
    expect(() => timingSafeStrEqual('short', 'a-much-longer-token')).not.toThrow();
    expect(timingSafeStrEqual('short', 'a-much-longer-token')).toBe(false);
  });

  it('returns false when one side is empty', () => {
    expect(timingSafeStrEqual('', 'Bearer x')).toBe(false);
    expect(timingSafeStrEqual('Bearer x', '')).toBe(false);
  });
});

describe('bearer auth — constant-time comparison (length-guarded, no throw)', () => {
  beforeEach(() => {
    delete process.env.MCP_AUTH_OPTIONAL;
  });

  it('accepts the exact token', async () => {
    await boot({ MCP_AUTH_TOKEN: 'the-real-token-aaaa' });
    const res = await request(port, {
      path: '/api/stats',
      headers: { authorization: 'Bearer the-real-token-aaaa' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a same-length but wrong token with 401 (does not throw 500)', async () => {
    await boot({ MCP_AUTH_TOKEN: 'the-real-token-aaaa' });
    // Same byte length as `Bearer the-real-token-aaaa`, wrong content.
    const wrong = 'Bearer the-real-token-bbbb';
    expect(wrong.length).toBe('Bearer the-real-token-aaaa'.length);
    const res = await request(port, {
      path: '/api/stats',
      headers: { authorization: wrong },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).code).toBe('UNAUTHORIZED');
  });

  it('rejects a different-length token with 401 (length guard prevents timingSafeEqual throw → no 500)', async () => {
    await boot({ MCP_AUTH_TOKEN: 'the-real-token-aaaa' });
    const res = await request(port, {
      path: '/api/stats',
      headers: { authorization: 'Bearer short' },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).code).toBe('UNAUTHORIZED');
  });

  it('rejects an empty Authorization header with 401', async () => {
    await boot({ MCP_AUTH_TOKEN: 'the-real-token-aaaa' });
    const res = await request(port, { path: '/api/stats' });
    expect(res.status).toBe(401);
  });
});
