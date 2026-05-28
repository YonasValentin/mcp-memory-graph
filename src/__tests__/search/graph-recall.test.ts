import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { hybridSearch } from '../../search/hybrid.js';

/**
 * Pillar 3, T5 — HippoRAG Personalized PageRank fused into hybrid search.
 *
 * The setup builds a real entity graph through the normal store path:
 *   M1 mentions ReactService + DockerService → both entities created and a
 *       `co_occurs` edge materialized between them (Pillar 1).
 *   M2 mentions ONLY DockerService → DockerService links to M2.
 *   M3 is unrelated.
 *
 * With use_graph=false, a keyword search for "ReactService" finds only M1.
 * With use_graph=true, PPR seeded from ReactService flows mass
 * ReactService → DockerService → M2, so M2 also surfaces (multi-hop recall).
 *
 * Keyword mode isolates the graph effect: vector search is skipped, so only
 * FTS + PPR contribute and M2 cannot sneak in as a coincidental vector hit.
 */
describe('graph-aware recall: PPR as a third ranker (Pillar 3, T5)', () => {
  async function seedGraph(db: ReturnType<typeof createTestDb>, embedder: MockEmbeddingProvider) {
    // M1: two PascalCase+Service entities the regex extractor recognizes.
    const m1 = await handleStore(db, embedder, {
      content: 'ReactService and DockerService were integrated.',
    });
    // M2: ONLY DockerService — no "ReactService" token, so it is NOT a lexical
    // match for a "ReactService" query.
    const m2 = await handleStore(db, embedder, {
      content: 'DockerService deployment notes.',
    });
    // M3: unrelated.
    const m3 = await handleStore(db, embedder, {
      content: 'PaymentService billing logic.',
    });
    return { m1: m1.memory.id, m2: m2.memory.id, m3: m3.memory.id };
  }

  it('use_graph=false: keyword query returns M1 but not M2', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const { m1, m2 } = await seedGraph(db, embedder);

    const { results } = await hybridSearch(db, embedder, {
      query: 'ReactService',
      search_mode: 'keyword',
      limit: 10,
      offset: 0,
      use_graph: false,
    });

    const ids = results.map((r) => r.memory.id);
    expect(ids).toContain(m1);
    expect(ids).not.toContain(m2);
  });

  it('use_graph=true: query reaches M2 via ReactService→DockerService→M2 (multi-hop)', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const { m1, m2 } = await seedGraph(db, embedder);

    const { results } = await hybridSearch(db, embedder, {
      query: 'ReactService',
      search_mode: 'keyword',
      limit: 10,
      offset: 0,
      use_graph: true,
    });

    const ids = results.map((r) => r.memory.id);
    expect(ids).toContain(m1); // still a direct lexical match
    expect(ids).toContain(m2); // reached only through the entity graph
  });

  it('use_graph=true with a query linking to no entities behaves like a normal search', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    await seedGraph(db, embedder);

    // 'zzzznotanentity' matches no entity and no memory content — must not throw
    // and must return no lexical results (graph contributes nothing either).
    const { results } = await hybridSearch(db, embedder, {
      query: 'zzzznotanentity',
      search_mode: 'keyword',
      limit: 10,
      offset: 0,
      use_graph: true,
    });

    expect(results).toEqual([]);
  });
});
