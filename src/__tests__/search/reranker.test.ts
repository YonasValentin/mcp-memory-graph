import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { hybridSearch } from '../../search/hybrid.js';
import { CrossEncoderReranker, type Reranker } from '../../search/reranker.js';

/**
 * Pillar 3, T6 — optional local cross-encoder reranking stage.
 *
 * The reranker reorders the top-N hybrid-search candidates by a (query, doc)
 * relevance score. In production this is a real cross-encoder
 * (Xenova/ms-marco-MiniLM-L-6-v2); here we inject a DETERMINISTIC stub so the
 * suite never downloads a model — we only assert that hybridSearch honors the
 * reranker's order (or falls back gracefully on error / when disabled).
 *
 * Seed: three memories that all share the token "deploy" so a keyword search
 * surfaces all three as candidates. The stub then ranks one of them highest
 * via a fixed rule and we assert it floats to the top only when rerank=true.
 */

/** Ranks docs by presence of a target token in their text (desc), so the test
 *  knows exactly which id the reranker considers most relevant. */
class StubReranker implements Reranker {
  constructor(private readonly target: string) {}
  async rerank(_query: string, docs: { id: string; text: string }[]) {
    return docs.map((d) => ({
      id: d.id,
      score: d.text.includes(this.target) ? 1 : 0,
    }));
  }
}

/** A reranker that always throws — exercises the graceful-fallback path. */
class ThrowingReranker implements Reranker {
  async rerank(): Promise<Array<{ id: string; score: number }>> {
    throw new Error('model exploded');
  }
}

async function seed(db: ReturnType<typeof createTestDb>, embedder: MockEmbeddingProvider) {
  const a = await handleStore(db, embedder, { content: 'deploy alpha service notes' });
  const b = await handleStore(db, embedder, { content: 'deploy beta service notes' });
  const c = await handleStore(db, embedder, { content: 'deploy gamma TARGETTOKEN notes' });
  return { a: a.memory.id, b: b.memory.id, c: c.memory.id };
}

describe('cross-encoder reranking stage (Pillar 3, T6)', () => {
  it('without a reranker, hybridSearch order is the deterministic baseline', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const { a, b, c } = await seed(db, embedder);

    const { results } = await hybridSearch(db, embedder, {
      query: 'deploy',
      search_mode: 'keyword',
      limit: 10,
      offset: 0,
    });

    const ids = results.map((r) => r.memory.id);
    expect(ids.sort()).toEqual([a, b, c].sort()); // all three are candidates
    // Capture the exact baseline ordering for the comparison below.
    expect(ids.length).toBe(3);
  });

  it('rerank=false (with a reranker passed) leaves the baseline order untouched', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    await seed(db, embedder);

    const baseline = await hybridSearch(db, embedder, {
      query: 'deploy',
      search_mode: 'keyword',
      limit: 10,
      offset: 0,
    });

    const withStubDisabled = await hybridSearch(
      db,
      embedder,
      { query: 'deploy', search_mode: 'keyword', limit: 10, offset: 0, rerank: false },
      new StubReranker('TARGETTOKEN'),
    );

    expect(withStubDisabled.results.map((r) => r.memory.id)).toEqual(
      baseline.results.map((r) => r.memory.id),
    );
  });

  it('rerank=true reorders so the stub-favored doc comes first', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const { c } = await seed(db, embedder);

    const { results } = await hybridSearch(
      db,
      embedder,
      { query: 'deploy', search_mode: 'keyword', limit: 10, offset: 0, rerank: true },
      new StubReranker('TARGETTOKEN'),
    );

    expect(results[0].memory.id).toBe(c); // the only doc containing TARGETTOKEN
  });

  it('a reranker that throws falls back to the baseline order (never fails the search)', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    await seed(db, embedder);

    const baseline = await hybridSearch(db, embedder, {
      query: 'deploy',
      search_mode: 'keyword',
      limit: 10,
      offset: 0,
    });
    expect(baseline.results.length).toBeGreaterThan(0); // sanity: candidates exist

    // The reranker throws; hybridSearch must swallow it (logging via logger.warn
    // to stderr) and fall back to the fused baseline order — never fail.
    const { results } = await hybridSearch(
      db,
      embedder,
      { query: 'deploy', search_mode: 'keyword', limit: 10, offset: 0, rerank: true },
      new ThrowingReranker(),
    );

    expect(results.map((r) => r.memory.id)).toEqual(
      baseline.results.map((r) => r.memory.id),
    );
  });

  it('CrossEncoderReranker constructs without loading a model', () => {
    // Construction must be cheap & hermetic — it MUST NOT trigger a download.
    const reranker = new CrossEncoderReranker();
    expect(reranker).toBeInstanceOf(CrossEncoderReranker);
    expect(typeof reranker.rerank).toBe('function');
  });
});
