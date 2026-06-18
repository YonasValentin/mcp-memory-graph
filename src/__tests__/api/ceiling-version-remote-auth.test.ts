/**
 * RBAC battle F2 (HIGH) — a REMOTE bind fails CLOSED on the api-key-count
 * transition; there is NO stale-cache window in either direction. Driven through
 * the REAL Express app (`buildApp`) over an ephemeral port (the REST surface
 * uses the injected getDb, so a /api request observes the live key count).
 *
 * The two fix halves:
 *   (a) authMiddleware returns 503 {code:'AUTH_NOT_CONFIGURED'} when
 *       isRemote && !authConfigured && MCP_AUTH_OPTIONAL!=='1' — so a runtime
 *       de-configuration (last key revoked) re-gates per request instead of
 *       falling back to the self-disabling pass-through that served the whole
 *       corpus unauthenticated on a network bind.
 *   (b) liveKeyCount no longer caches (clearKeyCountCache is now a no-op kept for
 *       API stability) — so a key created OR revoked at runtime takes effect on
 *       the very next request, with no 30s window.
 *
 * Because a remote bind with NO auth THROWS at construction (the startup gate),
 * the 1→0 revoke transition is exercised by booting WITH a key (authConfigured
 * true at boot), then revoking it and asserting the next request → 503 (NOT 200,
 * NO leaked rows). The 0→1 create direction is exercised on a loopback boot with
 * NO keys (passes through), then a key is created and the next no-bearer request
 * is refused (401) — the middleware sees the new key immediately.
 *
 * RED without the fix: (a) a cached/self-disabling middleware would 200 the
 * no-bearer /api/memories after the revoke and leak the corpus; (b) a 30s key
 * cache would still pass-through the no-bearer request right after a key was
 * created.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { buildApp, clearKeyCountCache } from '../../cli/serve.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { RateLimiter } from '../../api/rate-limit.js';
import { createApiKey, revokeApiKey } from '../../db/api-keys.js';
import { handleStore } from '../../tools/store.js';

interface Res {
  status: number;
  body: string;
}

function request(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string> },
): Promise<Res> {
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
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server | undefined;
const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());

const ENV_KEYS = ['MCP_AUTH_TOKEN', 'MCP_AUTH_OPTIONAL', 'MCP_BIND', 'MCP_API_NAMESPACE'];

async function boot(): Promise<number> {
  const limiter = new RateLimiter({ capacity: 500, refillPerSec: 500 });
  const { app } = buildApp({ getDb: () => db, getEmbedder: async () => embedder, rateLimiter: limiter });
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  return (server!.address() as AddressInfo).port;
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  clearKeyCountCache();
  db = createTestDb();
});

afterEach(async () => {
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((r) => s.close(() => r()));
  }
  db?.close();
  for (const k of ENV_KEYS) delete process.env[k];
  clearKeyCountCache();
});

describe('F2 — remote bind fails CLOSED on the key-count transition (no stale cache)', () => {
  it('revoking the LAST key at runtime → next request 503 AUTH_NOT_CONFIGURED, not 200, no rows', async () => {
    // Remote bind. Boot WITH a key so authConfigured is true at construction
    // (a remote + no-auth boot would throw at the startup gate).
    process.env.MCP_BIND = '0.0.0.0';
    const key = createApiKey(db, { principal: 'k', namespaces: ['acme'] });
    await handleStore(db, embedder, { content: 'corpus secret', namespace: 'acme', scope: 'project' });
    clearKeyCountCache();
    const port = await boot();

    // Sanity: with the key present + a valid bearer, /api/stats is reachable.
    const before = await request(port, {
      path: '/api/stats',
      headers: { authorization: `Bearer ${key.token}` },
    });
    expect(before.status).toBe(200);

    // Revoke the last key — authConfigured flips to false at runtime.
    expect(revokeApiKey(db, key.id)).toBe(true);
    clearKeyCountCache();

    // The old behaviour (cached count / self-disabling pass-through) would now
    // serve the whole corpus unauthenticated on a network bind. The fix re-gates
    // per request: a no-bearer request must 503, never 200, and leak no rows.
    const after = await request(port, { path: '/api/memories?limit=50' });
    expect(after.status).toBe(503);
    expect((JSON.parse(after.body) as { code: string }).code).toBe('AUTH_NOT_CONFIGURED');
    expect(after.body).not.toContain('corpus secret');

    // Even presenting the now-revoked token must not be served — on a remote bind
    // with zero live keys, 503 (auth not configured) takes precedence.
    const withRevoked = await request(port, {
      path: '/api/memories?limit=50',
      headers: { authorization: `Bearer ${key.token}` },
    });
    expect(withRevoked.status).toBe(503);
    expect(withRevoked.body).not.toContain('corpus secret');
  });

  it('a remote bind with a live key + NO bearer → 401 (auth active, not bypassed)', async () => {
    process.env.MCP_BIND = '0.0.0.0';
    createApiKey(db, { principal: 'k', namespaces: ['acme'] });
    clearKeyCountCache();
    const port = await boot();
    const res = await request(port, { path: '/api/stats' });
    expect(res.status).toBe(401);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('UNAUTHORIZED');
  });

  it('create-direction: a key created at runtime takes effect immediately (no 30s window)', async () => {
    // Loopback boot with NO keys → authMiddleware passes through (local default).
    const port = await boot();
    const open = await request(port, { path: '/api/stats' });
    expect(open.status).toBe(200); // unauthenticated, local default

    // Create a key while serving. liveKeyCount is no longer cached, so the very
    // next no-bearer request must NO LONGER be silently authed — auth is now
    // configured and a bearer is required.
    createApiKey(db, { principal: 'late', namespaces: ['acme'] });
    clearKeyCountCache();
    const afterCreate = await request(port, { path: '/api/stats' });
    expect(afterCreate.status).toBe(401);
    expect((JSON.parse(afterCreate.body) as { code: string }).code).toBe('UNAUTHORIZED');
  });
});
