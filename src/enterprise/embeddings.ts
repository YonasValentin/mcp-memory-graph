// ── Pluggable Embedding Providers ──────────────────────────────────────────

import type { EmbeddingProvider } from '../types.js';
import type { EnterpriseConfig } from './config.js';
import type { CacheService } from './cache.js';
import type { Metrics } from './metrics.js';
import type { Logger } from './logger.js';
import { TransformersEmbeddingProvider } from '../embeddings/transformers.js';

// ── OpenAI Embedding Provider ────────────────────────────────────────────

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  private apiKey: string;
  private ready = false;

  constructor(apiKey: string, model: string = 'text-embedding-3-small', dimensions: number = 384) {
    this.apiKey = apiKey;
    this.modelName = model;
    this.dimensions = dimensions;
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required');
    this.ready = true;
  }

  async embed(text: string): Promise<Float32Array> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.modelName,
        input: text,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI embedding failed: ${response.status} ${errorBody}`);
    }

    const data = await response.json() as { data: { embedding: number[] }[] };
    return new Float32Array(data.data[0].embedding);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.modelName,
        input: texts,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI batch embedding failed: ${response.status} ${errorBody}`);
    }

    const data = await response.json() as { data: { embedding: number[]; index: number }[] };
    // Sort by index to maintain order
    data.data.sort((a, b) => a.index - b.index);
    return data.data.map(d => new Float32Array(d.embedding));
  }

  isReady(): boolean {
    return this.ready;
  }
}

// ── Remote Embedding Provider (TEI / vLLM / custom) ──────────────────────

export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  private endpoint: string;
  private ready = false;

  constructor(endpoint: string, modelName: string = 'remote', dimensions: number = 384) {
    this.endpoint = endpoint;
    this.modelName = modelName;
    this.dimensions = dimensions;
  }

  async initialize(): Promise<void> {
    // Verify endpoint is reachable
    try {
      const response = await fetch(`${this.endpoint}/health`);
      if (response.ok) {
        this.ready = true;
        return;
      }
    } catch {
      // Endpoint might not have /health, try anyway
    }
    this.ready = true;
  }

  async embed(text: string): Promise<Float32Array> {
    const response = await fetch(`${this.endpoint}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: text }),
    });

    if (!response.ok) throw new Error(`Remote embedding failed: ${response.status}`);

    const data = await response.json() as number[] | number[][];
    const embedding = Array.isArray(data[0]) ? (data as number[][])[0] : data as number[];
    return new Float32Array(embedding);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const response = await fetch(`${this.endpoint}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: texts }),
    });

    if (!response.ok) throw new Error(`Remote batch embedding failed: ${response.status}`);

    const data = await response.json() as number[][];
    return data.map(d => new Float32Array(d));
  }

  isReady(): boolean {
    return this.ready;
  }
}

// ── Cached Embedding Provider Wrapper ────────────────────────────────────

export class CachedEmbeddingProvider implements EmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  private inner: EmbeddingProvider;
  private cache: CacheService;
  private metrics: Metrics;

  constructor(inner: EmbeddingProvider, cache: CacheService, metrics: Metrics) {
    this.inner = inner;
    this.modelName = inner.modelName;
    this.dimensions = inner.dimensions;
    this.cache = cache;
    this.metrics = metrics;
  }

  async initialize(): Promise<void> {
    await this.inner.initialize();
  }

  async embed(text: string): Promise<Float32Array> {
    const cached = await this.cache.getEmbedding(text);
    if (cached) return cached;

    const start = performance.now();
    const embedding = await this.inner.embed(text);
    this.metrics.observeEmbeddingDuration(this.modelName, (performance.now() - start) / 1000);

    await this.cache.setEmbedding(text, embedding).catch(() => {});
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: (Float32Array | null)[] = await Promise.all(
      texts.map(t => this.cache.getEmbedding(t))
    );

    const uncached: { index: number; text: string }[] = [];
    for (let i = 0; i < results.length; i++) {
      if (!results[i]) uncached.push({ index: i, text: texts[i] });
    }

    if (uncached.length > 0) {
      const start = performance.now();
      const newEmbeddings = await this.inner.embedBatch(uncached.map(u => u.text));
      this.metrics.observeEmbeddingDuration(this.modelName, (performance.now() - start) / 1000);

      for (let i = 0; i < uncached.length; i++) {
        results[uncached[i].index] = newEmbeddings[i];
        await this.cache.setEmbedding(uncached[i].text, newEmbeddings[i]).catch(() => {});
      }
    }

    return results as Float32Array[];
  }

  isReady(): boolean {
    return this.inner.isReady();
  }
}

// ── Factory ──────────────────────────────────────────────────────────────

export async function createEmbeddingProvider(
  config: EnterpriseConfig,
  cache: CacheService,
  metrics: Metrics,
  logger: Logger,
): Promise<EmbeddingProvider> {
  let provider: EmbeddingProvider;

  switch (config.embeddings.provider) {
    case 'openai': {
      if (!config.embeddings.openaiApiKey) {
        throw new Error('OPENAI_API_KEY is required for openai embedding provider');
      }
      provider = new OpenAIEmbeddingProvider(
        config.embeddings.openaiApiKey,
        config.embeddings.openaiModel,
        config.embeddings.dimensions,
      );
      logger.info('Using OpenAI embedding provider', { model: config.embeddings.openaiModel });
      break;
    }
    case 'remote': {
      if (!config.embeddings.remoteEndpoint) {
        throw new Error('EMBEDDING_ENDPOINT is required for remote embedding provider');
      }
      provider = new RemoteEmbeddingProvider(
        config.embeddings.remoteEndpoint,
        config.embeddings.modelName,
        config.embeddings.dimensions,
      );
      logger.info('Using remote embedding provider', { endpoint: config.embeddings.remoteEndpoint });
      break;
    }
    case 'transformers':
    default: {
      provider = new TransformersEmbeddingProvider(
        config.embeddings.modelName,
        config.embeddings.dimensions,
      );
      logger.info('Using local Transformers.js embedding provider', { model: config.embeddings.modelName });
      break;
    }
  }

  await provider.initialize();

  // Wrap with caching
  const cachedProvider = new CachedEmbeddingProvider(provider, cache, metrics);
  return cachedProvider;
}
