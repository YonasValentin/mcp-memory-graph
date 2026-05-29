/**
 * Tiny in-memory token bucket rate limiter. No dependency.
 *
 * Algorithm: each client (keyed by the immediate socket peer — see `clientKey`)
 * gets a bucket of `capacity` tokens that refills at `refillPerSec`
 * tokens/second. Each request takes one token. When the bucket is empty the
 * request is rejected with HTTP 429 and a `Retry-After` header.
 *
 * Tunables (env, all integers unless noted):
 *   MCP_RATELIMIT_CAPACITY        default 30  burst size
 *   MCP_RATELIMIT_REFILL_PER_SEC  default 6   sustained rate (≈60 / 10s)
 *   MCP_RATELIMIT_DISABLED        default 0   set 1 to bypass entirely
 *   MCP_TRUSTED_IP_HEADER         unset       name of a TRUSTED, proxy-set
 *                                             identity header (e.g.
 *                                             `cf-connecting-ip`). Only set this
 *                                             when a trusted reverse proxy /
 *                                             WAF strips client-supplied copies
 *                                             of it. X-Forwarded-For is NEVER
 *                                             trusted for keying.
 *
 * Suitable for single-process deployments. For multi-instance setups put a
 * shared limiter (Redis, Cloudflare WAF, NGINX limit_req) in front.
 */
import type { Request, Response, NextFunction } from 'express';

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimiterConfig {
  capacity: number;
  refillPerSec: number;
  /** Optional clock injection for tests. */
  now?: () => number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function defaultConfig(): RateLimiterConfig {
  return {
    capacity: envInt('MCP_RATELIMIT_CAPACITY', 30),
    refillPerSec: envInt('MCP_RATELIMIT_REFILL_PER_SEC', 6),
  };
}

/**
 * Derive the rate-limit bucket key for a request.
 *
 * SECURITY: we key on `req.socket.remoteAddress` — the immediate TCP peer — and
 * NEVER on `req.ip`. Under `app.set('trust proxy')` (remote mode), Express
 * derives `req.ip` from the leftmost `X-Forwarded-For` entry, which is fully
 * client-controlled; an attacker could rotate XFF to mint a fresh full bucket on
 * every request and defeat the limiter entirely.
 *
 * When the operator explicitly opts in via `MCP_TRUSTED_IP_HEADER` (the name of
 * a header that a TRUSTED reverse proxy / WAF sets and strips from client input,
 * e.g. `cf-connecting-ip`), that header's value is folded into the key so legit
 * per-client buckets still work behind a real proxy. X-Forwarded-For is never
 * honored here regardless of configuration.
 */
export function clientKey(req: Request): string {
  const peer = req.socket?.remoteAddress ?? 'unknown';
  const trustedHeaderName = process.env.MCP_TRUSTED_IP_HEADER;
  if (trustedHeaderName) {
    const headerVal = req.header(trustedHeaderName);
    if (headerVal) {
      return `${headerVal}|${peer}`;
    }
  }
  return peer;
}

/**
 * Creates a stateful limiter. Exposed as a class so tests can introspect
 * the bucket map and inject a clock.
 */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  /** A bucket idle for this long has fully refilled and carries no state. */
  private readonly idleEvictMs: number;
  /** Opportunistic sweep cadence so a flood of distinct keys can't grow the map. */
  private consumeCount = 0;

  constructor(config: RateLimiterConfig) {
    this.capacity = config.capacity;
    this.refillPerSec = config.refillPerSec;
    this.now = config.now ?? Date.now;
    // Time for an empty bucket to refill to full = capacity / refillPerSec sec.
    // Past that point a retained bucket is indistinguishable from a fresh one.
    this.idleEvictMs = (this.capacity / this.refillPerSec) * 1000;
  }

  /**
   * Attempt to consume one token. Returns the bucket state after the
   * attempt — `allowed=false` means the caller should reject with 429.
   */
  consume(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = this.now();

    // Opportunistic eviction: sweep buckets that have been idle long enough to
    // be fully refilled (they hold no useful state). This bounds memory under a
    // flood of distinct keys without a background timer.
    this.sweep(now, key);

    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefillMs: now };

    const elapsedSec = (now - bucket.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSec: 0 };
    }

    this.buckets.set(key, bucket);
    const deficit = 1 - bucket.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil(deficit / this.refillPerSec)),
    };
  }

  /**
   * Drop every bucket idle long enough to have fully refilled (so it carries no
   * useful state), except `keepKey` (the bucket about to be consumed). Lazy/
   * opportunistic — invoked from `consume`, never on a timer.
   */
  private sweep(now: number, keepKey?: string): void {
    for (const [k, b] of this.buckets) {
      if (k === keepKey) continue;
      if (now - b.lastRefillMs >= this.idleEvictMs) {
        this.buckets.delete(k);
      }
    }
  }

  /** Number of live buckets (test/observability helper). */
  size(): number {
    return this.buckets.size;
  }

  /** Whether a bucket exists for `key` (test/observability helper). */
  has(key: string): boolean {
    return this.buckets.has(key);
  }

  /** Test/maintenance helper — drop a key (or all keys when omitted). */
  reset(key?: string): void {
    if (key === undefined) {
      this.buckets.clear();
    } else {
      this.buckets.delete(key);
    }
  }
}

/**
 * Express middleware factory. Skips rate-limiting if MCP_RATELIMIT_DISABLED=1.
 * Identifies clients via `clientKey` (the immediate socket peer, plus an
 * optional operator-trusted proxy header) — NOT the spoofable `req.ip`/XFF.
 */
export function rateLimitMiddleware(limiter: RateLimiter = new RateLimiter(defaultConfig())) {
  const disabled = process.env.MCP_RATELIMIT_DISABLED === '1';
  return function rateLimitMw(req: Request, res: Response, next: NextFunction): void {
    if (disabled) return next();

    const key = clientKey(req);
    const result = limiter.consume(key);

    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSec));
      res.status(429).json({
        error: 'Too Many Requests',
        code: 'RATE_LIMITED',
        retry_after_seconds: result.retryAfterSec,
      });
      return;
    }

    next();
  };
}
