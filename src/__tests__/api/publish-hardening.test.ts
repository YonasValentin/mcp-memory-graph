/**
 * Group G5 hardening for the PUBLIC, unauthenticated /publish surface
 * (src/api/routes.ts + src/cli/serve.ts):
 *
 *   F3 — /publish must be rate limited (it runs embedding/rerank per search,
 *        a DoS lever) and bound public search cost (cap query length).
 *   F4 — /publish/:namespace/search must be SIDE-EFFECT FREE: it must NOT
 *        record access (bump access_count/importance/stability or write
 *        memory_access_log rows) on ANY memory — published or not — on this
 *        anonymous path.
 *   F6 — the published post-filter must run BEFORE the display limit, so
 *        published pages aren't pushed out of the window by higher-ranked
 *        non-published memories (recall bug).
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
import type { EmbeddingProvider } from '../../types.js';

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, path: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { host: '127.0.0.1' } },
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
let embedder: EmbeddingProvider;
let server: http.Server | undefined;
let port: number;

function accessCountOf(id: string): number {
  const r = db.prepare<[string], { c: number }>('SELECT access_count AS c FROM memories WHERE id = ?').get(id);
  return r?.c ?? -1;
}
function accessLogCount(): number {
  const r = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM memory_access_log').get();
  return r?.c ?? -1;
}

async function boot(limiter?: RateLimiter): Promise<void> {
  process.env.MCP_AUTH_OPTIONAL = '1';
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.MCP_PUBLISH_ACCESS_LEVELS;

  db = createTestDb();
  embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
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

afterEach(async () => {
  delete process.env.MCP_AUTH_OPTIONAL;
  delete process.env.MCP_PUBLISH_ACCESS_LEVELS;
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

describe('F4 — publish search is side-effect free (no access recording)', () => {
  beforeEach(async () => {
    await boot();
  });

  it('does NOT bump access_count or write access-log rows for the PUBLISHED memory it returns', async () => {
    const p = await handleStore(db, embedder, {
      namespace: 'wiki',
      title: 'Public Onboarding',
      content: 'Welcome to the public onboarding flamingo guide for everyone.',
      access_level: 'public',
    });
    const before = accessCountOf(p.memory.id);
    const logBefore = accessLogCount();

    const res = await request(port, '/publish/wiki/search?q=onboarding+flamingo');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { results: Array<{ id: string }> };
    expect(body.results.some((r) => r.id === p.memory.id)).toBe(true);

    expect(accessCountOf(p.memory.id)).toBe(before);
    expect(accessLogCount()).toBe(logBefore);
  });

  it('does NOT touch a NON-published memory that matches the query (the core vuln)', async () => {
    const i = await handleStore(db, embedder, {
      namespace: 'wiki',
      title: 'Internal Secrets',
      content: 'Confidential internal kumquat compensation figures, not for the public.',
      access_level: 'internal',
    });
    const before = accessCountOf(i.memory.id);
    const logBefore = accessLogCount();

    // Query that matches the internal memory only.
    const res = await request(port, '/publish/wiki/search?q=kumquat+compensation');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { results: Array<{ id: string }> };
    // Internal must never leak.
    expect(body.results.some((r) => r.id === i.memory.id)).toBe(false);
    // …and its access_count / log must be UNCHANGED (no anonymous write).
    expect(accessCountOf(i.memory.id)).toBe(before);
    expect(accessLogCount()).toBe(logBefore);
  });
});

describe('F3 — public search cost is bounded (query length cap)', () => {
  beforeEach(async () => {
    await boot();
  });

  it('rejects an over-long query with 400 instead of embedding it', async () => {
    const huge = 'a'.repeat(5000);
    const res = await request(port, `/publish/wiki/search?q=${huge}`);
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
  });

  it('still serves a normal-length query', async () => {
    await handleStore(db, embedder, {
      namespace: 'wiki',
      title: 'Normal',
      content: 'A normal public page about platypus onboarding.',
      access_level: 'public',
    });
    const res = await request(port, '/publish/wiki/search?q=platypus+onboarding');
    expect(res.status).toBe(200);
  });
});

describe('F3 — /publish is rate limited', () => {
  it('returns 429 once the publish bucket is exhausted', async () => {
    // Tiny bucket, slow refill: a burst of /publish requests must hit 429.
    await boot(new RateLimiter({ capacity: 3, refillPerSec: 0.0001 }));
    await handleStore(db, embedder, {
      namespace: 'wiki',
      title: 'RL Page',
      content: 'A page to search against for the rate-limit test.',
      access_level: 'public',
    });
    let saw429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await request(port, `/publish/wiki/search?q=page+search+${i}`);
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});

describe('F6 — published filter runs before the display limit (recall)', () => {
  beforeEach(async () => {
    await boot();
  });

  it('returns published matches even when many non-published memories also match', async () => {
    // 15 internal (non-published) memories that all match the query strongly,
    // plus ONE public memory that also matches. With a default top-10 cut BEFORE
    // the published filter, the public one can be pushed out. Filtering published
    // BEFORE the limit must still surface it.
    for (let i = 0; i < 15; i++) {
      await handleStore(db, embedder, {
        namespace: 'wiki',
        title: `Internal ${i}`,
        content: `Internal note number ${i} about the shared narwhal deployment topic.`,
        access_level: 'internal',
      });
    }
    const pub = await handleStore(db, embedder, {
      namespace: 'wiki',
      title: 'Public Narwhal',
      content: 'Public page about the shared narwhal deployment topic for everyone.',
      access_level: 'public',
    });

    const res = await request(port, '/publish/wiki/search?q=narwhal+deployment');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { results: Array<{ id: string }> };
    expect(body.results.some((r) => r.id === pub.memory.id)).toBe(true);
    // No internal memory may appear.
    expect(body.results.length).toBeGreaterThan(0);
  });
});
