/**
 * SPA static + client-route fallback for the web dashboard (GAP 4).
 *
 * The dashboard is a React SPA with client-side routes (/browse, /search,
 * /memory/:id, /graph). A deep-link or browser refresh on any of those must
 * serve index.html so the app boots and routes client-side.
 *
 * Regression: the previous implementation used res.sendFile(absolutePath). In
 * Express 5, `send` applies its default `dotfiles: 'ignore'` policy to the
 * WHOLE absolute path, so when the dashboard is installed under a directory
 * with a dot-prefixed segment (~/.config, ~/.local/share, a .claude/ worktree,
 * a .pnpm store) every client-route fallback 404'd. To pin this down, the
 * fixture webDir below deliberately contains a ".dotseg" path segment — exactly
 * the condition that broke the absolute-path form. The fix uses the
 * (filename, { root }) form, which scopes the dotfile check to "index.html".
 *
 * Boots the real Express app via buildApp against an ephemeral port, pointing
 * the SPA serving at the fixture dir (so the test does not depend on the
 * production dist/web build layout).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { buildApp } from '../../cli/serve.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { RateLimiter } from '../../api/rate-limit.js';

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, p: string): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: p, method: 'GET', headers: { host: '127.0.0.1' } },
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

const SPA_HTML = '<!doctype html><html><head><title>web</title>' +
  '<script type="module" src="/assets/index-abc.js"></script></head>' +
  '<body><div id="root"></div></body></html>';
const BUNDLE_JS = 'console.log("spa bundle");';

let db: Database.Database;
let server: http.Server | undefined;
let port: number;
let webDir: string;

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(path.join(tmpdir(), 'spa-web-'));
  // Nest the served dir under a dot-prefixed segment to reproduce the original
  // bug (send's dotfiles:'ignore' 404'd absolute paths containing such a
  // segment — the real install path here lives under ".claude/worktrees").
  webDir = path.join(fixtureRoot, '.dotseg', 'dist', 'web');
  mkdirSync(path.join(webDir, 'assets'), { recursive: true });
  writeFileSync(path.join(webDir, 'index.html'), SPA_HTML);
  writeFileSync(path.join(webDir, 'assets', 'index-abc.js'), BUNDLE_JS);

  db = createTestDb();
  const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
  const { app } = buildApp({
    getDb: () => db,
    getEmbedder: async () => embedder,
    rateLimiter: new RateLimiter({ capacity: 1000, refillPerSec: 1000 }),
    webDir,
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterEach(async () => {
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('web dashboard SPA serving', () => {
  it('serves index.html at "/" referencing the JS bundle', async () => {
    const res = await request(port, '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('id="root"');
    expect(res.body).toContain('/assets/index-abc.js');
  });

  it('serves the built JS bundle as a static asset', async () => {
    const res = await request(port, '/assets/index-abc.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body).toContain('spa bundle');
  });

  // Regression: every client-side route must fall back to the SPA shell.
  // Before the fix these all 404'd (Express 5 res.sendFile(absolutePath)).
  it.each(['/browse', '/search', '/graph', '/memory/some-id-123', '/deep/nested/route'])(
    'falls back to index.html for client route %s',
    async (clientRoute) => {
      const res = await request(port, clientRoute);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('id="root"');
    },
  );

  it('does NOT shadow API or health routes with the SPA fallback', async () => {
    // /api/* unmatched still yields the structured JSON 404, not index.html.
    const api = await request(port, '/api/this-route-does-not-exist');
    expect(api.status).toBe(404);
    expect(api.headers['content-type']).toContain('application/json');
    expect(api.body).not.toContain('id="root"');

    const health = await request(port, '/health');
    expect(health.status).toBe(200);
    expect(health.headers['content-type']).toContain('application/json');
  });
});
