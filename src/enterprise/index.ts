// ── Enterprise Bootstrap ──────────────────────────────────────────────────
//
// Initializes and wires together all enterprise components.

import { loadConfig, type EnterpriseConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { createMetrics, type Metrics } from './metrics.js';
import { createAuthService, type AuthService } from './auth.js';
import { createCacheService, type CacheService } from './cache.js';
import { createEmbeddingProvider } from './embeddings.js';
import { SqliteStorageBackend } from './storage-sqlite.js';
import { PostgresStorageBackend } from './storage-postgres.js';
import type { StorageBackend } from './storage.js';
import type { EmbeddingProvider } from '../types.js';

export interface EnterpriseServices {
  config: EnterpriseConfig;
  logger: Logger;
  metrics: Metrics;
  authService: AuthService;
  cache: CacheService;
  embedder: EmbeddingProvider;
  storage: StorageBackend;
}

export async function bootstrapEnterprise(): Promise<EnterpriseServices> {
  const config = loadConfig();
  const logger = await createLogger(config);
  const metrics = await createMetrics(config, logger);

  logger.info('Bootstrapping PureGate Knowledge enterprise services', {
    mode: config.mode,
    dbProvider: config.database.provider,
    embeddingProvider: config.embeddings.provider,
    authEnabled: config.auth.enabled,
    redisEnabled: config.redis.enabled,
    metricsEnabled: config.monitoring.enabled,
  });

  // Auth
  const authService = createAuthService(config);

  // Cache
  const cache = await createCacheService(config, logger);

  // Storage backend
  let storage: StorageBackend;
  if (config.database.provider === 'postgres' && config.database.postgresUrl) {
    storage = new PostgresStorageBackend(
      config.database.postgresUrl,
      config.database.postgresPoolMin,
      config.database.postgresPoolMax,
    );
    logger.info('Using PostgreSQL + pgvector storage backend');
  } else {
    storage = new SqliteStorageBackend(config.database.sqlitePath);
    logger.info('Using SQLite storage backend');
  }
  await storage.initialize();

  // Embeddings (with caching)
  const embedder = await createEmbeddingProvider(config, cache, metrics, logger);

  logger.info('Enterprise services initialized successfully');

  return { config, logger, metrics, authService, cache, embedder, storage };
}

export async function shutdownEnterprise(services: EnterpriseServices): Promise<void> {
  services.logger.info('Shutting down enterprise services');
  await services.storage.close();
  await services.cache.close();
}

// Re-export everything
export { loadConfig } from './config.js';
export type { EnterpriseConfig } from './config.js';
export type { Logger } from './logger.js';
export type { Metrics } from './metrics.js';
export type { AuthService } from './auth.js';
export type { CacheService } from './cache.js';
export type { StorageBackend, DeleteFilter } from './storage.js';
export type { TenantContext, TenantPlan, UserRole, Tenant, TenantUser } from './tenant.js';
export { hasPermission, requirePermission } from './tenant.js';
