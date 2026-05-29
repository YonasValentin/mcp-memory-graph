/**
 * Security + memory-hardening for src/api/rate-limit.ts (Group G5):
 *   1. The limiter must NOT key on the client-controllable X-Forwarded-For.
 *      Under `trust proxy`, Express derives req.ip from the leftmost XFF entry,
 *      so an attacker rotating XFF would mint a fresh full bucket every request.
 *      The bucket key must come from the immediate socket peer
 *      (req.socket.remoteAddress), optionally augmented by a trusted,
 *      operator-configured proxy header (NOT raw XFF).
 *   2. The bucket Map must evict stale/full buckets so it can't grow unbounded
 *      under a flood of distinct keys.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { buildApp } from '../../cli/serve.js';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { RateLimiter, clientKey } from '../../api/rate-limit.js';

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(
  port: number,
  options: { path: string; headers?: Record<string, string> },
): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: 'GET',
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
    req.end();
  });
}

describe('clientKey — derives the bucket key from the socket peer, not XFF', () => {
  function fakeReq(over: Record<string, unknown>): any {
    return {
      ip: over.ip,
      socket: { remoteAddress: over.remoteAddress },
      headers: over.headers ?? {},
      header(name: string) {
        const h = (over.headers ?? {}) as Record<string, string>;
        return h[name.toLowerCase()];
      },
    };
  }

  it('uses the socket peer address, IGNORING a spoofed X-Forwarded-For-derived req.ip', () => {
    // Express under `trust proxy` sets req.ip from XFF — an attacker controls it.
    const a = clientKey(fakeReq({ ip: '1.2.3.4', remoteAddress: '10.0.0.9', headers: { 'x-forwarded-for': '1.2.3.4' } }));
    const b = clientKey(fakeReq({ ip: '9.9.9.9', remoteAddress: '10.0.0.9', headers: { 'x-forwarded-for': '9.9.9.9' } }));
    // Same socket peer → SAME bucket key regardless of the spoofed XFF/req.ip.
    expect(a).toBe(b);
    expect(a).toContain('10.0.0.9');
  });

  it('falls back to "unknown" when no peer address is available', () => {
    expect(clientKey(fakeReq({ ip: undefined, remoteAddress: undefined }))).toBe('unknown');
  });

  it('augments the key with a trusted proxy header when MCP_TRUSTED_IP_HEADER is set', () => {
    process.env.MCP_TRUSTED_IP_HEADER = 'cf-connecting-ip';
    try {
      const a = clientKey(fakeReq({ remoteAddress: '10.0.0.9', headers: { 'cf-connecting-ip': '203.0.113.1' } }));
      const b = clientKey(fakeReq({ remoteAddress: '10.0.0.9', headers: { 'cf-connecting-ip': '203.0.113.2' } }));
      // Same peer, different trusted-header identity → different buckets.
      expect(a).not.toBe(b);
      expect(a).toContain('203.0.113.1');
      expect(a).toContain('10.0.0.9');
    } finally {
      delete process.env.MCP_TRUSTED_IP_HEADER;
    }
  });

  it('ignores X-Forwarded-For even when MCP_TRUSTED_IP_HEADER is set (only the named trusted header counts)', () => {
    process.env.MCP_TRUSTED_IP_HEADER = 'cf-connecting-ip';
    try {
      const a = clientKey(fakeReq({ remoteAddress: '10.0.0.9', headers: { 'x-forwarded-for': '203.0.113.1', 'cf-connecting-ip': '7.7.7.7' } }));
      const b = clientKey(fakeReq({ remoteAddress: '10.0.0.9', headers: { 'x-forwarded-for': '203.0.113.2', 'cf-connecting-ip': '7.7.7.7' } }));
      // XFF differs but the trusted header is identical → SAME bucket.
      expect(a).toBe(b);
    } finally {
      delete process.env.MCP_TRUSTED_IP_HEADER;
    }
  });
});

describe('RateLimiter — bucket eviction (no unbounded growth)', () => {
  it('evicts a bucket once it refills back to full capacity', () => {
    let t = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
    // Drain key "a" by one token; bucket is now below capacity → retained.
    limiter.consume('a');
    expect(limiter.size()).toBe(1);
    // Advance enough time for the bucket to refill to full on the next touch
    // for a DIFFERENT key — the stale full "a" bucket should be swept.
    t = 10_000; // 10s @ 1 tok/s ≫ capacity, "a" is full again
    limiter.consume('b');
    // "a" is full (idle) → evicted; only "b" (just consumed, below full) remains.
    expect(limiter.has('a')).toBe(false);
    expect(limiter.has('b')).toBe(true);
    expect(limiter.size()).toBe(1);
  });

  it('drops the key immediately when its own bucket refills to full', () => {
    let t = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
    limiter.consume('a'); // tokens: 1
    expect(limiter.has('a')).toBe(true);
    t = 100_000; // way past full refill
    // Re-consume "a": it refills to full (2) then takes 1 → 1 left, below full,
    // so it stays. But a key that is full and idle gets swept on access of others.
    limiter.consume('a');
    expect(limiter.has('a')).toBe(true);
  });
});

let db: Database.Database;
let server: http.Server | undefined;
let port: number;

async function boot(env: Record<string, string | undefined>, limiter: RateLimiter): Promise<void> {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  db = createTestDb();
  const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
  const { app } = buildApp({ getDb: () => db, getEmbedder: async () => embedder, rateLimiter: limiter });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
}

describe('rate limiter — spoofed X-Forwarded-For cannot rotate the bucket (remote/trust-proxy mode)', () => {
  beforeEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
  });
  afterEach(async () => {
    delete process.env.MCP_BIND;
    delete process.env.MCP_AUTH_OPTIONAL;
    if (server) {
      const s = server;
      server = undefined;
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it('returns 429 after the bucket is exhausted even when XFF rotates each request', async () => {
    // Remote bind → buildApp sets `trust proxy`, so req.ip would follow XFF.
    // capacity 3: by rotating XFF the OLD code would never 429; the new code
    // (keyed on the loopback socket peer) must 429 once the shared bucket drains.
    await boot(
      { MCP_BIND: '0.0.0.0', MCP_AUTH_OPTIONAL: '1' },
      new RateLimiter({ capacity: 3, refillPerSec: 0.0001 }),
    );
    let sawRateLimited = false;
    for (let i = 0; i < 10; i++) {
      const res = await request(port, {
        path: '/api/stats',
        headers: { 'x-forwarded-for': `5.5.5.${i}` },
      });
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});
