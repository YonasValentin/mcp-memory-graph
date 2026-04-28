import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { createServer } from '../server.js';
import { closeDatabase } from '../db/connection.js';
import { getReadWriteDb, getEmbedder } from '../lib/direct-access.js';
import { registerApiRoutes } from '../api/routes.js';
import { rateLimitMiddleware, RateLimiter, defaultConfig as rateLimitDefaultConfig } from '../api/rate-limit.js';

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
 * Bearer-token middleware. When MCP_AUTH_TOKEN is set, every request to the
 * mounted prefix must present `Authorization: Bearer <token>`. Constant-time
 * comparison via Buffer.compare to avoid timing attacks.
 */
function bearerMiddleware(token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  return function bearerMw(req: Request, res: Response, next: NextFunction): void {
    const got = req.header('authorization') ?? '';
    const candidate = Buffer.from(got);
    const ok = candidate.length === expected.length && Buffer.compare(candidate, expected) === 0;
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
  /** Override the rate limiter (e.g. for tests). */
  rateLimiter?: RateLimiter;
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

  // Trust the first proxy hop so req.ip reflects X-Forwarded-For when behind
  // Cloudflare/NGINX. Ignored when bound to loopback only.
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    app.set('trust proxy', 1);
  }

  app.use(requestIdMiddleware);
  app.use(localhostHostValidation(host));
  app.use(express.json({ limit: bodyLimit() }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(corsMiddleware(allowed));

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const servers: Record<string, McpServer> = {};

  // Health endpoint: cheap probe (no DB hit) for liveness.
  app.get('/live', (_req, res) => {
    res.json({ status: 'ok', uptime_s: Math.round(process.uptime()) });
  });

  // Health: deeper probe (DB SELECT 1, schema_version). Used by
  // load balancers to drop unhealthy replicas.
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
    const status = dbOk ? 'ok' : 'degraded';
    res.status(dbOk ? 200 : 503).json({
      status,
      db_ok: dbOk,
      schema_version: schemaVersion,
      uptime_s: Math.round(process.uptime()),
    });
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
  } else if (process.env.MCP_AUTH_OPTIONAL !== '1' && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      'MCP_AUTH_TOKEN is not set and MCP_BIND is not loopback. ' +
      'Set MCP_AUTH_TOKEN, bind to 127.0.0.1, or set MCP_AUTH_OPTIONAL=1 to allow unauthenticated access.',
    );
  }

  // ── REST API endpoints ────────────────────────────────────────────────
  registerApiRoutes(app, deps.getDb, deps.getEmbedder);

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
  const webDir = path.resolve(__dirname, '..', 'web');
  if (existsSync(webDir)) {
    app.use(express.static(webDir));

    app.get('{*path}', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/mcp') || req.path === '/health' || req.path === '/live') {
        return next();
      }
      const indexPath = path.join(webDir, 'index.html');
      if (existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        next();
      }
    });
  }

  return { app, transports, servers };
}

export async function runServe(): Promise<void> {
  const port = parseInt(process.env.MCP_PORT ?? '3100', 10);
  const host = bindHost();

  const { app, transports } = buildApp({ getDb: getReadWriteDb, getEmbedder });

  const shutdown = async () => {
    console.error('Shutting down MCP HTTP server...');
    for (const sid of Object.keys(transports)) {
      await transports[sid].close();
      delete transports[sid];
    }
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const server = app.listen(port, host, () => {
    console.error(`MCP Memory Server running on http://${host}:${port}`);
    console.error(`Health check: http://${host}:${port}/health`);
    if (!bearerToken()) {
      console.error('WARNING: MCP_AUTH_TOKEN is not set — server is unauthenticated.');
    }
  });

  // Bound slow clients so a misbehaving peer can't hold a socket forever.
  server.setTimeout(15_000);
}
