/**
 * Concurrency — CrossEncoderReranker lazy model init must be promise-deduped.
 *
 * The pre-fix pattern (`if (this.ready) return; ...await load...; ready = true`)
 * let N concurrent first rerank() calls each observe ready=false and launch N
 * parallel ~250MB ONNX model loads in ONE process — observed as intermittent
 * "Failed to load ... model" failures under cold-start parallel load and a
 * native `mutex lock failed` abort at shutdown after a multi-load race. These
 * tests pin the contract: concurrent first calls share ONE in-flight load; a
 * failed load rejects every concurrent waiter but is NOT cached — a later call
 * retries.
 *
 * The private loadModel loader is replaced via the same private-state injection
 * pattern as dispose.test.ts, so no model is ever downloaded — we only count
 * loader invocations. (Mirrors embeddings/init-dedup.test.ts and
 * graph/nli-init-dedup.test.ts; a vi.mock of @huggingface/transformers is NOT
 * usable here because concurrent dynamic imports of a factory-mocked module are
 * racy in vitest — some concurrent importers receive the REAL module.)
 */
import { describe, it, expect } from 'vitest';
import { CrossEncoderReranker } from '../../search/reranker.js';

/** Shape of the private state the tests inject into. */
type RerankerInternals = { tokenizer: unknown; model: unknown; ready: boolean };
type LoaderSlot = { loadModel: (this: RerankerInternals) => Promise<void> };

/** Installs fake tokenizer/model emitting the single relevance logit that
 *  extractRelevanceScore reads back out — rerank() then works model-free. */
function loadFakeRerankerModel(target: RerankerInternals): void {
  target.tokenizer = async () => ({});
  target.model = async () => ({ logits: { data: new Float32Array([2.5]) } });
  target.ready = true;
}

const DOCS = [{ id: 'doc-1', text: 'deploy notes' }];

describe('CrossEncoderReranker lazy-init concurrency dedup', () => {
  it('shares ONE in-flight model load across 10 concurrent first rerank() calls', async () => {
    const reranker = new CrossEncoderReranker('stub-reranker');
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (reranker as unknown as LoaderSlot).loadModel = async function (this: RerankerInternals) {
      loads++;
      await gate; // hold the load open so all 10 callers overlap in flight
      loadFakeRerankerModel(this);
    };

    const calls = Array.from({ length: 10 }, () => reranker.rerank('query', DOCS));
    release();
    const results = await Promise.all(calls);

    expect(loads).toBe(1);
    expect(reranker.isReady()).toBe(true);
    for (const result of results) {
      expect(result).toEqual([{ id: 'doc-1', score: 2.5 }]);
    }
  });

  it('rejects every concurrent waiter on a failed load, then RETRIES on the next call', async () => {
    const reranker = new CrossEncoderReranker('stub-reranker');
    let loads = 0;
    (reranker as unknown as LoaderSlot).loadModel = async function (this: RerankerInternals) {
      loads++;
      if (loads === 1) throw new Error('ECONNRESET: transient download failure');
      loadFakeRerankerModel(this);
    };

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => reranker.rerank('query', DOCS)),
    );

    // All 10 waiters share the SINGLE failed load's rejection.
    for (const result of results) {
      expect(result.status).toBe('rejected');
    }
    expect((results[0] as PromiseRejectedResult).reason.message).toContain(
      'transient download failure',
    );
    expect(loads).toBe(1);
    expect(reranker.isReady()).toBe(false);

    // The rejection must not be cached forever — a later call retries the load.
    await expect(reranker.rerank('query', DOCS)).resolves.toEqual([{ id: 'doc-1', score: 2.5 }]);
    expect(loads).toBe(2);
    expect(reranker.isReady()).toBe(true);
  });
});
