/**
 * Tiny in-memory token bucket rate limiter. No dependency.
 *
 * Algorithm: each client (keyed by `req.ip`) gets a bucket of `capacity`
 * tokens that refills at `refillPerSec` tokens/second. Each request takes
 * one token. When the bucket is empty the request is rejected with HTTP
 * 429 and a `Retry-After` header.
 *
 * Tunables (env, all integers):
 *   MCP_RATELIMIT_CAPACITY       default 30  burst size
 *   MCP_RATELIMIT_REFILL_PER_SEC default 6   sustained rate (≈60 / 10s)
 *   MCP_RATELIMIT_DISABLED       default 0   set 1 to bypass entirely
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
 * Creates a stateful limiter. Exposed as a class so tests can introspect
 * the bucket map and inject a clock.
 */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(config: RateLimiterConfig) {
    this.capacity = config.capacity;
    this.refillPerSec = config.refillPerSec;
    this.now = config.now ?? Date.now;
  }

  /**
   * Attempt to consume one token. Returns the bucket state after the
   * attempt — `allowed=false` means the caller should reject with 429.
   */
  consume(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = this.now();
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
 * Identifies clients by `req.ip` (Express normalizes this from the socket
 * peer address; for proxied deployments configure `app.set('trust proxy')`).
 */
export function rateLimitMiddleware(limiter: RateLimiter = new RateLimiter(defaultConfig())) {
  const disabled = process.env.MCP_RATELIMIT_DISABLED === '1';
  return function rateLimitMw(req: Request, res: Response, next: NextFunction): void {
    if (disabled) return next();

    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
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
