/**
 * HTTP-2: the Express app must never leak an HTML stack-trace page. A malformed
 * JSON body (caught by express.json) and an unmatched route must both return the
 * structured JSON error envelope { error, code, requestId }, not Express's
 * default HTML error/404 page.
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

interface Res {
  status: number;
  body: string;
  contentType: string;
}

function request(
  port: number,
  opts: { path: string; method?: string; body?: string; contentType?: string },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: '127.0.0.1' };
    if (opts.body !== undefined) {
      headers['content-type'] = opts.contentType ?? 'application/json';
      headers['content-length'] = String(Buffer.byteLength(opts.body));
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path: opts.path, method: opts.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            contentType: String(res.headers['content-type'] ?? ''),
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server | undefined;
let port: number;

async function boot(): Promise<void> {
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
}

afterEach(async () => {
  delete process.env.MCP_AUTH_OPTIONAL;
  if (server) {
    const s = server;
    server = undefined;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  db?.close();
});

describe('Express error handling is JSON, never HTML', () => {
  it('malformed JSON body returns a JSON error envelope, not an HTML stack trace', async () => {
    await boot();
    const res = await request(port, { path: '/mcp', method: 'POST', body: '{ this is : not json' });
    expect(res.status).toBe(400);
    expect(res.contentType).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.code).toBe('INVALID_JSON');
    expect(typeof body.error).toBe('string');
    // Must not leak the parser's internal stack/marker.
    expect(res.body).not.toMatch(/SyntaxError|at JSON\.parse|<!DOCTYPE/);
  });

  it('unmatched route returns a JSON 404 envelope', async () => {
    await boot();
    const res = await request(port, { path: '/api/does-not-exist' });
    expect(res.status).toBe(404);
    expect(res.contentType).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.code).toBe('NOT_FOUND');
  });
});
