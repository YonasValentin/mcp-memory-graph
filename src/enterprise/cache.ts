// ── Redis Caching Layer ───────────────────────────────────────────────────

import type { EnterpriseConfig } from './config.js';
import type { Logger } from './logger.js';
import crypto from 'node:crypto';

export interface CacheService {
  getEmbedding(text: string): Promise<Float32Array | null>;
  setEmbedding(text: string, embedding: Float32Array): Promise<void>;
  getSearchResult(key: string): Promise<string | null>;
  setSearchResult(key: string, data: string): Promise<void>;
  invalidateSearchCache(tenantId: string): Promise<void>;
  close(): Promise<void>;
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

class RedisCacheService implements CacheService {
  private redis: any;
  private embTtl: number;
  private searchTtl: number;

  constructor(redis: any, config: EnterpriseConfig['redis']) {
    this.redis = redis;
    this.embTtl = config.embeddingCacheTtl;
    this.searchTtl = config.searchCacheTtl;
  }

  async getEmbedding(text: string): Promise<Float32Array | null> {
    const key = `emb:${hashText(text)}`;
    const buf = await this.redis.getBuffer(key);
    if (!buf) return null;
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }

  async setEmbedding(text: string, embedding: Float32Array): Promise<void> {
    const key = `emb:${hashText(text)}`;
    await this.redis.setex(key, this.embTtl, Buffer.from(embedding.buffer));
  }

  async getSearchResult(key: string): Promise<string | null> {
    return this.redis.get(`search:${key}`);
  }

  async setSearchResult(key: string, data: string): Promise<void> {
    await this.redis.setex(`search:${key}`, this.searchTtl, data);
  }

  async invalidateSearchCache(tenantId: string): Promise<void> {
    const keys = await this.redis.keys(`search:${tenantId}:*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

class InMemoryCacheService implements CacheService {
  private embeddings = new Map<string, { data: Float32Array; expires: number }>();
  private searches = new Map<string, { data: string; expires: number }>();
  private embTtl: number;
  private searchTtl: number;

  constructor(config: EnterpriseConfig['redis']) {
    this.embTtl = config.embeddingCacheTtl * 1000;
    this.searchTtl = config.searchCacheTtl * 1000;
  }

  async getEmbedding(text: string): Promise<Float32Array | null> {
    const key = hashText(text);
    const entry = this.embeddings.get(key);
    if (!entry || Date.now() > entry.expires) {
      if (entry) this.embeddings.delete(key);
      return null;
    }
    return entry.data;
  }

  async setEmbedding(text: string, embedding: Float32Array): Promise<void> {
    const key = hashText(text);
    this.embeddings.set(key, { data: embedding, expires: Date.now() + this.embTtl });
    // Evict if too large
    if (this.embeddings.size > 10000) {
      const first = this.embeddings.keys().next().value;
      if (first !== undefined) this.embeddings.delete(first);
    }
  }

  async getSearchResult(key: string): Promise<string | null> {
    const entry = this.searches.get(key);
    if (!entry || Date.now() > entry.expires) {
      if (entry) this.searches.delete(key);
      return null;
    }
    return entry.data;
  }

  async setSearchResult(key: string, data: string): Promise<void> {
    this.searches.set(key, { data, expires: Date.now() + this.searchTtl });
    if (this.searches.size > 5000) {
      const first = this.searches.keys().next().value;
      if (first !== undefined) this.searches.delete(first);
    }
  }

  async invalidateSearchCache(tenantId: string): Promise<void> {
    for (const key of this.searches.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.searches.delete(key);
      }
    }
  }

  async close(): Promise<void> {
    this.embeddings.clear();
    this.searches.clear();
  }
}

export async function createCacheService(
  config: EnterpriseConfig,
  logger: Logger,
): Promise<CacheService> {
  if (config.redis.enabled) {
    try {
      const ioredis = await import('ioredis');
      const RedisConstructor = ioredis.default ?? ioredis;
      const redis = config.redis.url
        ? new (RedisConstructor as any)(config.redis.url)
        : new (RedisConstructor as any)({
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password,
          });
      logger.info('Redis cache connected');
      return new RedisCacheService(redis, config.redis);
    } catch (err) {
      logger.warn('Redis not available, falling back to in-memory cache', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  logger.info('Using in-memory cache');
  return new InMemoryCacheService(config.redis);
}
