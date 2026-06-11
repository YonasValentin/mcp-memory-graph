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
import { findApiKeyByToken, touchLastUsed } from '../db/api-keys.js';
import { runWithPrincipal } from '../lib/request-context.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Application, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import type { EmbeddingProvider } from '../types.js';

/** The session-owner sentinel for a session minted under the legacy env token. */
const LEGACY_OWNER = '__legacy__';

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
 * Live non-revoked api_key count, used by the auth-activation rule (auth
 * configured ⇔ env token set OR ≥1 non-revoked key).
 *
 * Counted on EVERY consult — NOT cached. A prior 30s TTL cache (battle finding
 * F2) hid the count's 1→0 transition: revoking the last key on a remote bind
 * left the cached `1` for ≤30s, so the server kept serving the whole corpus
 * UNAUTHENTICATED (fail-open) until the TTL lapsed — and a CLI `keys
 * create`/`revoke` runs in a SEPARATE process from the server, so it could
 * never bust an in-process cache anyway. The count is a single indexed query;
 * the legacy-token path short-circuits before it (`envToken !== undefined ||
 * …`), so a single-token deployment never pays for it, and api-key/anonymous
 * requests are rate-limited. Correctness over a micro-optimisation on the auth
 * boundary.
 */
function liveKeyCount(getDb: () => Database.Database): number {
  try {
    return (
      getDb()
        .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM api_keys WHERE revoked_at IS NULL')
        .get()?.c ?? 0
    );
  /* c8 ignore start */
  } catch {
    // No api_keys table (pre-v16 DB) → no keys; auth-activation falls back to the
    // env-token rule. Never let a counting failure crash the request path.
    return 0;
  }
  /* c8 ignore stop */
}

/**
 * Retained as a no-op for test-API stability (the key-count cache was removed in
 * F2; counting is now always live, so there is nothing to clear).
 */
export function clearKeyCountCache(): void {
  /* no-op: key count is no longer cached */
}

/**
 * Whether auth is configured: an env token is set OR at least one non-revoked
 * api_key exists. The /api + /mcp mount and the remote-bind startup gate both
 * key off this — so a key-only deployment (no MCP_AUTH_TOKEN) is authenticated.
 */
function authConfigured(getDb: () => Database.Database, envToken: string | undefined): boolean {
  return envToken !== undefined || liveKeyCount(getDb) > 0;
}

/**
 * RBAC v1 §4 — auth middleware for /api and /mcp. Resolution order (legacy FIRST
 * so existing single-token deployments are byte-identical):
 *   1. No / malformed Authorization → 401 (when auth is configured).
 *   2. `Bearer <envToken>` (constant-time, only when envToken set) → LEGACY mode:
 *      next() WITHOUT establishing an ALS principal (env-pin / no-pin behaviour
 *      is exactly today's). res.locals.principalKeyId = '__legacy__'.
 *   3. Else resolve the token via findApiKeyByToken (which already rejects
 *      revoked/expired). Found → build a PrincipalContext, touchLastUsed,
 *      res.locals.principalKeyId = keyId, and run the rest of the request inside
 *      runWithPrincipal so the tenancy helpers (and the §6 ceiling) read it.
 *   4. Else 401 — UNKNOWN-key and BAD-legacy-token share ONE envelope (no
 *      enumeration oracle).
 *
 * When auth is NOT configured (no env token AND no keys), the request passes
 * with no principal on a LOOPBACK bind (the local default) — but on a REMOTE
 * bind it is REFUSED (503) unless MCP_AUTH_OPTIONAL=1. The remote "never serve
 * unauthenticated" invariant is checked at startup AND per-request (battle
 * finding F2): revoking the last key at runtime made `authConfigured` flip to
 * false, and the old self-disabling pass-through then served the whole corpus
 * unauthenticated on a network bind. Re-gating here keeps the startup guarantee
 * continuously true, not just at boot.
 */
