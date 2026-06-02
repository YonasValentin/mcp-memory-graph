/**
 * THRUST R2 — 2-hop associative recall (BATTLE-PLAN §3 R2 + §5 competitive
 * parity: "a 2-hop associative query returns the bridging memory via PageRank
 * that pure vector/FTS misses").
 *
 * Built entirely through the real handleStore path with the deterministic
 * MockEmbeddingProvider, so the entity graph is woven by the production
 * side-effects (entity extraction + co-occurrence edges + weaveGraphEdges).
 *
 *   M1: AuthService + TokenService        (entities co-occur → edge)
 *   M2: TokenService + SessionService     (entities co-occur → edge)
 *   M3: SessionService deployment notes    (the BRIDGE — 2 hops from AuthService)
 *   M4: unrelated PaymentService
 *
 * Graph path from a query for "AuthService":
 *   AuthService → TokenService → SessionService → M3
 * M3 shares NO term with the query and is not a near vector neighbour, so a pure
 * keyword/vector search never returns it. PPR (use_graph=true) flows mass two
 * hops along the woven edges and surfaces M3 — the multi-hop "leap".
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { hybridSearch } from '../../search/hybrid.js';

describe('R2 — 2-hop associative recall surfaces a bridge memory vector/FTS miss', () => {
  async function seed(db: ReturnType<typeof createTestDb>, embedder: MockEmbeddingProvider) {
    const m1 = await handleStore(db, embedder, {
      content: 'AuthService and TokenService share a signing key.',
    });
    const m2 = await handleStore(db, embedder, {
      content: 'TokenService and SessionService rotate together.',
    });
    // The BRIDGE: only SessionService — no AuthService/TokenService token.
    const m3 = await handleStore(db, embedder, {
      content: 'SessionService deployment runbook.',
    });
    const m4 = await handleStore(db, embedder, {
      content: 'PaymentService billing reconciliation.',
    });
    return { m1: m1.memory.id, m2: m2.memory.id, m3: m3.memory.id, m4: m4.memory.id };
  }

  it('use_graph=false: keyword query for AuthService never reaches the 2-hop bridge', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const { m1, m3 } = await seed(db, embedder);

    const { results } = await hybridSearch(db, embedder, {
      query: 'AuthService',
      search_mode: 'keyword',
      limit: 10,
      offset: 0,
      use_graph: false,
    });

    const ids = results.map((r) => r.memory.id);
    expect(ids).toContain(m1); // direct lexical hit
    expect(ids).not.toContain(m3); // the bridge is invisible to keyword search
  });

  it('use_graph=true: PPR reaches the bridge two hops out', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const { m1, m3, m4 } = await seed(db, embedder);

    const { results } = await hybridSearch(db, embedder, {
      query: 'AuthService',
      search_mode: 'keyword',
      limit: 10,
      offset: 0,
      use_graph: true,
    });

    const ids = results.map((r) => r.memory.id);
    expect(ids).toContain(m1); // still a direct lexical match
    expect(ids).toContain(m3); // reached only via AuthService→TokenService→SessionService
    expect(ids).not.toContain(m4); // unrelated island never surfaces
  });
});
