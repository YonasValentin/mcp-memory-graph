// ── Prometheus Metrics ─────────────────────────────────────────────────────

import type { EnterpriseConfig } from './config.js';
import type { Logger } from './logger.js';

export interface Metrics {
  incHttpRequests(method: string, route: string, statusCode: number): void;
  observeHttpDuration(method: string, route: string, durationSec: number): void;
  observeSearchDuration(tenantId: string, mode: string, durationSec: number): void;
  observeEmbeddingDuration(provider: string, durationSec: number): void;
  incMemoriesStored(tenantId: string): void;
  incMemoriesDeleted(tenantId: string, count: number): void;
  incErrors(tenantId: string, operation: string): void;
  setActiveConnections(count: number): void;
  getMetricsText(): Promise<string>;
  getContentType(): string;
}

class PromClientMetrics implements Metrics {
  private httpRequests: any;
  private httpDuration: any;
  private searchDuration: any;
  private embeddingDuration: any;
  private memoriesStored: any;
  private memoriesDeleted: any;
  private errors: any;
  private activeConnections: any;
  private registry: any;

  constructor(client: any) {
    this.registry = new client.Registry();

    client.collectDefaultMetrics({ register: this.registry });

    this.httpRequests = new client.Counter({
      name: 'puregate_http_requests_total',
      help: 'Total HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.registry],
    });

    this.httpDuration = new client.Histogram({
      name: 'puregate_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.searchDuration = new client.Histogram({
      name: 'puregate_search_duration_seconds',
      help: 'Search operation duration in seconds',
      labelNames: ['tenant_id', 'mode'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });

    this.embeddingDuration = new client.Histogram({
      name: 'puregate_embedding_duration_seconds',
      help: 'Embedding generation duration in seconds',
      labelNames: ['provider'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
      registers: [this.registry],
    });

    this.memoriesStored = new client.Counter({
      name: 'puregate_memories_stored_total',
      help: 'Total memories stored',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.memoriesDeleted = new client.Counter({
      name: 'puregate_memories_deleted_total',
      help: 'Total memories deleted',
      labelNames: ['tenant_id'],
      registers: [this.registry],
    });

    this.errors = new client.Counter({
      name: 'puregate_errors_total',
      help: 'Total errors',
      labelNames: ['tenant_id', 'operation'],
      registers: [this.registry],
    });

    this.activeConnections = new client.Gauge({
      name: 'puregate_active_connections',
      help: 'Current active connections',
      registers: [this.registry],
    });
  }

  incHttpRequests(method: string, route: string, statusCode: number): void {
    this.httpRequests.inc({ method, route, status_code: String(statusCode) });
  }
  observeHttpDuration(method: string, route: string, durationSec: number): void {
    this.httpDuration.observe({ method, route }, durationSec);
  }
  observeSearchDuration(tenantId: string, mode: string, durationSec: number): void {
    this.searchDuration.observe({ tenant_id: tenantId, mode }, durationSec);
  }
  observeEmbeddingDuration(provider: string, durationSec: number): void {
    this.embeddingDuration.observe({ provider }, durationSec);
  }
  incMemoriesStored(tenantId: string): void {
    this.memoriesStored.inc({ tenant_id: tenantId });
  }
  incMemoriesDeleted(tenantId: string, count: number): void {
    this.memoriesDeleted.inc({ tenant_id: tenantId }, count);
  }
  incErrors(tenantId: string, operation: string): void {
    this.errors.inc({ tenant_id: tenantId, operation });
  }
  setActiveConnections(count: number): void {
    this.activeConnections.set(count);
  }
  async getMetricsText(): Promise<string> {
    return this.registry.metrics();
  }
  getContentType(): string {
    return this.registry.contentType;
  }
}

class NoopMetrics implements Metrics {
  incHttpRequests(): void {}
  observeHttpDuration(): void {}
  observeSearchDuration(): void {}
  observeEmbeddingDuration(): void {}
  incMemoriesStored(): void {}
  incMemoriesDeleted(): void {}
  incErrors(): void {}
  setActiveConnections(): void {}
  async getMetricsText(): Promise<string> { return '# Metrics disabled\n'; }
  getContentType(): string { return 'text/plain'; }
}

export async function createMetrics(config: EnterpriseConfig, logger: Logger): Promise<Metrics> {
  if (!config.monitoring.enabled) {
    return new NoopMetrics();
  }
  try {
    const client = await import('prom-client');
    logger.info('Prometheus metrics initialized');
    return new PromClientMetrics(client);
  } catch {
    logger.warn('prom-client not available, metrics disabled');
    return new NoopMetrics();
  }
}
