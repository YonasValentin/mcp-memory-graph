/**
 * Concurrency — lazy model init must be promise-deduped.
 *
 * The pre-fix pattern (`if (this.ready) return; ...await load...; ready = true`)
 * let N concurrent first calls each observe ready=false and launch N parallel
 * ~250MB ONNX model loads in ONE process — observed as intermittent
 * "Failed to load ... model" store failures under cold-start parallel load and
 * a deterministic native abort at shutdown (`libc++abi: ... mutex lock failed`)
 * after a multi-load race. These tests pin the contract: concurrent first calls
 * share ONE in-flight load; a failed load rejects every concurrent waiter but is
 * NOT cached — a later call retries (a transient disk/network error must not
 * brick the load-bearing embedder for the rest of the process).
 *
 * The private loadModel loader is replaced via the same private-state injection
 * pattern as dispose.test.ts, so no model is ever downloaded — we only count
 * loader invocations. (A vi.mock of @huggingface/transformers is NOT usable
 * here: concurrent dynamic imports of a factory-mocked module are racy in
 * vitest — some concurrent importers receive the REAL module and hit the
 * network, polluting the very experiment.)
 */
import { describe, it, expect } from 'vitest';
import { TransformersEmbeddingProvider } from '../../embeddings/transformers.js';

/** Shape of the private loader slot the tests inject into. */
type LoaderSlot = { loadModel: (this: { ready: boolean }) => Promise<void> };

describe('TransformersEmbeddingProvider.initialize() concurrency dedup', () => {
  it('shares ONE in-flight model load across 10 concurrent first calls', async () => {
    const provider = new TransformersEmbeddingProvider('stub-model', 4);
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (provider as unknown as LoaderSlot).loadModel = async function (this: { ready: boolean }) {
      loads++;
      await gate; // hold the load open so all 10 callers overlap in flight
      this.ready = true;
    };

    const firstCalls = Array.from({ length: 10 }, () => provider.initialize());
    release();
    await Promise.all(firstCalls);

    expect(loads).toBe(1);
    expect(provider.isReady()).toBe(true);

    // After a successful load, later calls short-circuit — no reload.
    await provider.initialize();
    expect(loads).toBe(1);
  });

  it('rejects every concurrent waiter on a failed load, then RETRIES on the next call', async () => {
    const provider = new TransformersEmbeddingProvider('stub-model', 4);
    let loads = 0;
    (provider as unknown as LoaderSlot).loadModel = async function (this: { ready: boolean }) {
      loads++;
      if (loads === 1) throw new Error('ECONNRESET: transient download failure');
      this.ready = true;
    };

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => provider.initialize()),
    );

    // All 10 waiters share the SINGLE failed load's rejection.
    for (const result of results) {
      expect(result.status).toBe('rejected');
    }
    expect((results[0] as PromiseRejectedResult).reason.message).toContain(
      'transient download failure',
    );
    expect(loads).toBe(1);
    expect(provider.isReady()).toBe(false);

    // The rejection must not be cached forever — a later call retries the load.
    await expect(provider.initialize()).resolves.toBeUndefined();
    expect(loads).toBe(2);
    expect(provider.isReady()).toBe(true);
  });
});
