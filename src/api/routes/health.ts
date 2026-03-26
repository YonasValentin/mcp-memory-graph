// ── Health Check Routes ───────────────────────────────────────────────────

import type { StorageBackend } from '../../enterprise/storage.js';
import type { EmbeddingProvider } from '../../types.js';
import type { Metrics } from '../../enterprise/metrics.js';

interface HealthDeps {
  storage: StorageBackend;
  embedder: EmbeddingProvider;
  metrics: Metrics;
  startTime: number;
}

export async function registerHealthRoutes(app: any, deps: HealthDeps): Promise<void> {
  const { storage, embedder, metrics, startTime } = deps;

  // ── GET /health ───────────────────────────────────────────────────────
  app.get('/health', async (_request: any, reply: any) => {
    reply.send({
      status: 'ok',
      uptime: Math.round((Date.now() - startTime) / 1000),
      version: '2.0.0',
      timestamp: new Date().toISOString(),
    });
  });

  // ── GET /health/ready ─────────────────────────────────────────────────
  app.get('/health/ready', async (_request: any, reply: any) => {
    const checks: Record<string, string> = {};

    // Check embedder
    checks.embedder = embedder.isReady() ? 'ok' : 'not_ready';

    // Check storage
    try {
      const defaultCtx = { tenantId: 'health-check', userId: 'system', userRole: 'viewer' as const, plan: 'free' as const };
      await storage.getStats(defaultCtx);
      checks.storage = 'ok';
    } catch {
      checks.storage = 'error';
    }

    const allOk = Object.values(checks).every(v => v === 'ok');
    reply.code(allOk ? 200 : 503).send({
      status: allOk ? 'ready' : 'not_ready',
      checks,
    });
  });

  // ── GET /health/live ──────────────────────────────────────────────────
  app.get('/health/live', async (_request: any, reply: any) => {
    reply.code(200).send({ status: 'alive' });
  });

  // ── GET /metrics ──────────────────────────────────────────────────────
  app.get('/metrics', async (_request: any, reply: any) => {
    const metricsText = await metrics.getMetricsText();
    reply.header('Content-Type', metrics.getContentType()).send(metricsText);
  });
}