function authMiddleware(
  getDb: () => Database.Database,
  envToken: string | undefined,
  isRemote: boolean,
) {
  const legacyExpected = envToken !== undefined ? `Bearer ${envToken}` : undefined;
  function unauthorized(res: Response): void {
    res.status(401).json({
      error: 'Unauthorized',
      code: 'UNAUTHORIZED',
      requestId: res.locals.requestId,
    });
  }
  return function authMw(req: Request, res: Response, next: NextFunction): void {
    if (!authConfigured(getDb, envToken)) {
      // F2: a remote bind must NEVER serve unauthenticated unless explicitly
      // opted in — enforce the startup invariant on every request so a runtime
      // de-configuration (last key revoked) fails CLOSED, not open.
      if (isRemote && process.env.MCP_AUTH_OPTIONAL !== '1') {
        res.status(503).json({
          error: 'Service Unavailable: authentication not configured on a network bind',
          code: 'AUTH_NOT_CONFIGURED',
          requestId: res.locals.requestId,
        });
        return;
      }
      // Loopback local default (or MCP_AUTH_OPTIONAL=1): pass through with no
      // principal, byte-identical to the pre-RBAC behaviour.
      next();
      return;
    }

    const got = req.header('authorization') ?? '';

    // (2) Legacy env token — checked FIRST and constant-time, so a single-token
    // deployment never touches the ALS path.
    if (legacyExpected !== undefined && timingSafeStrEqual(got, legacyExpected)) {
      res.locals.principalKeyId = LEGACY_OWNER;
      next();
      return;
    }

    // Extract the presented token; anything that isn't `Bearer <token>` is a 401.
    if (!got.startsWith('Bearer ')) {
      unauthorized(res);
      return;
    }
    const token = got.slice('Bearer '.length);

    // (3) API-key principal. findApiKeyByToken rejects revoked/expired internally.
    const key = findApiKeyByToken(getDb(), token);
    if (!key) {
      unauthorized(res);
      return;
    }
    touchLastUsed(getDb(), key.id);
    res.locals.principalKeyId = key.id;
    runWithPrincipal(
      {
        principal: key.principal,
        keyId: key.id,
        namespaces: key.namespaces,
        maxAccessLevel: key.maxAccessLevel,
      },
      () => next(),
    );
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
  // RBAC v1 §4 — mcp-session-id → owning identity (a key id, or '__legacy__' for
  // a session minted under the env token / unauthenticated mode). A session is
  // OWNED by whoever initialized it; a later request on that sid carrying a
  // DIFFERENT authenticated identity is refused (403), so a valid key can never
  // ride another principal's open transport.
  const sessionOwner: Record<string, string> = {};
  let embedderWarm = false;

  // The authenticated identity for THIS request: the key id (set by authMw),
  // '__legacy__' for the env token, or '__legacy__' as the unauthenticated
  // default (no principal == the legacy ownership class, which is correct: an
  // unauthenticated deployment has exactly one trust class).
  const requestOwner = (res: Response): string =>
    (res.locals.principalKeyId as string | undefined) ?? LEGACY_OWNER;

  // Refuse a follow-up /mcp request whose authenticated identity differs from the
  // session's owner. Returns true when it sent the 403 (caller must NOT touch the
  // transport). A session id we don't know is left to the per-handler "invalid
  // session" path.
  const sessionMismatch = (req: Request, res: Response): boolean => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (!sid || !(sid in sessionOwner)) return false;
    if (sessionOwner[sid] === requestOwner(res)) return false;
    res.status(403).json({
      error: 'Session belongs to a different principal',
      code: 'SESSION_PRINCIPAL_MISMATCH',
      requestId: res.locals.requestId,
    });
    return true;
  };

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
      // Constant-time compare, matching the /api + /mcp auth path — a plain !==
      // leaks the secret via response-timing on this guarded path. /metrics is an
      // operator surface: env token ONLY, an api-key principal is NOT accepted.
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

  // Auth: applied to BOTH /api and /mcp. RBAC v1 §4 — auth is "configured" when
  // MCP_AUTH_TOKEN is set OR ≥1 non-revoked api_key exists; the middleware itself
  // resolves a legacy env token (byte-identical to before) OR an api-key
  // principal per request, and passes through unauthenticated only when neither
  // is configured. The middleware is ALWAYS mounted (it self-disables when auth
  // isn't configured) so a key created while serving takes effect within the
  // key-count TTL without a restart. Skipping auth without a token is opt-in
  // (`MCP_AUTH_OPTIONAL=1`) — by default a remote bind with no auth at all is a
  // startup error so accidental "no auth" deployments don't ship.
  const token = bearerToken();
  const authMw = authMiddleware(deps.getDb, token, isRemote);
  app.use('/api', authMw);
  app.use('/mcp', authMw);
  if (!authConfigured(deps.getDb, token) && process.env.MCP_AUTH_OPTIONAL !== '1' && isRemote) {
    throw new Error(
      'MCP_AUTH_TOKEN is not set and MCP_BIND is not loopback. ' +
      'Set MCP_AUTH_TOKEN, create an API key (memory keys create), bind to 127.0.0.1, ' +
      'or set MCP_AUTH_OPTIONAL=1 to allow unauthenticated access.',
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
      // §4 session binding: a key may only drive a session it owns. Refuse a
      // mismatch BEFORE touching the transport (no state mutation, no leak).
      if (sessionMismatch(req, res)) return;
      await transports[sessionId].handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      // Bind the new session to the identity that authenticated THIS initialize.
      const owner = requestOwner(res);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
          sessionOwner[sid] = owner;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          delete transports[sid];
          delete servers[sid];
          delete sessionOwner[sid];
        }
      };

      const server = createServer();
      const sid = transport.sessionId;
      if (sid) {
        servers[sid] = server;
        sessionOwner[sid] = owner;
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
    if (sessionMismatch(req, res)) return;
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
    if (sessionMismatch(req, res)) return;
    await transports[sessionId].close();
    delete transports[sessionId];
    delete servers[sessionId];
    delete sessionOwner[sessionId];
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

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ event: 'shutdown_start' });
    stopWebhookLoop?.();
    for (const sid of Object.keys(transports)) {
      await transports[sid].close();
      delete transports[sid];
    }
    closeDatabase();
    logger.info({ event: 'shutdown_complete' });
    // V17-A: `process.exit(0)` with a loaded ONNX model aborts (SIGABRT) in
    // onnxruntime's static destructors — die by re-raised default-disposition
    // signal instead, which skips C exit teardown. Full rationale + PoC
    // evidence: exitBySignal() in ../db/connection.ts.
    if (process.platform === 'win32') {
      process.exit(0);
    }
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  };

  // NOTE: in practice db/connection.ts's own SIGINT/SIGTERM handler (registered
  // at module import, i.e. BEFORE these) closes the DBs and self-kills
  // synchronously, so this shutdown almost never runs on a signal — it covers
  // the case where that registration order ever changes, and stays the single
  // place that knows how to drain transports/webhooks.
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
