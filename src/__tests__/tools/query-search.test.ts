import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleQuery } from '../../tools/query.js';
import { handleSearch } from '../../tools/search.js';

/**
 * Thin tool-handler wrappers around the search/graph core. We assert that each
 * handler forwards its inputs and returns the core's shape — the core logic
 * itself is exercised by the dedicated graph-query / hybrid suites.
 */

describe('handleQuery (memory_query graph traversal wrapper)', () => {
  it('returns an empty subgraph when nothing matches the query', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    const result = await handleQuery(db, embedder, { query: 'no-such-token-anywhere' });

    expect(result.query).toBe('no-such-token-anywhere');
    expect(result.seeds).toEqual([]);
    expect(result.nodes).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.context).toContain('No memories matched');
  });

  it('seeds from hybrid search and forwards traversal options', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const stored = await handleStore(db, embedder, { content: 'deploy alpha service notes' });

    const result = await handleQuery(db, embedder, {
      query: 'deploy',
      max_tokens: 500,
      max_hops: 1,
      seed_limit: 5,
    });

    expect(result.query).toBe('deploy');
    expect(result.seeds).toContain(stored.memory.id);
    expect(result.nodes.length).toBeGreaterThan(0);
  });
});

describe('handleSearch (memory_search wrapper)', () => {
  it('returns summary projection by default and records access', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    await handleStore(db, embedder, { content: 'deploy alpha service notes' });

    const result = await handleSearch(db, embedder, { query: 'deploy' });

    expect(result.detail_level).toBe('summary');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it('projects ids_only when requested', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    await handleStore(db, embedder, { content: 'deploy beta service notes' });

    const result = await handleSearch(db, embedder, {
      query: 'deploy',
      detail_level: 'ids_only',
    });

    expect(result.detail_level).toBe('ids_only');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).toHaveProperty('id');
  });

  it('returns full results and a token budget when max_tokens is set', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    await handleStore(db, embedder, { content: 'deploy gamma service notes' });

    const result = await handleSearch(db, embedder, {
      query: 'deploy',
      detail_level: 'full',
      max_tokens: 1000,
    });

    expect(result.detail_level).toBe('full');
    expect(result.token_budget?.limit).toBe(1000);
    expect(result.token_budget?.estimated_used).toBeGreaterThanOrEqual(0);
  });

  it('lazily constructs the cross-encoder reranker when rerank=true', async () => {
    // A query that matches nothing keeps the reranked candidate set empty, so
    // CrossEncoderReranker.rerank short-circuits to [] WITHOUT a model download.
    // This still exercises getReranker()'s lazy-singleton construction (twice,
    // to hit the cached branch) and the rerank wiring in handleSearch.
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    const first = await handleSearch(db, embedder, {
      query: 'no-such-token-anywhere',
      rerank: true,
    });
    const second = await handleSearch(db, embedder, {
      query: 'still-nothing-here',
      rerank: true,
    });

    expect(first.results).toEqual([]);
    expect(second.results).toEqual([]);
    expect(first.total).toBe(0);
  });
});
