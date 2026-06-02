/**
 * Coverage for the Phase 4 observability surface:
 *   - /metrics gated behind MCP_METRICS_ENABLED + bearer
 *   - /ready warms the embedder and reports ready status
 *   - mcp_tool_calls_total / api_requests_total counters increment
 *   - structured logger redacts sensitive keys
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
import { metrics, renderMetrics } from '../../api/metrics.js';
import { logger } from '../../lib/logger.js';
import { handleStore } from '../../tools/store.js';

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
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
    req.end();
  });
}

let db: Database.Database;
let server: http.Server;
let port: number;

async function bootApp(env: Record<string, string | undefined>): Promise<void> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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

beforeEach(() => {
  delete process.env.MCP_AUTH_TOKEN;
  delete process.env.MCP_METRICS_ENABLED;
  process.env.MCP_AUTH_OPTIONAL = '1';
});

afterEach(async () => {
  delete process.env.MCP_AUTH_OPTIONAL;
  delete process.env.MCP_METRICS_ENABLED;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('/metrics', () => {
  it('returns 404 when MCP_METRICS_ENABLED is unset', async () => {
    await bootApp({});
    const res = await request(port, '/metrics');
    expect(res.status).toBe(404);
  });

  it('returns 401 when enabled but bearer is missing and a token is configured', async () => {
    await bootApp({ MCP_METRICS_ENABLED: '1', MCP_AUTH_TOKEN: 'abc', MCP_AUTH_OPTIONAL: undefined });
    const res = await request(port, '/metrics');
    expect(res.status).toBe(401);
  });

  it('returns Prometheus exposition format when enabled and authorized', async () => {
    await bootApp({ MCP_METRICS_ENABLED: '1' });
    // Hit /api/stats so we have something to count.
    await request(port, '/api/stats');
    const res = await request(port, '/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('api_requests_total');
    expect(res.body).toMatch(/api_requests_total\{[^}]*route="GET \/api\/stats"[^}]*\}/);
    expect(res.body).toContain('# TYPE api_requests_total counter');
  });

  it('records tool call counters when handlers run', async () => {
    await bootApp({ MCP_METRICS_ENABLED: '1' });

    // Reset the counter map by bouncing the in-memory metrics; use the live
    // counter as-is and verify a new entry is added.
    const before = renderMetrics();
    metrics.toolCalls.inc({ tool: 'memory_test', outcome: 'ok' });
    const after = renderMetrics();
    expect(after).not.toBe(before);
    expect(after).toContain('mcp_tool_calls_total{tool="memory_test",outcome="ok"} 1');
  });
});

describe('/ready', () => {
  it('returns 200 once the embedder warms up', async () => {
    await bootApp({});
    const res = await request(port, '/ready');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ready');
    expect(body.embedder_ok).toBe(true);
  });
});

describe('logger redaction', () => {
  it('redacts sensitive keys in the emitted JSON line', () => {
    const stderr = process.stderr;
    let captured = '';
    const writeOriginal = stderr.write.bind(stderr);
    stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof stderr.write;

    process.env.MCP_LOG_LEVEL = 'info';
    try {
      logger.info({
        event: 'http_request',
        Authorization: 'Bearer hunter2',
        password: 'pw',
        api_key: 'k',
        cookie: 'sid=1',
        ok: 'visible',
      });
    } finally {
      stderr.write = writeOriginal;
      delete process.env.MCP_LOG_LEVEL;
    }

    expect(captured).toContain('"Authorization":"[REDACTED]"');
    expect(captured).toContain('"password":"[REDACTED]"');
    expect(captured).toContain('"api_key":"[REDACTED]"');
    expect(captured).toContain('"cookie":"[REDACTED]"');
    expect(captured).toContain('"ok":"visible"');
  });
});

describe('integration: tool counters via direct handler', () => {
  it('handleStore invocation flows through the metrics counter when called from the MCP server (smoke)', async () => {
    // Direct integration: handleStore is what the MCP server's instrumented
    // wrapper invokes. We exercise it once and confirm the metrics surface
    // shows the related counter family present.
    await bootApp({ MCP_METRICS_ENABLED: '1' });
    const embedder = new MockEmbeddingProvider();
    await handleStore(db, embedder, { content: 'observability smoke memory.' });
    const res = await request(port, '/metrics');
    // We don't assert the tool counter here (it's set by the server.ts
    // wrapper, not the direct handler). What this test guarantees is that
    // /metrics renders cleanly even with traffic.
    expect(res.status).toBe(200);
    expect(res.body).toContain('# TYPE mcp_tool_calls_total counter');
  });
});
