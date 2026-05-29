import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { findOrCreateEntity, findOrCreateRelationship } from '../../graph/entity-store.js';
import { detectCommunities, summarizeCommunities } from '../../graph/communities.js';
import { handleCommunities } from '../../tools/communities.js';

/**
 * Materializes an undirected `co_occurs` edge by upserting the relationship
 * `times` times so its evidence_count (the label-propagation edge weight)
 * reaches `times`. Mirrors the canonical id ordering of buildCooccurrenceEdges.
 */
function addEdge(
  db: Database.Database,
  source: string,
  target: string,
  times = 1,
): void {
  const [a, b] = source < target ? [source, target] : [target, source];
  for (let i = 0; i < times; i++) {
    findOrCreateRelationship(db, a, b, 'co_occurs');
  }
}

/** Inserts a bare memory row and returns its id. */
function addMemory(db: Database.Database, content: string): string {
  const id = randomUUID();
  db.prepare('INSERT INTO memories (id, content) VALUES (?, ?)').run(id, content);
  return id;
}

/** Links a memory to an entity (mention role). */
function link(db: Database.Database, memoryId: string, entityId: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role) VALUES (?, ?, ?)',
  ).run(memoryId, entityId, 'mention');
}

/**
 * Builds two clearly-separated densely-interlinked triangles with NO edge
 * between them: {A,B,C} and {X,Y,Z}. Returns the entity ids.
 */
function buildTwoClusters(db: Database.Database): {
  A: string; B: string; C: string; X: string; Y: string; Z: string;
} {
  const A = findOrCreateEntity(db, 'AlphaCluster', 'concept');
  const B = findOrCreateEntity(db, 'BetaCluster', 'concept');
  const C = findOrCreateEntity(db, 'GammaCluster', 'concept');
  const X = findOrCreateEntity(db, 'XiCluster', 'concept');
  const Y = findOrCreateEntity(db, 'YpsilonCluster', 'concept');
  const Z = findOrCreateEntity(db, 'ZetaCluster', 'concept');

  // Cluster 1: A–B–C fully interlinked, strong evidence so the cluster is dense.
  addEdge(db, A, B, 5);
  addEdge(db, B, C, 5);
  addEdge(db, A, C, 5);
  // Cluster 2: X–Y–Z fully interlinked, strong evidence.
  addEdge(db, X, Y, 5);
  addEdge(db, Y, Z, 5);
  addEdge(db, X, Z, 5);
  // No edge connects the two clusters.

  return { A, B, C, X, Y, Z };
}

