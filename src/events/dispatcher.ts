import type Database from 'better-sqlite3';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { assertResolvedHostSafe, assertSafeWebhookUrl, isBlockedHost } from './ssrf-guard.js';
import { getReadyDeliveries, type WebhookDeliveryRow, type WebhookTargetRow } from './store.js';
import { logger } from '../lib/logger.js';

/**
 * Webhook delivery dispatcher (M3.1). Drains the crash-durable delivery queue:
 * each due delivery is CLAIMED atomically (so two concurrent dispatchers can't
 * double-send), its target URL re-validated (scheme + DNS), then POSTed to the
 * PINNED resolved IP with HMAC, a hard timeout, NO redirect following, and the
 * response body drained — advancing the row to delivered on 2xx, else
 * exponential-backoff retry to a cap, then dead-letter. A per-target circuit
 * breaker parks a repeatedly-failing sink.
 *
 * SSRF chokepoint: the request connects to the exact IP that
 * assertResolvedHostSafe validated (via node:http(s) `lookup`), with the TLS
 * SNI/Host kept as the original hostname — so a hostname that resolves public
 * for the check but private for the connection (DNS rebinding) cannot occur.
 *
 * Pure of wall-clock and network in tests: `now`, `fetchImpl`, and `lookup` are
 * all injectable. When `fetchImpl` is supplied (tests) it is used verbatim; in
 * production the built-in pinned sender runs.
 */

export interface DispatchOptions {
  fetchImpl?: typeof fetch;
  lookup?: (h: string) => Promise<Array<{ address: string }>>;
  now?: Date;
  limit?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  circuitThreshold?: number;
  circuitCooldownMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long a claimed ('sending') row is leased before it can be retried. */
  leaseMs?: number;
}

