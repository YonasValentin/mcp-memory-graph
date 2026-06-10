/**
 * Concurrency — CrossEncoderNli lazy model init must be promise-deduped.
 *
 * The pre-fix pattern (`if (this.ready) return; ...await load...; ready = true`)
 * let N concurrent first classify() calls each observe ready=false and launch N
 * parallel ~250MB ONNX model loads in ONE process — observed as intermittent
 * "Failed to load NLI model" store failures under cold-start parallel load and
 * a native `mutex lock failed` abort at shutdown after a multi-load race. These
 * tests pin the contract: concurrent first calls share ONE in-flight load; a
 * failed load rejects every concurrent waiter but is NOT cached — a later call
 * retries.
 *
 * The private loadModel loader is replaced via the same private-state injection
 * pattern as dispose.test.ts, so no model is ever downloaded — we only count
 * loader invocations. (Mirrors embeddings/init-dedup.test.ts and
 * search/reranker-init-dedup.test.ts; a vi.mock of @huggingface/transformers is
 * NOT usable here because concurrent dynamic imports of a factory-mocked module
 * are racy in vitest — some concurrent importers receive the REAL module.)
 */
import { describe, it, expect } from 'vitest';
import { CrossEncoderNli } from '../../graph/contradiction.js';

/** Shape of the private state the tests inject into. */
type NliInternals = { tokenizer: unknown; model: unknown; ready: boolean };
type LoaderSlot = { loadModel: (this: NliInternals) => Promise<void> };

/** Installs fake tokenizer/model whose 3-way logits argmax (index 1) maps to
 *  'entailment' via id2label — classify() then works without any real model. */
function loadFakeNliModel(target: NliInternals): void {
  target.tokenizer = async () => ({});
  target.model = Object.assign(
    async () => ({ logits: { data: new Float32Array([0, 6, 0]) } }),
    { config: { id2label: { '0': 'contradiction', '1': 'entailment', '2': 'neutral' } } },
  );
  target.ready = true;
}

describe('CrossEncoderNli lazy-init concurrency dedup', () => {
  it('shares ONE in-flight model load across 10 concurrent first classify() calls', async () => {
    const nli = new CrossEncoderNli('stub-nli');
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (nli as unknown as LoaderSlot).loadModel = async function (this: NliInternals) {
      loads++;
      await gate; // hold the load open so all 10 callers overlap in flight
      loadFakeNliModel(this);
    };

    const calls = Array.from({ length: 10 }, () => nli.classify('premise', 'hypothesis'));
    release();
    const results = await Promise.all(calls);

    expect(loads).toBe(1);
    expect(nli.isReady()).toBe(true);
    for (const result of results) {
      expect(result.label).toBe('entailment');
    }
  });

  it('rejects every concurrent waiter on a failed load, then RETRIES on the next call', async () => {
    const nli = new CrossEncoderNli('stub-nli');
    let loads = 0;
    (nli as unknown as LoaderSlot).loadModel = async function (this: NliInternals) {
      loads++;
      if (loads === 1) throw new Error('ECONNRESET: transient download failure');
      loadFakeNliModel(this);
    };

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => nli.classify('premise', 'hypothesis')),
    );

    // All 10 waiters share the SINGLE failed load's rejection.
    for (const result of results) {
      expect(result.status).toBe('rejected');
    }
    expect((results[0] as PromiseRejectedResult).reason.message).toContain(
      'transient download failure',
    );
    expect(loads).toBe(1);
    expect(nli.isReady()).toBe(false);

    // The rejection must not be cached forever — a later call retries the load.
    const retried = await nli.classify('premise', 'hypothesis');
    expect(retried.label).toBe('entailment');
    expect(loads).toBe(2);
    expect(nli.isReady()).toBe(true);
  });
});
