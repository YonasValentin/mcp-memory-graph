// ── Fastify HTTP API Server ────────────────────────────────────────────────

import type { EnterpriseConfig } from '../enterprise/config.js';
import type { StorageBackend } from '../enterprise/storage.js';
import type { EmbeddingProvider } from '../types.js';
import type { AuthService } from '../enterprise/auth.js';
import type { CacheService } from '../enterprise/cache.js';
import type { Logger } from '../enterprise/logger.js';
import type { Metrics } from '../enterprise/metrics.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createErrorHandler } from './middleware/error-handler.js';
import { registerMemoryRoutes } from './routes/memories.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';

export interface HttpServerDeps {
  config: EnterpriseConfig;
  storage: StorageBackend;
  embedder: EmbeddingProvider;
  authService: AuthService;
  cache: CacheService;
  logger: Logger;
  metrics: Metrics;
}

export async function createHttpServer(deps: HttpServerDeps): Promise<any> {
  const { config, storage, embedder, authService, cache, logger, metrics } = deps;
  const startTime = Date.now();

  const fastify = (await import('fastify')).default;

  const app = fastify({
    logger: false, // We use our own logger
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024, // 10MB
  });

  // ── CORS ────────────────────────────────────────────────────────────
  try {
    const cors = (await import('@fastify/cors')).default;
    await app.register(cors, {
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
      maxAge: 86400,
    });
  } catch {
    logger.warn('CORS plugin not available, skipping');
  }

  // ── Rate Limiting ───────────────────────────────────────────────────
  if (config.rateLimit.enabled) {
    try {
      const rateLimit = (await import('@fastify/rate-limit')).default;
      await app.register(rateLimit, {
        global: true,
        max: async (request: any) => {
          const ctx = request.tenantContext;
          if (!ctx) return config.rateLimit.maxPerMinute;
          switch (ctx.plan) {
            case 'enterprise': return config.rateLimit.maxPerMinuteEnterprise;
            case 'pro': return config.rateLimit.maxPerMinutePro;
            default: return config.rateLimit.maxPerMinute;
          }
        },
        timeWindow: '1 minute',
        keyGenerator: (request: any) => {
          return request.tenantContext?.tenantId ?? request.ip;
        },
      });
    } catch {
      logger.warn('Rate limit plugin not available, skipping');
    }
  }

  // ── Error Handler ──────────────────────────────────────────────────
  app.setErrorHandler(createErrorHandler(logger, metrics));

  // ── Request Logging & Metrics ──────────────────────────────────────
  app.addHook('onResponse', async (request: any, reply: any) => {
    const duration = reply.elapsedTime / 1000; // seconds
    const route = request.routeOptions?.url ?? request.url;
    metrics.incHttpRequests(request.method, route, reply.statusCode);
    metrics.observeHttpDuration(request.method, route, duration);

    logger.debug('Request completed', {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
      tenantId: request.tenantContext?.tenantId,
    });
  });

  // ── Public Routes (no auth) ────────────────────────────────────────
  await registerHealthRoutes(app, { storage, embedder, metrics, startTime });
  await registerAuthRoutes(app, { authService, storage, logger });

  // ── Protected Routes (auth required) ───────────────────────────────
  const authenticate = createAuthMiddleware(authService, logger);
  app.addHook('onRequest', async (request: any, reply: any) => {
    // Skip auth for public routes
    const publicPaths = ['/health', '/health/ready', '/health/live', '/metrics',
                         '/api/v1/auth/token', '/api/v1/auth/api-key', '/api/v1/tenants'];
    if (publicPaths.some(p => request.url.startsWith(p))) return;
    if (request.url.startsWith('/api/')) {
      await authenticate(request, reply);
    }
  });

  await registerMemoryRoutes(app, { storage, embedder, logger, metrics, cache });

  return app;
}

export async function startHttpServer(app: any, config: EnterpriseConfig, logger: Logger): Promise<void> {
  try {
    const address = await app.listen({ port: config.port, host: config.host });
    logger.info(`PureGate Knowledge API running at ${address}`, {
      port: config.port,
      host: config.host,
    });
  } catch (err) {
    logger.fatal('Failed to start HTTP server', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}