describe('GraphRAG community detection over the entity graph (Pillar 5, T15)', () => {
  it('separates two densely-interlinked clusters into exactly 2 communities', () => {
    const db = createTestDb();
    const { A, B, C, X, Y, Z } = buildTwoClusters(db);

    const communities = detectCommunities(db);

    // Exactly two distinct community ids cover all six entities.
    const distinct = new Set(communities.values());
    expect(distinct.size).toBe(2);

    // {A,B,C} share one id…
    const cluster1 = communities.get(A);
    expect(communities.get(B)).toBe(cluster1);
    expect(communities.get(C)).toBe(cluster1);

    // …{X,Y,Z} share another, and it differs from the first.
    const cluster2 = communities.get(X);
    expect(communities.get(Y)).toBe(cluster2);
    expect(communities.get(Z)).toBe(cluster2);
    expect(cluster2).not.toBe(cluster1);
  });

  it('puts an isolated entity (no edges) in its own singleton community', () => {
    const db = createTestDb();
    const { A } = buildTwoClusters(db);
    const W = findOrCreateEntity(db, 'WidowIsolated', 'concept'); // no edges

    const communities = detectCommunities(db);

    const wId = communities.get(W);
    expect(wId).toBeTypeOf('number');
    // No other entity shares W's community.
    const sharers = [...communities.entries()].filter(
      ([id, c]) => c === wId && id !== W,
    );
    expect(sharers).toHaveLength(0);
    // W's community differs from A's cluster.
    expect(wId).not.toBe(communities.get(A));
  });

  it('densely renumbers community ids from 0', () => {
    const db = createTestDb();
    buildTwoClusters(db);

    const communities = detectCommunities(db);
    const ids = [...new Set(communities.values())].sort((a, b) => a - b);

    // Dense 0..k-1 with no gaps.
    expect(ids[0]).toBe(0);
    for (let i = 0; i < ids.length; i++) expect(ids[i]).toBe(i);
  });

  it('is deterministic — two runs produce identical community maps', () => {
    const db = createTestDb();
    buildTwoClusters(db);
    findOrCreateEntity(db, 'WidowIsolated', 'concept');

    const run1 = detectCommunities(db);
    const run2 = detectCommunities(db);

    expect(run1.size).toBe(run2.size);
    for (const [id, community] of run1) {
      expect(run2.get(id)).toBe(community);
    }
    // Deep equality of the serialized maps for good measure.
    const ser = (m: Map<string, number>) =>
      [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    expect(ser(run1)).toEqual(ser(run2));
  });

  it('summarizeCommunities returns sized communities with ordered top_entities and member memories', () => {
    const db = createTestDb();
    const { A, B, C, X, Y, Z } = buildTwoClusters(db);

    // Give cluster-1 entities distinct mention counts to assert ordering.
    db.prepare('UPDATE entities SET mention_count = ? WHERE id = ?').run(30, A);
    db.prepare('UPDATE entities SET mention_count = ? WHERE id = ?').run(20, B);
    db.prepare('UPDATE entities SET mention_count = ? WHERE id = ?').run(10, C);
    db.prepare('UPDATE entities SET mention_count = ? WHERE id = ?').run(15, X);
    db.prepare('UPDATE entities SET mention_count = ? WHERE id = ?').run(25, Y);
    db.prepare('UPDATE entities SET mention_count = ? WHERE id = ?').run(5, Z);

    // Link memories to cluster-1 entities.
    const m1 = addMemory(db, 'memory about alpha');
    const m2 = addMemory(db, 'memory about beta');
    link(db, m1, A);
    link(db, m2, B);
    // Link a memory to cluster-2.
    const m3 = addMemory(db, 'memory about xi');
    link(db, m3, X);

    const summaries = summarizeCommunities(db);

    expect(summaries).toHaveLength(2);
    // Sorted by size desc; both clusters are size 3.
    for (const s of summaries) expect(s.size).toBe(3);

    // Find the cluster containing A and assert its top_entities order.
    const cluster1 = summaries.find((s) =>
      s.top_entities.some((e) => e.id === A),
    )!;
    expect(cluster1).toBeDefined();
    const names = cluster1.top_entities.map((e) => e.id);
    // mention_count desc → A(30), B(20), C(10).
    expect(names).toEqual([A, B, C]);
    // member_memory_ids contains the linked memories.
    expect(cluster1.member_memory_ids).toContain(m1);
    expect(cluster1.member_memory_ids).toContain(m2);
    expect(cluster1.member_memory_ids).not.toContain(m3);

    const cluster2 = summaries.find((s) =>
      s.top_entities.some((e) => e.id === X),
    )!;
    expect(cluster2.member_memory_ids).toContain(m3);
  });

  it('summarizeCommunities minSize filter drops singletons', () => {
    const db = createTestDb();
    buildTwoClusters(db);
    findOrCreateEntity(db, 'WidowIsolated', 'concept'); // singleton

    const all = summarizeCommunities(db, { minSize: 1 });
    expect(all).toHaveLength(3); // two triangles + singleton

    const filtered = summarizeCommunities(db, { minSize: 2 });
    expect(filtered).toHaveLength(2); // singleton dropped
    for (const s of filtered) expect(s.size).toBeGreaterThanOrEqual(2);
  });

  it('summarizeCommunities limit caps the number of communities', () => {
    const db = createTestDb();
    buildTwoClusters(db);

    const limited = summarizeCommunities(db, { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('handleCommunities returns communities, total, and a non-empty instruction', () => {
    const db = createTestDb();
    buildTwoClusters(db);

    const result = handleCommunities(db);

    expect(result.communities).toHaveLength(2);
    expect(result.total_communities).toBe(2);
    expect(typeof result.instruction).toBe('string');
    expect(result.instruction.length).toBeGreaterThan(0);
  });

  it('handleCommunities passes through limit and min_size', () => {
    const db = createTestDb();
    buildTwoClusters(db);
    findOrCreateEntity(db, 'WidowIsolated', 'concept'); // singleton

    const capped = handleCommunities(db, { limit: 1 });
    expect(capped.communities).toHaveLength(1);

    const filtered = handleCommunities(db, { min_size: 2 });
    expect(filtered.communities).toHaveLength(2);
    expect(filtered.total_communities).toBe(2);
  });
});
