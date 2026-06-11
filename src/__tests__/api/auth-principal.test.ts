/**
 * RBAC v1 §4 — authMiddleware + MCP session binding.
 *
 * Boots the real Express app via `buildApp` against an ephemeral port and fires
 * actual HTTP requests with node:http (mirrors api/auth.test.ts). Proves:
 *   - legacy MCP_AUTH_TOKEN mode is byte-identical (no ALS, env-pin/no-pin);
 *   - an API-key bearer establishes a per-request principal that propagates ALL
 *     the way into a REST handler (a stored row in key A's namespace is visible
 *     to A and a 403 to a key whose ns set excludes it);
 *   - revoked / expired / unknown tokens all 401 with the SAME envelope;
 *   - the auth-activation rule fires on a key-only deployment (no MCP_AUTH_TOKEN);
 *   - the remote-bind-without-auth startup throw is satisfied by api-keys alone;
 *   - MCP session binding: key B cannot ride key A's mcp-session-id (403
 *     SESSION_PRINCIPAL_MISMATCH);
 *   - /metrics stays env-token-only (a principal key is NOT accepted there).
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
import { createApiKey } from '../../db/api-keys.js';
import { handleStore } from '../../tools/store.js';

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string },
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
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server | undefined;
const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());

async function boot(): Promise<number> {
  const limiter = new RateLimiter({ capacity: 500, refillPerSec: 500 });
  const { app } = buildApp({
    getDb: () => db,
    getEmbedder: async () => embedder,
    rateLimiter: limiter,
  });
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  return (server!.address() as AddressInfo).port;
}

const ENV_KEYS = [
  'MCP_AUTH_TOKEN',
  'MCP_AUTH_OPTIONAL',
  'MCP_BIND',
  'MCP_API_NAMESPACE',
  'MCP_METRICS_ENABLED',
];

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

describe('§4 legacy token mode — byte-identical', () => {
  it('a correct legacy bearer is accepted and establishes NO principal (global view)', async () => {
    process.env.MCP_AUTH_TOKEN = 'sekrit';
    // No MCP_API_NAMESPACE → legacy no-pin: the global view, all namespaces.
    await handleStore(db, embedder, { content: 'alpha in sales', namespace: 'sales', scope: 'project' });
    await handleStore(db, embedder, { content: 'beta in hr', namespace: 'hr', scope: 'project' });
    const port = await boot();
    const res = await request(port, {
      path: '/api/memories',
      headers: { authorization: 'Bearer sekrit' },
    });
    expect(res.status).toBe(200);
    const items = (JSON.parse(res.body) as { items: Array<{ namespace: string }> }).items;
    // Legacy no-pin sees BOTH namespaces — no principal scoping.
    const namespaces = new Set(items.map((m) => m.namespace));
    expect(namespaces.has('sales')).toBe(true);
    expect(namespaces.has('hr')).toBe(true);
  });

  it('a wrong legacy bearer 401s', async () => {
    process.env.MCP_AUTH_TOKEN = 'sekrit';
    const port = await boot();
    const res = await request(port, {
      path: '/api/stats',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).code).toBe('UNAUTHORIZED');
  });

  it('no Authorization header 401s when a token is configured', async () => {
    process.env.MCP_AUTH_TOKEN = 'sekrit';
    const port = await boot();
    const res = await request(port, { path: '/api/stats' });
    expect(res.status).toBe(401);
  });
});

describe('§4 API-key auth — principal established + propagated into a REST handler', () => {
  it('a key scoped to [sales] reads sales rows and 403s a foreign ns param', async () => {
    const { token } = createApiKey(db, { principal: 'sales-bot', namespaces: ['sales'] });
    await handleStore(db, embedder, { content: 'alpha in sales', namespace: 'sales', scope: 'project' });
    await handleStore(db, embedder, { content: 'beta in hr', namespace: 'hr', scope: 'project' });
    const port = await boot();

    // Unset namespace → forced to the key's default (sales). PROVES ALS reaches
    // the REST handler: scopeToNamespace inside the route read currentPrincipal().
    const mine = await request(port, {
      path: '/api/memories',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mine.status).toBe(200);
    const items = (JSON.parse(mine.body) as { items: Array<{ namespace: string }> }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((m) => m.namespace === 'sales')).toBe(true);

    // A foreign ns param → the tenancy throw, mapped to 403 in sendError.
    const foreign = await request(port, {
      path: '/api/memories?namespace=hr',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(foreign.status).toBe(403);
    expect((JSON.parse(foreign.body) as { code: string }).code).toBe('NAMESPACE_NOT_PERMITTED');
  });

  it('key B cannot read a memory key A stored in A-only namespace (by id → 404)', async () => {
    const a = createApiKey(db, { principal: 'a', namespaces: ['nsa'] });
    const b = createApiKey(db, { principal: 'b', namespaces: ['nsb'] });
    const stored = await handleStore(db, embedder, {
      content: 'a-secret',
      namespace: 'nsa',
      scope: 'project',
    });
    const port = await boot();
    const id = stored.memory.id;
    const aGet = await request(port, {
      path: `/api/memories/${id}`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(aGet.status).toBe(200);
    const bGet = await request(port, {
      path: `/api/memories/${id}`,
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(bGet.status).toBe(404); // existence non-confirmation
  });

  it('revoked / expired / unknown tokens all 401 with the same envelope', async () => {
    const revoked = createApiKey(db, { principal: 'r', namespaces: ['nsa'] });
    // Revoke it directly via the module (revokeApiKey is exercised in api-keys tests).
    db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      revoked.id,
    );
    const expired = createApiKey(db, {
      principal: 'e',
      namespaces: ['nsa'],
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const port = await boot();

    for (const tok of [revoked.token, expired.token, 'mcpm_totally-unknown']) {
      const res = await request(port, {
        path: '/api/stats',
        headers: { authorization: `Bearer ${tok}` },
      });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body).code).toBe('UNAUTHORIZED');
    }
  });

  it('auth-activation: a key-only deployment (no MCP_AUTH_TOKEN) still requires auth', async () => {
    createApiKey(db, { principal: 'only-key', namespaces: ['nsa'] });
    const port = await boot();
    const noAuth = await request(port, { path: '/api/stats' });
    expect(noAuth.status).toBe(401);
  });
});

describe('§4 remote-bind-without-auth startup gate', () => {
  it('api-keys alone satisfy the remote-bind auth requirement (no throw)', () => {
    process.env.MCP_BIND = '0.0.0.0';
    delete process.env.MCP_AUTH_TOKEN;
    const dbWithKey = createTestDb();
    createApiKey(dbWithKey, { principal: 'k', namespaces: ['nsa'] });
    clearKeyCountCache();
    expect(() =>
      buildApp({ getDb: () => dbWithKey, getEmbedder: async () => embedder }),
    ).not.toThrow();
    dbWithKey.close();
  });

  it('still throws when bound remote with NO token and NO keys', () => {
    process.env.MCP_BIND = '0.0.0.0';
    delete process.env.MCP_AUTH_TOKEN;
    const emptyDb = createTestDb();
    clearKeyCountCache();
    expect(() =>
      buildApp({ getDb: () => emptyDb, getEmbedder: async () => embedder }),
    ).toThrowError(/MCP_AUTH_TOKEN is not set/);
    emptyDb.close();
  });
});

describe('§4 MCP session binding', () => {
  function initBody(): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });
  }

  it('key B replaying key A’s mcp-session-id is 403 SESSION_PRINCIPAL_MISMATCH', async () => {
    const a = createApiKey(db, { principal: 'a', namespaces: ['nsa'] });
    const b = createApiKey(db, { principal: 'b', namespaces: ['nsb'] });
    const port = await boot();

    // A initializes a session.
    const init = await request(port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        authorization: `Bearer ${a.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: initBody(),
    });
    expect(init.status).toBe(200);
    const sid = init.headers['mcp-session-id'] as string | undefined;
    expect(typeof sid).toBe('string');
    expect((sid ?? '').length).toBeGreaterThan(0);

    // B replays A's session id on a follow-up POST → must be refused, transport untouched.
    const ride = await request(port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        authorization: `Bearer ${b.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sid!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(ride.status).toBe(403);
    expect((JSON.parse(ride.body) as { code: string }).code).toBe('SESSION_PRINCIPAL_MISMATCH');

    // A may still use its own session.
    const own = await request(port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        authorization: `Bearer ${a.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sid!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(own.status).toBe(200);
  });

  it('a legacy session cannot be ridden by an api-key (mismatch __legacy__ vs keyId)', async () => {
    // Both a legacy token AND a key exist; the legacy session is owned by __legacy__.
    process.env.MCP_AUTH_TOKEN = 'sekrit';
    const k = createApiKey(db, { principal: 'k', namespaces: ['nsa'] });
    const port = await boot();
    const init = await request(port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        authorization: 'Bearer sekrit',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: initBody(),
    });
    expect(init.status).toBe(200);
    const sid = init.headers['mcp-session-id'] as string;
    const ride = await request(port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        authorization: `Bearer ${k.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sid,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(ride.status).toBe(403);
    expect((JSON.parse(ride.body) as { code: string }).code).toBe('SESSION_PRINCIPAL_MISMATCH');
  });
});

describe('§4 /metrics stays env-token-only', () => {
  it('a principal key is NOT accepted as the metrics token', async () => {
    process.env.MCP_METRICS_ENABLED = '1';
    process.env.MCP_AUTH_TOKEN = 'metrics-secret';
    const k = createApiKey(db, { principal: 'k', namespaces: ['nsa'] });
    const port = await boot();
    const withKey = await request(port, {
      path: '/metrics',
      headers: { authorization: `Bearer ${k.token}` },
    });
    expect(withKey.status).toBe(401);
    const withEnv = await request(port, {
      path: '/metrics',
      headers: { authorization: 'Bearer metrics-secret' },
    });
    expect(withEnv.status).toBe(200);
  });
});
