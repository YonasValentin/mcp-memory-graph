import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { createServer } from '../server.js';
import { closeDatabase } from '../db/connection.js';
import { getReadWriteDb, getEmbedder } from '../lib/direct-access.js';
import { registerApiRoutes, registerPublishRoutes } from '../api/routes.js';
import { rateLimitMiddleware, RateLimiter, defaultConfig as rateLimitDefaultConfig, publishConfig as rateLimitPublishConfig } from '../api/rate-limit.js';
import { renderMetrics, METRICS_CONTENT_TYPE } from '../api/metrics.js';
import { securityHeadersMiddleware } from '../api/security-headers.js';
import { dispatchPendingWebhooks } from '../events/dispatcher.js';
import { webhooksEnabled } from '../events/emitter.js';
import { logger } from '../lib/logger.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Application, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DEV_ORIGIN = 'http://localhost:5173';

function parseAllowedOrigins(): string[] {
  const raw = process.env.MCP_ALLOWED_ORIGINS;
  if (!raw) return [DEFAULT_DEV_ORIGIN];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function bindHost(): string {
  // Default to loopback. Operators must explicitly opt in to expose externally.
  return process.env.MCP_BIND ?? '127.0.0.1';
}

function bodyLimit(): string {
  return process.env.MCP_BODY_LIMIT ?? '256kb';
}

function bearerToken(): string | undefined {
  const t = process.env.MCP_AUTH_TOKEN;
  return t && t.length > 0 ? t : undefined;
}

/**
 * Per-request unique ID for log correlation. Surfaced via X-Request-Id and
 * res.locals.requestId.
 */
function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = (typeof incoming === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(incoming))
    ? incoming
    : randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/**
 * Allowlist-driven CORS. Origin is echoed only when present in the
 * `MCP_ALLOWED_ORIGINS` list. `Vary: Origin` is always set so caches don't
 * spread a permissive answer.
 */
function corsMiddleware(allowed: string[]) {
  const set = new Set(allowed);
  return function corsMw(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Vary', 'Origin');
    const origin = req.header('origin');
    if (origin && set.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * Constant-time string comparison. `crypto.timingSafeEqual` does NOT short-circuit
 * on the first differing byte (unlike `Buffer.compare`/`===`), so it does not leak
 * how many leading bytes matched via timing. It throws when the two buffers differ
 * in length, so we length-guard first and return false for unequal lengths.
 * (A length difference is already observable from the byte count, so the guard
 * leaks nothing the attacker can't measure directly.)
 */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Bearer-token middleware. When MCP_AUTH_TOKEN is set, every request to the
 * mounted prefix must present `Authorization: Bearer <token>`. Constant-time
 * comparison via `crypto.timingSafeEqual` (length-guarded) to avoid timing attacks.
 */
function bearerMiddleware(token: string) {
  const expected = `Bearer ${token}`;
  return function bearerMw(req: Request, res: Response, next: NextFunction): void {
    const got = req.header('authorization') ?? '';
    const ok = timingSafeStrEqual(got, expected);
    if (!ok) {
      res.status(401).json({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
        requestId: res.locals.requestId,
      });
      return;
    }
    next();
  };
}

/**
 * Light DNS-rebinding protection: when bound to loopback, reject Host headers
 * that don't resolve to a localhost form. Skipped for non-loopback binds; in
 * that case operators are expected to terminate at a reverse proxy.
 */
function localhostHostValidation(host: string) {
  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  return function hostMw(req: Request, res: Response, next: NextFunction): void {
    if (!isLoopback) return next();
    const hostHeader = (req.header('host') ?? '').split(':')[0];
    const ok = hostHeader === 'localhost'
      || hostHeader === '127.0.0.1'
      || hostHeader === '[::1]'
      || hostHeader === '::1';
    if (!ok) {
      res.status(403).json({
        error: 'Forbidden host header',
        code: 'BAD_HOST',
        requestId: res.locals.requestId,
      });
      return;
    }
    next();
  };
}

export interface BuildAppDeps {
  getDb: () => Database.Database;
  getEmbedder: () => Promise<EmbeddingProvider>;
  /** Override the rate limiter for /api and /mcp (e.g. for tests). */
  rateLimiter?: RateLimiter;
  /**
   * Override the limiter for the public /publish surface. Defaults to a
   * dedicated, stricter limiter; when only `rateLimiter` is supplied (tests),
   * that one is reused so a single injected bucket drives /publish too.
   */
  publishRateLimiter?: RateLimiter;
  /**
   * Directory holding the built web dashboard (index.html + assets). Defaults
   * to `<dist>/web` relative to this module. Exposed so tests can point the SPA
   * static/fallback serving at a fixture dir without the production build layout.
   */
  webDir?: string;
}

export interface BuiltApp {
  app: Application;
  /** mcp-session-id → transport */
  transports: Record<string, StreamableHTTPServerTransport>;
  /** mcp-session-id → MCP server */
  servers: Record<string, McpServer>;
}

/**
 * Construct the Express application without binding a port. Used by both
 * `runServe` and the test harness.
 */
export function buildApp(deps: BuildAppDeps): BuiltApp {
  const app = express();
  const host = bindHost();
  const allowed = parseAllowedOrigins();
  const limiter = deps.rateLimiter ?? new RateLimiter(rateLimitDefaultConfig());
  // The public /publish surface gets its own (stricter) limiter. If a test
  // injects a single `rateLimiter`, reuse it so the injected bucket also bounds
  // /publish; otherwise build a dedicated stricter one.
  const publishLimiter =
    deps.publishRateLimiter ?? deps.rateLimiter ?? new RateLimiter(rateLimitPublishConfig());

  const isRemote = host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';

  // Trust the first proxy hop so req.ip reflects X-Forwarded-For when behind
  // Cloudflare/NGINX (for logging/diagnostics only). Ignored when bound to
  // loopback. NOTE: the rate limiter does NOT key on req.ip/XFF (which is
  // client-spoofable even with trust proxy) — it keys on the immediate socket
  // peer via `clientKey` (see src/api/rate-limit.ts), optionally augmented by an
  // operator-trusted proxy header (MCP_TRUSTED_IP_HEADER).
  if (isRemote) {
    app.set('trust proxy', 1);
  }

  app.use(requestIdMiddleware);
  app.use(securityHeadersMiddleware({ isRemote }));
  app.use(localhostHostValidation(host));
  app.use(express.json({ limit: bodyLimit() }));
  // No route consumes application/x-www-form-urlencoded bodies; the parser was
  // dead surface (and its 64kb cap diverged from MCP_BODY_LIMIT). Dropped.
  app.use(corsMiddleware(allowed));

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const servers: Record<string, McpServer> = {};
  let embedderWarm = false;

  // Health endpoint: cheap probe (no DB hit) for liveness.
  app.get('/live', (_req, res) => {
    res.json({ status: 'ok', uptime_s: Math.round(process.uptime()) });
  });

  // Health: deeper probe (DB SELECT 1, schema_version, embedder warm-state).
  // Used by load balancers to drop unhealthy replicas. Embedder warm-state is
  // a cached "have we ever produced an embedding successfully" flag — set by
  // /ready when warming up. Set MCP_HEALTH_REQUIRE_EMBEDDER=1 to require it.
  app.get('/health', (_req: Request, res: Response) => {
    let dbOk = false;
    let schemaVersion: string | null = null;
    try {
      const db = deps.getDb();
      const r = db.prepare<[], { v: number }>('SELECT 1 as v').get();
      dbOk = r?.v === 1;
      const sv = db
        .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
        .get('schema_version');
      schemaVersion = sv?.value ?? null;
    } catch {
      dbOk = false;
    }
    const embedderOk = embedderWarm;
    const requireEmbedder = process.env.MCP_HEALTH_REQUIRE_EMBEDDER === '1';
    const ok = dbOk && (embedderOk || !requireEmbedder);
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      db_ok: dbOk,
      embedder_ok: embedderOk,
      schema_version: schemaVersion,
      uptime_s: Math.round(process.uptime()),
    });
  });

  // Readiness: like /health but actually loads the embedder if it isn't
  // warm yet. Returns 503 until the model is loaded. Use this for one-shot
  // pre-warm probes; use /health for continuous load-balancer checks.
  app.get('/ready', async (_req: Request, res: Response) => {
    try {
      const e = await deps.getEmbedder();
      if (!e.isReady()) await e.initialize();
      embedderWarm = e.isReady();
    } catch (err) {
      logger.error({ event: 'embedder_init_failed', err: err instanceof Error ? err.message : String(err) });
      embedderWarm = false;
    }
    res.status(embedderWarm ? 200 : 503).json({
      status: embedderWarm ? 'ready' : 'not-ready',
      embedder_ok: embedderWarm,
    });
  });

  // /metrics — Prometheus exposition. Gated behind MCP_METRICS_ENABLED to
  // avoid leaking traffic patterns by default. Bearer auth from the /api
  // / /mcp prefixes does NOT cover this path; we attach an explicit guard.
  app.get('/metrics', (req: Request, res: Response) => {
    if (process.env.MCP_METRICS_ENABLED !== '1') {
      res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      return;
    }
    const tok = bearerToken();
    if (tok) {
      const expected = `Bearer ${tok}`;
      // Constant-time compare, matching the /api + /mcp bearerMiddleware — a
      // plain !== leaks the secret via response-timing on this guarded path.
      if (!timingSafeStrEqual(req.header('authorization') ?? '', expected)) {
        res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
        return;
      }
    }
    res.setHeader('Content-Type', METRICS_CONTENT_TYPE);
    res.send(renderMetrics());
  });

  // Rate-limit applies to /api and /mcp; /health and /live are exempt so probes don't burn tokens.
  const limitMw = rateLimitMiddleware(limiter);
  app.use('/api', limitMw);
  app.use('/mcp', limitMw);

  // Bearer auth: applied to BOTH /api and /mcp when MCP_AUTH_TOKEN is set.
  // Skipping auth without a token is opt-in (`MCP_AUTH_OPTIONAL=1`) — by default
  // a missing token is a startup error so accidental "no auth" deployments don't ship.
  const token = bearerToken();
  if (token) {
    app.use('/api', bearerMiddleware(token));
    app.use('/mcp', bearerMiddleware(token));
  } else if (process.env.MCP_AUTH_OPTIONAL !== '1' && isRemote) {
    throw new Error(
      'MCP_AUTH_TOKEN is not set and MCP_BIND is not loopback. ' +
      'Set MCP_AUTH_TOKEN, bind to 127.0.0.1, or set MCP_AUTH_OPTIONAL=1 to allow unauthenticated access.',
    );
  }

  // ── REST API endpoints ────────────────────────────────────────────────
  registerApiRoutes(app, deps.getDb, deps.getEmbedder);

  // ── Public read-only memory wiki (T18) ────────────────────────────────
  // Mounted OUTSIDE the /api and /mcp bearer prefixes — public by design,
  // gated instead by access_level inside the publish data layer. It IS rate
  // limited (its own stricter bucket): each search runs a query embedding, an
  // unauthenticated CPU-DoS lever, so it must not be unmetered.
  app.use('/publish', rateLimitMiddleware(publishLimiter));
  registerPublishRoutes(app, deps.getDb, deps.getEmbedder);

  // POST /mcp — main MCP handler
  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          delete transports[sid];
          delete servers[sid];
        }
      };

      const server = createServer();
      const sid = transport.sessionId;
      if (sid) {
        servers[sid] = server;
      }

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Bad Request: No valid session or initialize request' },
      id: null,
    });
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Bad Request: Invalid or missing session ID' },
        id: null,
      });
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Bad Request: Invalid or missing session ID' },
        id: null,
      });
      return;
    }
    await transports[sessionId].close();
    delete transports[sessionId];
    delete servers[sessionId];
    res.status(200).end();
  });

  // ── Static file serving for web dashboard ────────────────────────────
  const webDir = deps.webDir ?? path.resolve(__dirname, '..', 'web');
  if (existsSync(webDir)) {
    app.use(express.static(webDir));

    app.get('{*path}', (req: Request, res: Response, next: NextFunction) => {
      if (
        req.path.startsWith('/api') ||
        req.path.startsWith('/mcp') ||
        req.path.startsWith('/publish') ||
        req.path === '/health' ||
        req.path === '/live' ||
        req.path === '/ready' ||
        req.path === '/metrics'
      ) {
        return next();
      }
      if (existsSync(path.join(webDir, 'index.html'))) {
        // SPA fallback: serve index.html for every client-side route so a
        // deep-link or refresh on /browse, /search, /memory/:id renders the
        // app instead of a JSON 404. Use the (filename, { root }) form rather
        // than res.sendFile(absolutePath): in Express 5, `send` applies its
        // default `dotfiles: 'ignore'` policy to the WHOLE absolute path, so an
        // install dir containing a dot-prefixed segment (e.g. ~/.config,
        // ~/.local/share, a .claude/ worktree, a .pnpm store) makes every
        // fallback 404. The root form scopes the dotfile check to the path
        // *after* root ("index.html" — no dot segment), so it serves regardless
        // of where the dashboard is installed.
        res.sendFile('index.html', { root: webDir }, (err) => {
          if (err) next(err);
        });
      } else {
        next();
      }
    });
  }

  // ── JSON 404 + error envelopes (must be LAST) ─────────────────────────────
  // Any request that matched no route gets a structured JSON 404 instead of
  // Express's default HTML page.
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not found',
      code: 'NOT_FOUND',
      requestId: res.locals.requestId,
    });
  });

  // Final 4-arg error handler: turns thrown/forwarded errors (notably
  // express.json's parse failure and body-too-large) into the same JSON
  // envelope the route layer uses — never an HTML stack-trace page. Safe by
  // default: the raw message is only surfaced when NODE_ENV=development.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = res.locals.requestId as string | undefined;
    const e = err as { type?: string; status?: number; statusCode?: number; message?: string };
    const status = e.status ?? e.statusCode ?? 500;

    if (e.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON body', code: 'INVALID_JSON', requestId });
      return;
    }
    if (e.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body too large', code: 'PAYLOAD_TOO_LARGE', requestId });
      return;
    }
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: 'Bad request', code: 'BAD_REQUEST', requestId });
      return;
    }
    logger.error({
      event: 'unhandled_error',
      requestId,
      err: e.message ?? String(err),
    });
    res.status(500).json({
      error: 'Internal Server Error',
      code: 'INTERNAL',
      requestId,
      detail: process.env.NODE_ENV === 'development' ? (e.message ?? String(err)) : undefined,
    });
  });

  return { app, transports, servers };
}

