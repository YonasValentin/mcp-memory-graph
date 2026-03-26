// ── Enterprise Configuration ──────────────────────────────────────────────

export interface EnterpriseConfig {
  // Server
  port: number;
  host: string;
  mode: 'mcp' | 'http' | 'dual';

  // Database
  database: {
    provider: 'sqlite' | 'postgres';
    // SQLite
    sqlitePath?: string;
    // PostgreSQL
    postgresUrl?: string;
    postgresPoolMin?: number;
    postgresPoolMax?: number;
  };

  // Embeddings
  embeddings: {
    provider: 'transformers' | 'openai' | 'remote';
    // Transformers (local)
    modelName?: string;
    dimensions?: number;
    // OpenAI
    openaiApiKey?: string;
    openaiModel?: string;
    // Remote
    remoteEndpoint?: string;
  };

  // Auth
  auth: {
    enabled: boolean;
    jwtSecret: string;
    issuer: string;
    audience: string;
    tokenExpiryHours: number;
  };

  // Redis
  redis: {
    enabled: boolean;
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    embeddingCacheTtl: number;
    searchCacheTtl: number;
  };

  // Rate limiting
  rateLimit: {
    enabled: boolean;
    maxPerMinute: number;
    maxPerMinutePro: number;
    maxPerMinuteEnterprise: number;
  };

  // Logging
  logging: {
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    prettyPrint: boolean;
  };

  // Monitoring
  monitoring: {
    enabled: boolean;
    metricsPort?: number;
  };
}

export function loadConfig(): EnterpriseConfig {
  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    host: process.env.HOST ?? '0.0.0.0',
    mode: (process.env.SERVER_MODE as EnterpriseConfig['mode']) ?? 'dual',

    database: {
      provider: (process.env.DB_PROVIDER as 'sqlite' | 'postgres') ?? 'sqlite',
      sqlitePath: process.env.MCP_MEMORY_DB_PATH,
      postgresUrl: process.env.DATABASE_URL,
      postgresPoolMin: parseInt(process.env.PG_POOL_MIN ?? '2', 10),
      postgresPoolMax: parseInt(process.env.PG_POOL_MAX ?? '20', 10),
    },

    embeddings: {
      provider: (process.env.EMBEDDING_PROVIDER as 'transformers' | 'openai' | 'remote') ?? 'transformers',
      modelName: process.env.MCP_MEMORY_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
      dimensions: parseInt(process.env.MCP_MEMORY_DIMENSIONS ?? '384', 10),
      openaiApiKey: process.env.OPENAI_API_KEY,
      openaiModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      remoteEndpoint: process.env.EMBEDDING_ENDPOINT,
    },

    auth: {
      enabled: process.env.AUTH_ENABLED === 'true',
      jwtSecret: process.env.JWT_SECRET ?? '',
      issuer: process.env.JWT_ISSUER ?? 'puregate-knowledge',
      audience: process.env.JWT_AUDIENCE ?? 'puregate-api',
      tokenExpiryHours: parseInt(process.env.TOKEN_EXPIRY_HOURS ?? '24', 10),
    },

    redis: {
      enabled: process.env.REDIS_ENABLED === 'true',
      url: process.env.REDIS_URL,
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      password: process.env.REDIS_PASSWORD,
      embeddingCacheTtl: parseInt(process.env.EMBEDDING_CACHE_TTL ?? '86400', 10),
      searchCacheTtl: parseInt(process.env.SEARCH_CACHE_TTL ?? '300', 10),
    },

    rateLimit: {
      enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
      maxPerMinute: parseInt(process.env.RATE_LIMIT_MAX ?? '100', 10),
      maxPerMinutePro: parseInt(process.env.RATE_LIMIT_PRO ?? '1000', 10),
      maxPerMinuteEnterprise: parseInt(process.env.RATE_LIMIT_ENTERPRISE ?? '5000', 10),
    },

    logging: {
      level: (process.env.LOG_LEVEL as EnterpriseConfig['logging']['level']) ?? 'info',
      prettyPrint: process.env.LOG_PRETTY === 'true',
    },

    monitoring: {
      enabled: process.env.METRICS_ENABLED === 'true',
      metricsPort: process.env.METRICS_PORT ? parseInt(process.env.METRICS_PORT, 10) : undefined,
    },
  };
}
