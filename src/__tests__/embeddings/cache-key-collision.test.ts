/**
 * Regression for BATTLE-PLAN #1: CachedEmbeddingProvider keyed on
 * `text.slice(0, 500)`, so two distinct texts sharing a >=500-char prefix
 * collided and the second returned the FIRST text's vector — silent corpus
 * corruption on the live store/search/dedup path. The key must cover the full
 * text while still caching exact repeats.
 */
import { describe, it, expect } from 'vitest';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';

/** Inner provider whose vector depends on the FULL text (sum of char codes). */
class SumEmbedder implements EmbeddingProvider {
  dimensions = 8;
  modelName = 'sum-stub';
  calls = 0;
  async initialize(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  async embed(text: string): Promise<Float32Array> {
    this.calls++;
    let s = 0;
    for (let i = 0; i < text.length; i++) s += text.charCodeAt(i);
    const v = new Float32Array(8);
    v[0] = s;
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

const PREFIX = 'x'.repeat(500);

describe('CachedEmbeddingProvider full-text keying', () => {
  it('does not collide texts sharing a 500-char prefix (embed)', async () => {
    const inner = new SumEmbedder();
    const cache = new CachedEmbeddingProvider(inner);
    const a = await cache.embed(PREFIX + 'AAA');
    const b = await cache.embed(PREFIX + 'BBB');
    const rawB = await new SumEmbedder().embed(PREFIX + 'BBB');
    expect(Array.from(b)).toEqual(Array.from(rawB));
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('does not collide texts sharing a 500-char prefix (embedBatch)', async () => {
    const inner = new SumEmbedder();
    const cache = new CachedEmbeddingProvider(inner);
    const [a, b] = await cache.embedBatch([PREFIX + 'AAA', PREFIX + 'BBB']);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('still caches exact repeats (inner called once)', async () => {
    const inner = new SumEmbedder();
    const cache = new CachedEmbeddingProvider(inner);
    await cache.embed(PREFIX + 'SAME');
    await cache.embed(PREFIX + 'SAME');
    expect(inner.calls).toBe(1);
  });
});
