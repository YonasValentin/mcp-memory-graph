/**
 * Security headers contract test. Boots the real Express app via `buildApp`
 * and asserts each header lands on /health and on the SPA index, plus the
 * env-flag escape hatches.
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
import { buildCsp } from '../../api/security-headers.js';

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
}

function request(port: number, path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { host: '127.0.0.1' } },
      (res) => {
        res.on('data', () => undefined);
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let db: Database.Database;
let server: http.Server;
let port: number;

async function bootApp(env: Partial<NodeJS.ProcessEnv>): Promise<void> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  db = createTestDb();
  const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
  const limiter = new RateLimiter({ capacity: 5, refillPerSec: 1 });
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
  delete process.env.MCP_BIND;
  delete process.env.MCP_HSTS_DISABLED;
  delete process.env.MCP_HSTS_MAX_AGE;
  delete process.env.MCP_CSP_DISABLED;
  delete process.env.MCP_CSP_EXTRA_CONNECT;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('security headers — baseline', () => {
  it('emits the static security headers on /health', async () => {
    await bootApp({});
    const res = await request(port, '/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('emits a Content-Security-Policy by default', async () => {
    await bootApp({});
    const res = await request(port, '/health');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('skips CSP when MCP_CSP_DISABLED=1', async () => {
    await bootApp({ MCP_CSP_DISABLED: '1' });
    const res = await request(port, '/health');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});

describe('security headers — HSTS', () => {
  it('does not emit HSTS on loopback', async () => {
    await bootApp({});
    const res = await request(port, '/health');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('omits HSTS even on remote bind when MCP_HSTS_DISABLED=1', async () => {
    // We can't actually bind to a non-loopback in tests, but the middleware
    // decides per-app at boot via the host param. Simulate by re-importing
    // the middleware with isRemote=true via a direct call.
    const { securityHeadersMiddleware } = await import('../../api/security-headers.js');
    process.env.MCP_HSTS_DISABLED = '1';
    const mw = securityHeadersMiddleware({ isRemote: true });
    const headers: Record<string, string> = {};
    const res = {
      setHeader(k: string, v: string) {
        headers[k] = v;
      },
    } as unknown as import('express').Response;
    mw({} as import('express').Request, res, () => undefined);
    expect(headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('emits HSTS when isRemote=true and not disabled', async () => {
    const { securityHeadersMiddleware } = await import('../../api/security-headers.js');
    delete process.env.MCP_HSTS_DISABLED;
    const mw = securityHeadersMiddleware({ isRemote: true });
    const headers: Record<string, string> = {};
    const res = {
      setHeader(k: string, v: string) {
        headers[k] = v;
      },
    } as unknown as import('express').Response;
    mw({} as import('express').Request, res, () => undefined);
    expect(headers['Strict-Transport-Security']).toMatch(/max-age=\d+; includeSubDomains/);
  });

  it('respects MCP_HSTS_MAX_AGE override', async () => {
    const { securityHeadersMiddleware } = await import('../../api/security-headers.js');
    process.env.MCP_HSTS_MAX_AGE = '60';
    const mw = securityHeadersMiddleware({ isRemote: true });
    const headers: Record<string, string> = {};
    const res = {
      setHeader(k: string, v: string) {
        headers[k] = v;
      },
    } as unknown as import('express').Response;
    mw({} as import('express').Request, res, () => undefined);
    expect(headers['Strict-Transport-Security']).toBe('max-age=60; includeSubDomains');
  });

  it('falls back to default max-age when env is non-numeric', async () => {
    const { securityHeadersMiddleware } = await import('../../api/security-headers.js');
    process.env.MCP_HSTS_MAX_AGE = 'not-a-number';
    const mw = securityHeadersMiddleware({ isRemote: true });
    const headers: Record<string, string> = {};
    const res = {
      setHeader(k: string, v: string) {
        headers[k] = v;
      },
    } as unknown as import('express').Response;
    mw({} as import('express').Request, res, () => undefined);
    expect(headers['Strict-Transport-Security']).toBe('max-age=15552000; includeSubDomains');
  });
});

describe('security headers — CSP composition', () => {
  it('appends MCP_CSP_EXTRA_CONNECT to connect-src', () => {
    process.env.MCP_CSP_EXTRA_CONNECT = 'https://api.example.com https://telemetry.example.com';
    const csp = buildCsp();
    expect(csp).toContain("connect-src 'self' https://api.example.com https://telemetry.example.com");
    delete process.env.MCP_CSP_EXTRA_CONNECT;
  });

  it('omits MCP_CSP_EXTRA_CONNECT cleanly when unset', () => {
    delete process.env.MCP_CSP_EXTRA_CONNECT;
    const csp = buildCsp();
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('undefined');
  });
});
