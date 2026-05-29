/**
 * T18 — Obsidian-Publish-style read-only "memory wiki" (Pillar 6).
 *
 * The /publish routes are UNAUTHENTICATED (public wiki). The make-or-break
 * properties exercised here:
 *   1. Access gating on EVERY path — a non-published memory (access_level not
 *      in the allowlist) must be unreachable via the index, a direct page-by-id,
 *      search, the graph (nodes/edges), AND backlinks/related.
 *   2. HTML escaping — memory titles/content are untrusted user data rendered
 *      into HTML, so all interpolation must be escaped (XSS defense).
 *
 * Boots the real Express app via `buildApp` against an ephemeral port and fires
 * actual HTTP requests with node:http. Zero new test deps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { buildApp } from '../../cli/serve.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { handleStore } from '../../tools/store.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import type { EmbeddingProvider } from '../../types.js';

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string> } = { path: '/' },
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
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () =>
          resolve({
            status: r.statusCode ?? 0,
            headers: r.headers,
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
let server: http.Server;
let port: number;

// Seeded memory ids (filled in beforeEach).
let pId: string; // public, namespace 'wiki' — the visible page
let iId: string; // internal, namespace 'wiki' — must never leak
let p2Id: string; // public, namespace 'wiki' — a linked public page
let otherId: string; // public, namespace 'other' — different namespace, must not appear

async function boot(): Promise<void> {
  process.env.MCP_AUTH_OPTIONAL = '1';
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.MCP_PUBLISH_ACCESS_LEVELS;

  db = createTestDb();
  embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());

  const p = await handleStore(db, embedder, {
    namespace: 'wiki',
    title: 'Onboarding Guide',
    content: 'Welcome to the public wiki. This describes the onboarding flamingo process.',
    access_level: 'public',
  });
  pId = p.memory.id;

  const i = await handleStore(db, embedder, {
    namespace: 'wiki',
    title: 'Internal Salary Bands',
    content: 'Confidential internal compensation details with the secret kumquat figures.',
    access_level: 'internal',
  });
  iId = i.memory.id;

  const p2 = await handleStore(db, embedder, {
    namespace: 'wiki',
    title: 'Public FAQ',
    content: 'Frequently asked questions for everyone.',
    access_level: 'public',
  });
  p2Id = p2.memory.id;

  const other = await handleStore(db, embedder, {
    namespace: 'other',
    title: 'Other Namespace Page',
    content: 'A public page in a different namespace.',
    access_level: 'public',
  });
  otherId = other.memory.id;

  // P links to the internal memory I (a backlink path that must NOT leak) and
  // to the public memory P2 (a backlink path that SHOULD show).
  createMemoryLink(db, { sourceId: pId, targetId: iId, relation: 'links_to' });
  createMemoryLink(db, { sourceId: pId, targetId: p2Id, relation: 'links_to' });

  const built = buildApp({
    getDb: () => db,
    getEmbedder: async () => embedder,
  });
  await new Promise<void>((resolve) => {
    server = built.app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('publish — selective read-only memory wiki', () => {
  it('1. GET /publish/wiki lists the public page but NOT the internal one or other namespace', async () => {
    const res = await request(port, { path: '/publish/wiki' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Onboarding Guide');
    expect(res.body).toContain('Public FAQ');
    // Internal memory title must never appear.
    expect(res.body).not.toContain('Internal Salary Bands');
    // Other-namespace memory must not appear.
    expect(res.body).not.toContain('Other Namespace Page');
  });

  it('2. GET /publish/wiki/page/<P.id> shows P and only published links — internal target excluded', async () => {
    const res = await request(port, { path: `/publish/wiki/page/${pId}` });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Onboarding Guide');
    expect(res.body).toContain('onboarding flamingo');
    // P links to P2 (public) — that should show.
    expect(res.body).toContain('Public FAQ');
    // P also links to I (internal) — must NOT leak its title or id.
    expect(res.body).not.toContain('Internal Salary Bands');
    expect(res.body).not.toContain(iId);
  });

  it('3. GET /publish/wiki/page/<I.id> returns 404 — internal not reachable by direct id', async () => {
    const res = await request(port, { path: `/publish/wiki/page/${iId}` });
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body).error).toBe('not_found');
  });

  it('4. XSS — title/content are HTML-escaped, no raw <script> survives', async () => {
    const xss = await handleStore(db, embedder, {
      namespace: 'wiki',
      title: '<script>alert(1)</script>',
      content: '"><img src=x onerror=y> dangerous payload here',
      access_level: 'public',
    });
    const res = await request(port, { path: `/publish/wiki/page/${xss.memory.id}` });
    expect(res.status).toBe(200);
    // Escaped form present.
    expect(res.body).toContain('&lt;script&gt;');
    // Raw executable form absent.
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).not.toContain('<img src=x onerror=y>');
  });

  it('5. GET /publish/wiki/graph — nodes are published wiki only; no edge references the internal id', async () => {
    const res = await request(port, { path: '/publish/wiki/graph' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const graph = JSON.parse(res.body) as {
      nodes: Array<{ id: string; title: string | null }>;
      edges: Array<{ source: string; target: string; relation: string }>;
    };
    const nodeIds = graph.nodes.map((n) => n.id);
    expect(nodeIds).toContain(pId);
    expect(nodeIds).toContain(p2Id);
    expect(nodeIds).not.toContain(iId);
    expect(nodeIds).not.toContain(otherId);
    // No edge may reference the internal memory on either end.
    for (const e of graph.edges) {
      expect(e.source).not.toBe(iId);
      expect(e.target).not.toBe(iId);
    }
    // The P->P2 published edge should be present.
    expect(graph.edges.some((e) => e.source === pId && e.target === p2Id)).toBe(true);
  });

  it('6. GET /publish/wiki/search — returns published P, never internal I', async () => {
    const hit = await request(port, { path: '/publish/wiki/search?q=onboarding+flamingo' });
    expect(hit.status).toBe(200);
    expect(hit.headers['content-type']).toContain('application/json');
    const hitBody = JSON.parse(hit.body) as { results: Array<{ id: string }> };
    expect(hitBody.results.some((r) => r.id === pId)).toBe(true);
    expect(hitBody.results.some((r) => r.id === iId)).toBe(false);

    // A query that only matches the internal memory must surface nothing.
    const miss = await request(port, { path: '/publish/wiki/search?q=secret+kumquat' });
    expect(miss.status).toBe(200);
    const missBody = JSON.parse(miss.body) as { results: Array<{ id: string }> };
    expect(missBody.results.some((r) => r.id === iId)).toBe(false);
  });
});
