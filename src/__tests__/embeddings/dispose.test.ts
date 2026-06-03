/**
 * BATTLE-V3 P14: the real embedder (transformers.js / onnxruntime) aborts with
 * `std::system_error: mutex lock failed` (exit 134) when the process is hard-
 * exited via `process.exit()` while its native worker is alive — so every
 * in-process real-embedder verify/battle script returned 134 regardless of
 * pass/fail, MASKING real failures.
 *
 * The release hook for graceful shutdown is `dispose()` on the providers plus
 * `disposeEmbedder()` on the process singleton. (The actual 134 fix is script
 * discipline — natural event-loop drain instead of `process.exit()` — verified
 * by the script-level repro, not here.) These tests pin the dispose contract:
 * idempotent, nulls the pipeline, safe when the model never loaded, and the
 * cache wrapper drops its cache + delegates to the inner provider.
 */
import { describe, it, expect } from 'vitest';
import type { EmbeddingProvider } from '../../embeddings/provider.js';
import { CachedEmbeddingProvider } from '../../embeddings/cache.js';
import { TransformersEmbeddingProvider } from '../../embeddings/transformers.js';

/** Inner provider that records embed/dispose calls without touching native code. */
class SpyEmbedder implements EmbeddingProvider {
  dimensions = 4;
  modelName = 'spy';
  embedCalls = 0;
  disposeCalls = 0;
  async initialize(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  async embed(text: string): Promise<Float32Array> {
    this.embedCalls++;
    const v = new Float32Array(4);
    v[0] = text.length;
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
  async dispose(): Promise<void> {
    this.disposeCalls++;
  }
}

describe('TransformersEmbeddingProvider.dispose() (P14)', () => {
  it('is safe and idempotent when the model was never loaded', async () => {
    const p = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2', 384);
    expect(p.isReady()).toBe(false);
    await expect(p.dispose()).resolves.toBeUndefined();
    await expect(p.dispose()).resolves.toBeUndefined();
    expect(p.isReady()).toBe(false);
  });

  it('disposes the cached pipeline, un-readies, and is idempotent', async () => {
    const p = new TransformersEmbeddingProvider('Xenova/all-MiniLM-L6-v2', 384);
    let disposed = 0;
    // Stand in for a loaded transformers.js pipeline (which exposes dispose()).
    const fakePipeline = async () => ({ data: new Float32Array(384) });
    (fakePipeline as { dispose?: () => Promise<void> }).dispose = async () => {
      disposed++;
    };
    // Inject the loaded state without hitting the network/native runtime.
    (p as unknown as { pipeline: unknown; ready: boolean }).pipeline = fakePipeline;
    (p as unknown as { pipeline: unknown; ready: boolean }).ready = true;
    expect(p.isReady()).toBe(true);

    await p.dispose();
    expect(disposed).toBe(1);
    expect(p.isReady()).toBe(false);
    expect((p as unknown as { pipeline: unknown }).pipeline).toBeNull();

    // Second call is a no-op (pipeline already null) and must not throw.
    await expect(p.dispose()).resolves.toBeUndefined();
    expect(disposed).toBe(1);
  });
});

describe('CachedEmbeddingProvider.dispose() (P14)', () => {
  it('clears the cache and delegates to the inner provider', async () => {
    const inner = new SpyEmbedder();
    const cache = new CachedEmbeddingProvider(inner);

    // Warm the cache so the same text is served without re-embedding.
    await cache.embed('alpha');
    await cache.embed('alpha');
    expect(inner.embedCalls).toBe(1);

    await cache.dispose();
    expect(inner.disposeCalls).toBe(1);

    // After dispose the cache is empty, so a repeat re-embeds via the inner.
    await cache.embed('alpha');
    expect(inner.embedCalls).toBe(2);
  });

  it('is safe when the inner provider has no dispose()', async () => {
    const inner: EmbeddingProvider = {
      dimensions: 4,
      modelName: 'no-dispose',
      async initialize() {},
      isReady: () => true,
      async embed() {
        return new Float32Array(4);
      },
      async embedBatch(texts) {
        return texts.map(() => new Float32Array(4));
      },
    };
    const cache = new CachedEmbeddingProvider(inner);
    await cache.embed('x');
    await expect(cache.dispose()).resolves.toBeUndefined();
  });
});

describe('disposeEmbedder() singleton (P14)', () => {
  it('is a no-op when no embedder was ever constructed', async () => {
    // Fresh import: getEmbedder has not been called in this isolated module,
    // so disposeEmbedder must resolve without loading or releasing anything.
    const { disposeEmbedder } = await import('../../lib/direct-access.js');
    await expect(disposeEmbedder()).resolves.toBeUndefined();
    // Idempotent.
    await expect(disposeEmbedder()).resolves.toBeUndefined();
  });
});
