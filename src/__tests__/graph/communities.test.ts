import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { findOrCreateEntity, findOrCreateRelationship } from '../../graph/entity-store.js';
import {
  detectCommunities,
  summarizeCommunities,
  summarizeCommunitiesWithTotal,
  chunkIds,
  SQLITE_MAX_VARIABLES,
} from '../../graph/communities.js';
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

describe('chunkIds — batches ids under the SQLite bound-parameter limit', () => {
  it('keeps every batch at or below the chunk size and preserves all ids in order', () => {
    const ids = Array.from({ length: 2050 }, (_, i) => `id-${i}`);
    const batches = chunkIds(ids, 900);

    // Every batch respects the cap.
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(900);
    // 2050 / 900 → 3 batches (900, 900, 250).
    expect(batches.map((b) => b.length)).toEqual([900, 900, 250]);
    // Flattening reproduces the original list exactly (no loss, no reorder).
    expect(batches.flat()).toEqual(ids);
  });

  it('returns no batches for an empty list', () => {
    expect(chunkIds([], 900)).toEqual([]);
  });

  it('uses a default chunk size strictly below the SQLite 32766-variable limit', () => {
    // The default must be small enough that a single IN-clause batch can never
    // overflow the SQLite bound-parameter ceiling.
    expect(SQLITE_MAX_VARIABLES).toBe(32766);
    const huge = Array.from({ length: SQLITE_MAX_VARIABLES + 5000 }, (_, i) => `e${i}`);
    const batches = chunkIds(huge);
    for (const batch of batches) {
      expect(batch.length).toBeLessThan(SQLITE_MAX_VARIABLES);
    }
    expect(batches.flat()).toEqual(huge);
  });
});

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

  it('summarizeCommunities handles more entities than fit in one SQL IN-batch (no "too many SQL variables")', () => {
    // Regression: the old `WHERE id IN (?,?,…)` over EVERY entity id crashed past
    // the SQLite ~32k bound-parameter limit. Inserting a few thousand isolated
    // entities and forcing a tiny batch via the chunked code path proves the IN
    // clauses are now chunked. We assert correctness (every entity surfaces as a
    // singleton community with its real name) rather than literally inserting 33k
    // rows, which the chunkIds unit test already covers for the boundary.
    const db = createTestDb();
    const N = 2500;
    const insert = db.prepare(
      'INSERT INTO entities (id, name, normalized_name, type, mention_count) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < N; i++) {
        insert.run(`ent-${i}`, `Name ${i}`, `name${i}`, 'concept', i);
      }
    });
    tx();

    // minSize 1 so all singletons return; no limit cap so we see them all.
    const summaries = summarizeCommunities(db, { limit: N, minSize: 1 });
    expect(summaries).toHaveLength(N);
    // Each community is a singleton carrying exactly its own entity with the
    // correct name pulled back through the chunked entity query.
    for (const s of summaries) {
      expect(s.size).toBe(1);
      expect(s.top_entities).toHaveLength(1);
      const e = s.top_entities[0];
      expect(e.name).toBe(`Name ${e.id.slice(4)}`);
    }
  });

  it('summarizeCommunities caps member_memory_ids by importance/mention_count, not lexicographic id', () => {
    // Regression (finding 2): the cap used to keep the lexicographically-smallest
    // member ids — arbitrary truncation. It must keep the MOST IMPORTANT memories
    // (highest importance_score, then most-accessed), so capping never silently
    // drops the memories that matter.
    const db = createTestDb();
    const A = findOrCreateEntity(db, 'CapEntity', 'concept');
    const m1 = addMemory(db, 'low importance memory');
    const m2 = addMemory(db, 'high importance memory');
    const m3 = addMemory(db, 'mid importance memory');
    // Give m2 the highest importance and m1 the lowest. Lexicographically the
    // ids are random UUIDs, so an importance-blind cap could drop m2.
    db.prepare('UPDATE memories SET importance_score = ? WHERE id = ?').run(0.1, m1);
    db.prepare('UPDATE memories SET importance_score = ? WHERE id = ?').run(0.9, m2);
    db.prepare('UPDATE memories SET importance_score = ? WHERE id = ?').run(0.5, m3);
    link(db, m1, A);
    link(db, m2, A);
    link(db, m3, A);

    // Cap to 1 member memory: the single survivor MUST be the most important (m2).
    const summaries = summarizeCommunities(db, { memberMemoriesCap: 1 });
    const cluster = summaries.find((s) => s.top_entities.some((e) => e.id === A))!;
    expect(cluster.member_memory_ids).toEqual([m2]);

    // Cap to 2: the two most important (m2 then m3), highest-importance first.
    const top2 = summarizeCommunities(db, { memberMemoriesCap: 2 }).find((s) =>
      s.top_entities.some((e) => e.id === A),
    )!;
    expect(top2.member_memory_ids).toEqual([m2, m3]);
  });

  it('summarizeCommunities member_memory_ids ordering is deterministic on tied importance', () => {
    // When importance and access_count tie, fall back to id so output is stable.
    const db = createTestDb();
    const A = findOrCreateEntity(db, 'TieEntity', 'concept');
    const ids = ['mem-aaa', 'mem-bbb', 'mem-ccc'];
    for (const id of ids) {
      db.prepare('INSERT INTO memories (id, content, importance_score) VALUES (?, ?, ?)').run(
        id,
        `content ${id}`,
        0.5,
      );
      link(db, id, A);
    }
    const cluster = summarizeCommunities(db).find((s) =>
      s.top_entities.some((e) => e.id === A),
    )!;
    // All tied on importance → ascending id tiebreak, deterministic.
    expect(cluster.member_memory_ids).toEqual(['mem-aaa', 'mem-bbb', 'mem-ccc']);
  });

  it('summarizeCommunities ranks a memory missing from the memories table LAST (orphaned link)', () => {
    // A memory_entities row can outlive its memory row. Such an orphan has no
    // importance/access metadata, so it must sort AFTER ranked memories rather
    // than crowding them out of the cap.
    const db = createTestDb();
    const A = findOrCreateEntity(db, 'OrphanHost', 'concept');
    const real = addMemory(db, 'a real ranked memory');
    db.prepare('UPDATE memories SET importance_score = ? WHERE id = ?').run(0.9, real);
    link(db, real, A);
    // Insert a dangling link to a non-existent memory id (disable FK enforcement
    // momentarily so the orphan can exist, mirroring a post-delete dangling row).
    db.pragma('foreign_keys = OFF');
    db.prepare(
      'INSERT INTO memory_entities (memory_id, entity_id, role) VALUES (?, ?, ?)',
    ).run('ghost-memory', A, 'mention');
    db.pragma('foreign_keys = ON');

    const cluster = summarizeCommunities(db).find((s) =>
      s.top_entities.some((e) => e.id === A),
    )!;
    // Both surface, but the real (ranked) memory comes first; the orphan last.
    expect(cluster.member_memory_ids[0]).toBe(real);
    expect(cluster.member_memory_ids).toContain('ghost-memory');
    expect(cluster.member_memory_ids.indexOf(real)).toBeLessThan(
      cluster.member_memory_ids.indexOf('ghost-memory'),
    );
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

  it('summarizeCommunitiesWithTotal returns the same summaries + total in a single graph build', () => {
    const db = createTestDb();
    buildTwoClusters(db);
    findOrCreateEntity(db, 'WidowIsolated', 'concept'); // singleton → 3 total

    const combined = summarizeCommunitiesWithTotal(db, { min_size: 2 });
    // Matches the separate calls exactly…
    expect(combined.communities).toEqual(summarizeCommunities(db, { minSize: 2 }));
    // …and reports the TRUE corpus-wide total (pre-filter), not the post-filter count.
    expect(combined.total_communities).toBe(3);
    expect(combined.communities).toHaveLength(2);
  });

  it('handleCommunities builds the entity graph only ONCE per call (no duplicate detect)', () => {
    const db = createTestDb();
    buildTwoClusters(db);

    // Count how many times the entity-graph SELECT runs. The old handler called
    // summarizeCommunities AND a separate count, each rebuilding the graph, so
    // the `FROM entities ORDER BY normalized_name` scan ran twice. One build now.
    let entityGraphScans = 0;
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (sql.includes('FROM entities') && sql.includes('ORDER BY normalized_name')) {
        entityGraphScans++;
      }
      return realPrepare(sql);
    }) as typeof db.prepare;

    const result = handleCommunities(db);
    expect(result.total_communities).toBe(2);
    expect(result.returned).toBe(2);
    expect(entityGraphScans).toBe(1); // single graph build, not two
  });

  it('handleCommunities returns communities, total, returned, and a non-empty instruction', () => {
    const db = createTestDb();
    buildTwoClusters(db);

    const result = handleCommunities(db);

    expect(result.communities).toHaveLength(2);
    expect(result.total_communities).toBe(2);
    expect(result.returned).toBe(2);
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
  });

  it('handleCommunities reports the TRUE total (pre-filter) separately from returned (post-filter)', () => {
    const db = createTestDb();
    buildTwoClusters(db); // two triangles
    findOrCreateEntity(db, 'WidowIsolated', 'concept'); // singleton → 3 communities total

    // No filter: total and returned both reflect all 3 communities.
    const all = handleCommunities(db);
    expect(all.total_communities).toBe(3);
    expect(all.returned).toBe(3);
    expect(all.communities).toHaveLength(3);

    // min_size drops the singleton from the returned array, but total_communities
    // still reports the TRUE corpus-wide count of detected communities.
    const filtered = handleCommunities(db, { min_size: 2 });
    expect(filtered.total_communities).toBe(3); // true total, NOT 2
    expect(filtered.returned).toBe(2); // after the minSize filter
    expect(filtered.communities).toHaveLength(2);

    // limit caps the returned array but not the true total.
    const limited = handleCommunities(db, { limit: 1 });
    expect(limited.total_communities).toBe(3); // true total, NOT 1
    expect(limited.returned).toBe(1); // after the limit cap
    expect(limited.communities).toHaveLength(1);
  });
});