/**
 * Periodically drain the webhook delivery queue while the server runs (battle-v7
 * L4). Without this the bus only ever flushed when a caller MANUALLY invoked
 * memory_webhook {action:'dispatch'} — so in a long-running server, enqueued
 * deliveries (memory.created / updated / superseded / forgotten …) never fired
 * autonomously. Gated by webhooksEnabled() at the call site. The timer is
 * `unref()`'d so it never keeps the process alive on its own, an in-flight guard
 * prevents overlapping drains (each does real network I/O), and errors are
 * swallowed (a flaky receiver must never crash the server). Returns a stop
 * function for graceful shutdown.
 */
export function startWebhookDispatchLoop(
  getDb: () => Database.Database,
  opts?: { intervalMs?: number; dispatch?: typeof dispatchPendingWebhooks },
): () => void {
  const intervalMs = opts?.intervalMs ?? parseInt(process.env.MCP_WEBHOOK_DISPATCH_INTERVAL_MS ?? '10000', 10);
  const dispatch = opts?.dispatch ?? dispatchPendingWebhooks;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    Promise.resolve()
      .then(() => dispatch(getDb()))
      .catch((err) =>
        logger.warn({
          event: 'webhook_dispatch_loop_error',
          err: err instanceof Error ? err.message : String(err),
        }),
      )
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function runServe(): Promise<void> {
  const port = parseInt(process.env.MCP_PORT ?? '3100', 10);
  const host = bindHost();

  const { app, transports } = buildApp({ getDb: getReadWriteDb, getEmbedder });

  // Drain the webhook queue on an interval so deliveries fire autonomously (L4).
  const stopWebhookLoop = webhooksEnabled() ? startWebhookDispatchLoop(getReadWriteDb) : undefined;

  const shutdown = async () => {
    logger.info({ event: 'shutdown_start' });
    stopWebhookLoop?.();
    for (const sid of Object.keys(transports)) {
      await transports[sid].close();
      delete transports[sid];
    }
    closeDatabase();
    logger.info({ event: 'shutdown_complete' });
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const server = app.listen(port, host, () => {
    logger.info({
      event: 'server_listening',
      host,
      port,
      auth: bearerToken() ? 'bearer' : 'none',
    });
    if (!bearerToken()) {
      logger.warn({
        event: 'auth_disabled',
        msg: 'MCP_AUTH_TOKEN is not set — server is unauthenticated.',
      });
    }
  });

  // Bound slow clients so a misbehaving peer can't hold a socket forever.
  server.setTimeout(15_000);
}