export interface DispatchResult {
  delivered: number;
  failed: number;
  dead: number;
  attempted: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_CIRCUIT_THRESHOLD = 5;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_BASE_BACKOFF_MS = 30_000;
const DEFAULT_MAX_BACKOFF_MS = 60 * 60_000;
const DEFAULT_LEASE_MS = 60_000;
/** Hard cap on the response bytes we read (we only need the status). */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** HMAC-SHA256 of the body under the target secret, as `sha256=<hex>`. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function backoffMs(attempts: number, base: number, cap: number): number {
  const exp = base * 2 ** Math.max(0, attempts - 1);
  return Math.min(cap, exp);
}

function isoZ(d: Date): string {
  return d.toISOString();
}

/**
 * Built-in sender: POST to `pinnedIp` while keeping Host/SNI = url.hostname.
 * node:http(s) `lookup` forces the socket to the validated address, closing the
 * DNS-rebinding TOCTOU. Never follows redirects; drains+discards the body so
 * keep-alive sockets are freed; whole call bounded by `timeoutMs`.
 */
function sendPinned(
  url: URL,
  headers: Record<string, string>,
  body: string,
  pinnedIp: string,
  timeoutMs: number,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        servername: isHttps ? url.hostname : undefined, // TLS SNI stays the hostname
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...headers, host: url.host },
        // Force the connection to the already-validated IP — defeats rebinding.
        lookup: (_hostname, _opts, cb) => {
          const family = pinnedIp.includes(':') ? 6 : 4;
          (cb as (e: NodeJS.ErrnoException | null, a: string, f: number) => void)(null, pinnedIp, family);
        },
      },
      (res) => {
        let read = 0;
        res.on('data', (chunk: Buffer) => {
          read += chunk.length;
          if (read > MAX_RESPONSE_BYTES) res.destroy(); // cap + free the socket
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** Resolve a promise, or reject after `ms` — bounds a hanging DNS lookup. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function postOnce(
  delivery: WebhookDeliveryRow,
  target: WebhookTargetRow,
  opts: {
    fetchImpl?: typeof fetch;
    lookup?: (h: string) => Promise<Array<{ address: string }>>;
    timeoutMs: number;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  let url: URL;
  let pinnedIps: string[];
  try {
    url = assertSafeWebhookUrl(target.url);
    // Resolve + validate, bounded by the timeout so a hanging resolver can't
    // wedge the single-threaded dispatcher.
    pinnedIps = await withTimeout(
      assertResolvedHostSafe(url.hostname, opts.lookup),
      opts.timeoutMs,
      'dns resolve',
    );
  } catch (err) {
    return { ok: false, error: `blocked: ${err instanceof Error ? err.message : String(err)}` };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'mcp-memory-graph-webhook/1',
    'x-memory-event': delivery.event_type,
    'x-memory-delivery': delivery.id,
  };
  if (target.secret) headers['x-memory-signature'] = signWebhookBody(target.secret, delivery.payload);

  try {
    // Test path: an injected fetch is used as-is (tests don't pin sockets).
    if (opts.fetchImpl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      try {
        const res = await opts.fetchImpl(url.toString(), {
          method: 'POST',
          headers,
          body: delivery.payload,
          redirect: 'manual',
          signal: controller.signal,
        });
        if (res.status >= 200 && res.status < 300) return { ok: true };
        return { ok: false, error: `http ${res.status}` };
      } finally {
        clearTimeout(timer);
      }
    }

    // Production path: pin to a validated IP. Belt-and-suspenders re-check.
    const pin = pinnedIps[0];
    if (!pin || isBlockedHost(pin)) return { ok: false, error: 'blocked: no safe resolved address' };
    const res = await sendPinned(url, headers, delivery.payload, pin, opts.timeoutMs);
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, error: `http ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function dispatchPendingWebhooks(
  db: Database.Database,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  const now = options.now ?? new Date();
  const nowIso = isoZ(now);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const circuitThreshold = options.circuitThreshold ?? DEFAULT_CIRCUIT_THRESHOLD;
  const circuitCooldownMs = options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
  const base = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const cap = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  const ready = getReadyDeliveries(db, nowIso, options.limit ?? 50);
  const result: DispatchResult = { delivered: 0, failed: 0, dead: 0, attempted: 0 };

  // Atomic claim: flip a DUE pending/failed/expired-lease row → 'sending' and
  // re-lease next_attempt_at into the future. The `next_attempt_at <= now` guard
  // makes the claim idempotent under concurrency: a row another dispatcher just
  // claimed has a FUTURE lease, so this UPDATE matches 0 rows and we skip it (no
  // double-send). A crashed 'sending' row whose lease has expired is reclaimed.
  const claim = db.prepare(
    `UPDATE webhook_deliveries SET status = 'sending', next_attempt_at = ?
      WHERE id = ? AND status IN ('pending','failed','sending') AND next_attempt_at <= ?`,
  );
  const leaseUntil = isoZ(new Date(now.getTime() + leaseMs));

  for (const d of ready) {
    if (claim.run(leaseUntil, d.id, nowIso).changes === 0) continue; // claimed by another dispatcher
    result.attempted += 1;

    const outcome = await postOnce(d, d.target, { fetchImpl: options.fetchImpl, lookup: options.lookup, timeoutMs });
    const attempts = d.attempts + 1;

    if (outcome.ok) {
      db.prepare(
        `UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, delivered_at = ?, last_error = NULL WHERE id = ?`,
      ).run(attempts, nowIso, d.id);
      db.prepare(
        `UPDATE webhook_targets SET failure_count = 0, circuit_open_until = NULL, last_delivery_at = ? WHERE id = ?`,
      ).run(nowIso, d.target.id);
      result.delivered += 1;
      continue;
    }

    if (attempts >= maxAttempts) {
      db.prepare(`UPDATE webhook_deliveries SET status = 'dead', attempts = ?, last_error = ? WHERE id = ?`).run(
        attempts,
        outcome.error,
        d.id,
      );
      result.dead += 1;
    } else {
      const next = isoZ(new Date(now.getTime() + backoffMs(attempts, base, cap)));
      db.prepare(
        `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`,
      ).run(attempts, next, outcome.error, d.id);
      result.failed += 1;
    }

    // Per-target circuit breaker: atomic increment + read-back (a stale snapshot
    // would never trip when several of one target's deliveries fail in a run).
    const bumped = db
      .prepare<[string], { failure_count: number }>(
        'UPDATE webhook_targets SET failure_count = failure_count + 1 WHERE id = ? RETURNING failure_count',
      )
      .get(d.target.id);
    const newFailureCount = bumped?.failure_count ?? d.target.failure_count + 1;
    if (newFailureCount >= circuitThreshold) {
      db.prepare('UPDATE webhook_targets SET circuit_open_until = ? WHERE id = ?').run(
        isoZ(new Date(now.getTime() + circuitCooldownMs)),
        d.target.id,
      );
    }
  }

  /* c8 ignore start */
  if (result.attempted > 0) logger.debug({ event: 'webhook_dispatch', ...result });
  /* c8 ignore stop */
  return result;
}
