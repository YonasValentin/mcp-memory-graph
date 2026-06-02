/**
 * End-to-end coverage for Phase 2 hardening on the HTTP surface:
 *   C2 — bearer auth on /api (was: only /mcp).
 *   C3 — CORS allowlist (was: Access-Control-Allow-Origin: *).
 *   B4 — body size limit (was: unbounded).
 *   W4 — loopback default bind (server is wired but tests use 127.0.0.1).
 *   Rate-limiter — token bucket per IP.
 *
 * Boots the real Express app via `buildApp` against an ephemeral port and
 * fires actual HTTP requests with node:http. Zero new test deps.
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
import { CURRENT_SCHEMA_VERSION } from '../../db/schema.js';

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string } = { path: '/' },
): Promise<Response> {
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
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
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
let limiter: RateLimiter;

async function bootApp(env: Partial<NodeJS.ProcessEnv>): Promise<void> {
  // Snapshot + apply env so per-test config sticks.
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  db = createTestDb();
  const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
  limiter = new RateLimiter({ capacity: 5, refillPerSec: 1 });
  const { app } = buildApp({
    getDb: () => db,
    getEmbedder: async () => embedder,
    rateLimiter: limiter,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
}

beforeEach(() => {
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.MCP_ALLOWED_ORIGINS;
  delete process.env.MCP_BODY_LIMIT;
  delete process.env.MCP_BIND;
  delete process.env.MCP_AUTH_OPTIONAL;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('auth — bearer token gates /api and /mcp (C2)', () => {
  it('rejects /api without a bearer when token is set', async () => {
    await bootApp({ MCP_AUTH_TOKEN: 'sekrit' });
    const res = await request(port, { path: '/api/stats' });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).code).toBe('UNAUTHORIZED');
  });

  it('accepts /api with a correct bearer token', async () => {
    await bootApp({ MCP_AUTH_TOKEN: 'sekrit' });
    const res = await request(port, {
      path: '/api/stats',
      headers: { authorization: 'Bearer sekrit' },
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('total_memories');
  });

  it('rejects /mcp without bearer when token is set', async () => {
    await bootApp({ MCP_AUTH_TOKEN: 'sekrit' });
    const res = await request(port, {
      path: '/mcp',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    });
    expect(res.status).toBe(401);
  });

  it('refuses to start when bound to 0.0.0.0 without a token', async () => {
    process.env.MCP_BIND = '0.0.0.0';
    delete process.env.MCP_AUTH_TOKEN;
    expect(() =>
      buildApp({
        getDb: () => createTestDb(),
        getEmbedder: async () => new MockEmbeddingProvider(),
      }),
    ).toThrowError(/MCP_AUTH_TOKEN is not set/);
    delete process.env.MCP_BIND;
  });

  it('opt-in unauthenticated bind via MCP_AUTH_OPTIONAL=1', async () => {
    await bootApp({ MCP_AUTH_OPTIONAL: '1' });
    const res = await request(port, { path: '/api/stats' });
    expect(res.status).toBe(200);
  });
});

describe('CORS — allowlist (C3)', () => {
  it('does NOT echo Access-Control-Allow-Origin for an unlisted origin', async () => {
    await bootApp({
      MCP_AUTH_OPTIONAL: '1',
      MCP_ALLOWED_ORIGINS: 'http://localhost:5173',
    });
    const res = await request(port, {
      path: '/api/stats',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // Vary: Origin is always present so caches don't conflate origins.
    expect(res.headers['vary']).toContain('Origin');
  });

  it('echoes Access-Control-Allow-Origin for an allowlisted origin', async () => {
    await bootApp({
      MCP_AUTH_OPTIONAL: '1',
      MCP_ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:4173',
    });
    const res = await request(port, {
      path: '/api/stats',
      headers: { origin: 'http://localhost:4173' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4173');
  });

  it('answers OPTIONS preflight for allowlisted origin with 204', async () => {
    await bootApp({
      MCP_AUTH_OPTIONAL: '1',
      MCP_ALLOWED_ORIGINS: 'http://localhost:5173',
    });
    const res = await request(port, {
      method: 'OPTIONS',
      path: '/api/stats',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });
});

describe('body limit (B4)', () => {
  it('rejects PATCH body larger than the configured limit with 413', async () => {
    await bootApp({ MCP_AUTH_OPTIONAL: '1', MCP_BODY_LIMIT: '1kb' });
    const big = JSON.stringify({ content: 'x'.repeat(2048) });
    const res = await request(port, {
      method: 'PATCH',
      path: '/api/memories/abc',
      headers: { 'content-type': 'application/json', 'content-length': String(big.length) },
      body: big,
    });
    expect(res.status).toBe(413);
  });
});

describe('rate limiter', () => {
  it('returns 429 with Retry-After when bucket is exhausted', async () => {
    await bootApp({ MCP_AUTH_OPTIONAL: '1' });
    // Limiter capacity is 5 — 6th request from the same IP should 429.
    let lastStatus = 0;
    let retryAfter: string | undefined;
    for (let i = 0; i < 8; i++) {
      const res = await request(port, { path: '/api/stats' });
      lastStatus = res.status;
      retryAfter = res.headers['retry-after'] as string | undefined;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
    expect(retryAfter).toBeDefined();
  });
});

describe('request id', () => {
  it('echoes a stable X-Request-Id on every response', async () => {
    await bootApp({ MCP_AUTH_OPTIONAL: '1' });
    const res = await request(port, { path: '/live' });
    expect(res.status).toBe(200);
    expect(typeof res.headers['x-request-id']).toBe('string');
    expect((res.headers['x-request-id'] as string).length).toBeGreaterThan(0);
  });

  it('reuses incoming X-Request-Id when client supplies a safe value', async () => {
    await bootApp({ MCP_AUTH_OPTIONAL: '1' });
    const res = await request(port, {
      path: '/live',
      headers: { 'x-request-id': 'trace-abc-123' },
    });
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('replaces X-Request-Id when client supplies an unsafe value', async () => {
    await bootApp({ MCP_AUTH_OPTIONAL: '1' });
    const res = await request(port, {
      path: '/live',
      headers: { 'x-request-id': 'evil <script>' },
    });
    expect(res.headers['x-request-id']).not.toBe('evil <script>');
    expect(typeof res.headers['x-request-id']).toBe('string');
  });
});

describe('health endpoints', () => {
  it('GET /live always returns 200 with uptime', async () => {
    await bootApp({ MCP_AUTH_OPTIONAL: '1' });
    const res = await request(port, { path: '/live' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(typeof body.uptime_s).toBe('number');
  });

  it('GET /health returns DB + schema_version when DB is reachable', async () => {
    await bootApp({ MCP_AUTH_OPTIONAL: '1' });
    const res = await request(port, { path: '/health' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.db_ok).toBe(true);
    expect(body.schema_version).toBe(String(CURRENT_SCHEMA_VERSION));
  });
});
