import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from '../types.js';

const MAX_CACHE_SIZE = 1024;

/**
 * Cache key over the FULL text. A prior `text.slice(0, 500)` key collided any
 * two texts sharing a 500-char prefix and returned the wrong cached vector
 * (BATTLE-PLAN #1). A SHA-256 digest is fixed-size and effectively
 * collision-free across the full content.
 */
function cacheKey(text: string): string {
  return createHash('sha256').update(text).digest('base64');
}

export class CachedEmbeddingProvider implements EmbeddingProvider {
  private readonly inner: EmbeddingProvider;
  private readonly cache = new Map<string, Float32Array>();

  constructor(inner: EmbeddingProvider) {
    this.inner = inner;
  }

  get dimensions(): number {
    return this.inner.dimensions;
  }

  get modelName(): string {
    return this.inner.modelName;
  }

  initialize(): Promise<void> {
    return this.inner.initialize();
  }

  isReady(): boolean {
    return this.inner.isReady();
  }

  async embed(text: string): Promise<Float32Array> {
    const key = cacheKey(text);

    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const result = await this.inner.embed(text);
    this.evictIfNeeded();
    this.cache.set(key, result);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const keys = texts.map((t) => cacheKey(t));
    const results = new Array<Float32Array | null>(texts.length).fill(null);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(keys[i]);
      if (cached) {
        this.cache.delete(keys[i]);
        this.cache.set(keys[i], cached);
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    if (uncachedTexts.length > 0) {
      const embeddings = await this.inner.embedBatch(uncachedTexts);
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        results[idx] = embeddings[j];
        this.evictIfNeeded();
        this.cache.set(keys[idx], embeddings[j]);
      }
    }

    return results as Float32Array[];
  }

  private evictIfNeeded(): void {
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
  }
}
