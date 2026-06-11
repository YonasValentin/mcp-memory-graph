/**
 * RBAC audit trail — REST PATCH /api/memories/:id must attribute the version
 * snapshot to the AUTHENTICATED principal. Pre-fix, a PATCH authenticated with
 * an api key recorded changed_by:'web-dashboard' (the legacy constant) instead
 * of the key's principal name, erasing who actually made the edit.
 *
 * Boots the REAL Express app via buildApp (mirrors api/auth-principal.test.ts)
 * so the request runs through the §4 authMiddleware → runWithPrincipal → route
 * chokepoint, end to end:
 *   - api-key bearer → snapshot changed_by = the key's principal;
 *   - legacy MCP_AUTH_TOKEN bearer (no ALS principal) → 'web-dashboard',
 *     byte-identical to before;
 *   - an explicit body.changed_by still wins over the principal (schema field).
 * The MCP path's own agent attribution is untouched by this fix.
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
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
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

const ENV_KEYS = ['MCP_AUTH_TOKEN', 'MCP_AUTH_OPTIONAL', 'MCP_BIND', 'MCP_API_NAMESPACE'];

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

async function patchMemory(
  port: number,
  id: string,
  bearer: string,
  body: Record<string, unknown>,
): Promise<Res> {
  return request(port, {
    method: 'PATCH',
    path: `/api/memories/${id}`,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Newest-first changed_by column of the memory's version snapshots. */
function snapshotChangedBy(memoryId: string): Array<string | null> {
  return db
    .prepare<[string], { changed_by: string | null }>(
      'SELECT changed_by FROM memory_versions WHERE memory_id = ? ORDER BY version DESC',
    )
    .all(memoryId)
    .map((r) => r.changed_by);
}

describe('PATCH /api/memories/:id — version-snapshot changed_by attribution', () => {
  it("an api-key PATCH records the key's principal, not 'web-dashboard'", async () => {
    const { token } = createApiKey(db, { principal: 'sales-bot', namespaces: ['sales'] });
    const stored = await handleStore(db, embedder, {
      content: 'q3 pipeline summary v1',
      namespace: 'sales',
      scope: 'project',
    });
    const port = await boot();

    const res = await patchMemory(port, stored.memory.id, token, {
      content: 'q3 pipeline summary v2',
    });
    expect(res.status).toBe(200);

    // The raw snapshot row carries the principal...
    expect(snapshotChangedBy(stored.memory.id)[0]).toBe('sales-bot');

    // ...and the REST audit surface (GET /versions) reads it back the same.
    const versions = await request(port, {
      path: `/api/memories/${stored.memory.id}/versions`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(versions.status).toBe(200);
    const history = (JSON.parse(versions.body) as { history: Array<{ changed_by: string | null }> })
      .history;
    expect(history[0]?.changed_by).toBe('sales-bot');
  });

  it("a legacy env-token PATCH (no principal) stays 'web-dashboard' byte-identical", async () => {
    process.env.MCP_AUTH_TOKEN = 'sekrit';
    const stored = await handleStore(db, embedder, {
      content: 'ops runbook note v1',
      namespace: 'ops',
      scope: 'project',
    });
    const port = await boot();

    const res = await patchMemory(port, stored.memory.id, 'sekrit', {
      content: 'ops runbook note v2',
    });
    expect(res.status).toBe(200);
    expect(snapshotChangedBy(stored.memory.id)[0]).toBe('web-dashboard');
  });

  it('an explicit body.changed_by wins over the authenticated principal', async () => {
    const { token } = createApiKey(db, { principal: 'sales-bot', namespaces: ['sales'] });
    const stored = await handleStore(db, embedder, {
      content: 'q3 risk register v1',
      namespace: 'sales',
      scope: 'project',
    });
    const port = await boot();

    const res = await patchMemory(port, stored.memory.id, token, {
      content: 'q3 risk register v2',
      changed_by: 'release-script',
    });
    expect(res.status).toBe(200);
    expect(snapshotChangedBy(stored.memory.id)[0]).toBe('release-script');
  });
});
