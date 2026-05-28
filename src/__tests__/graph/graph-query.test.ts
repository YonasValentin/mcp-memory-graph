import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import { hybridSearch } from '../../search/hybrid.js';
import { queryGraph } from '../../graph/graph-query.js';

const embedder = new MockEmbeddingProvider();

async function store(db: ReturnType<typeof createTestDb>, content: string, title?: string) {
  return (await handleStore(db, embedder, { content, title })).memory;
}

/** Plain `links_to` edge — keeps the test graph deterministic. */
function link(db: ReturnType<typeof createTestDb>, sourceId: string, targetId: string) {
  createMemoryLink(db, {
    sourceId,
    targetId,
    relation: 'links_to',
    confidence: 'EXTRACTED',
    confidenceScore: 1,
    sourceKind: 'wikilink',
  });
}

/**
 * Builds a deterministic small graph:
 *   S → A → B   (a reachable chain)
 *   S → H       (H is a hub: many edges to dummy nodes)
 *   U           (unconnected)
 * The query lexically matches S's content (FTS keyword search), so S seeds.
 */
async function buildGraph(db: ReturnType<typeof createTestDb>) {
  const query = 'quetzalcoatl obsidian seedphrase';
  const s = await store(db, `${query} primary anchor note`, 'Seed S');
  const a = await store(db, 'alpha node reachable one hop', 'Node A');
  const b = await store(db, 'beta node reachable two hops', 'Node B');
  const h = await store(db, 'hub node highly connected', 'Hub H');
  const u = await store(db, 'unrelated lonely island note', 'Node U');

  link(db, s.id, a.id);
  link(db, a.id, b.id);
  link(db, s.id, h.id);

  // Give H a high degree by linking many dummy nodes behind it.
  const dummies: string[] = [];
  for (let i = 0; i < 20; i++) {
    const d = await store(db, `dummy hub satellite number ${i}`, `Dummy ${i}`);
    link(db, h.id, d.id);
    dummies.push(d.id);
  }

  return { query, s, a, b, h, u, dummies };
}

describe('queryGraph — token-budgeted hub-avoiding graph traversal (Pillar 3, T8)', () => {
  it('seeds from search and walks reachable nodes, excluding unconnected ones', async () => {
    const db = createTestDb();
    const { query, s, a, b, u } = await buildGraph(db);

    const result = await queryGraph(db, embedder, { query, max_hops: 2 });

    expect(result.seeds).toContain(s.id);
    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(u.id);
  });

  it('includes a hub node but does NOT expand through it', async () => {
    const db = createTestDb();
    const { query, h, dummies } = await buildGraph(db);

    const result = await queryGraph(db, embedder, { query, max_hops: 2, max_tokens: 50000 });
    const byId = new Map(result.nodes.map((n) => [n.id, n]));
    const seedSet = new Set(result.seeds);
    const dummySet = new Set(dummies);

    // The hub itself is included (it is directly linked from the seed)...
    expect(byId.has(h.id)).toBe(true);
    // ...and it was reached by traversal (hops > 0), not as a seed.
    expect(byId.get(h.id)!.hops).toBeGreaterThan(0);

    // Hub avoidance: no satellite behind H is reached by TRAVERSING THROUGH H.
    // (A satellite may still appear if it independently seeded — but then its
    // `hops` is 0 and it is a seed, never traversed in via the hub.)
    for (const node of result.nodes) {
      if (!dummySet.has(node.id)) continue;
      expect(seedSet.has(node.id)).toBe(true);
      expect(node.hops).toBe(0);
      expect(node.via).toBe('seed');
    }
  });

  it('truncates to the token budget and emits an actionable hint', async () => {
    const db = createTestDb();
    const { query } = await buildGraph(db);

    const tight = await queryGraph(db, embedder, { query, max_hops: 2, max_tokens: 50 });
    expect(tight.truncated).toBe(true);
    expect(tight.context).toContain('truncated');

    const roomy = await queryGraph(db, embedder, { query, max_hops: 2, max_tokens: 50000 });
    expect(roomy.truncated).toBe(false);
    expect(roomy.context).not.toContain('truncated');
  });

  it('bounds seed count by seed_limit and the gap cutoff', async () => {
    const db = createTestDb();
    const { query, s, u } = await buildGraph(db);

    const result = await queryGraph(db, embedder, { query, seed_limit: 5 });
    // The strongest match (S, hybrid keyword+vector) leads the seed set...
    expect(result.seeds[0]).toBe(s.id);
    // ...the seed set is capped by seed_limit (the gap cutoff can only tighten it)...
    expect(result.seeds.length).toBeGreaterThanOrEqual(1);
    expect(result.seeds.length).toBeLessThanOrEqual(5);
    // ...and the unconnected, lexically-unrelated note is never a seed.
    expect(result.seeds).not.toContain(u.id);
  });

  it('applies the gap cutoff: every seed scores within 20% of the top seed', async () => {
    const db = createTestDb();
    const { query } = await buildGraph(db);

    // The gap cutoff is enforced on the seed set: re-running the seed search and
    // checking the returned seeds all sit at or above 20% of the top hit's score.
    const { results } = await hybridSearch(db, embedder, {
      query,
      limit: 5,
      offset: 0,
      search_mode: 'hybrid',
    });
    const cutoff = results[0].score * 0.2;
    const result = await queryGraph(db, embedder, { query, seed_limit: 5 });
    const scoreById = new Map(results.map((r) => [r.memory.id, r.score]));
    for (const seedId of result.seeds) {
      expect(scoreById.get(seedId)!).toBeGreaterThanOrEqual(cutoff);
    }
  });
});
