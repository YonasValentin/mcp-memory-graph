import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { findOrCreateEntity, findOrCreateRelationship } from '../../graph/entity-store.js';
import { personalizedPageRank, rankMemoriesByPPR } from '../../graph/pagerank.js';

/**
 * Materializes an undirected `co_occurs` edge by upserting the relationship
 * `times` times so its evidence_count (the PPR edge weight) reaches `times`.
 */
function addEdge(
  db: Database.Database,
  source: string,
  target: string,
  times = 1,
): void {
  // Canonical id order matches buildCooccurrenceEdges so repeats collapse onto
  // one edge whose evidence_count grows.
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

/** Links a memory to an entity (mention role) so PPR can score the memory. */
function link(db: Database.Database, memoryId: string, entityId: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO memory_entities (memory_id, entity_id, role) VALUES (?, ?, ?)',
  ).run(memoryId, entityId, 'mention');
}

describe('Personalized PageRank over the entity graph (Pillar 3, T4)', () => {
  it('ranks closer nodes higher along a chain A—B—C—D, seed [A]; disconnected E ~0', () => {
    const db = createTestDb();
    // Equal mention counts so specificity weighting is uniform and the chain
    // distance is the only signal under test.
    const A = findOrCreateEntity(db, 'AlphaNode', 'concept');
    const B = findOrCreateEntity(db, 'BetaNode', 'concept');
    const C = findOrCreateEntity(db, 'GammaNode', 'concept');
    const D = findOrCreateEntity(db, 'DeltaNode', 'concept');
    const E = findOrCreateEntity(db, 'EpsilonNode', 'concept'); // disconnected

    addEdge(db, A, B);
    addEdge(db, B, C);
    addEdge(db, C, D);
    // E participates in a relationship to appear in the graph but is not
    // connected to the chain (self-loop is meaningless; give it an edge to a
    // sixth isolated node so it forms its own component).
    const F = findOrCreateEntity(db, 'ZetaNode', 'concept');
    addEdge(db, E, F);

    const scores = personalizedPageRank(db, [A], { useSpecificity: false });

    const a = scores.get(A) ?? 0;
    const b = scores.get(B) ?? 0;
    const c = scores.get(C) ?? 0;
    const d = scores.get(D) ?? 0;
    const e = scores.get(E) ?? 0;

    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(d);
    // E is in a different component from the only seed → near-zero mass.
    expect(e).toBeLessThan(d);
    expect(e).toBeLessThan(0.01);
  });

  it('scores over reachable nodes sum to approximately 1', () => {
    const db = createTestDb();
    const A = findOrCreateEntity(db, 'One', 'concept');
    const B = findOrCreateEntity(db, 'Two', 'concept');
    const C = findOrCreateEntity(db, 'Three', 'concept');
    addEdge(db, A, B, 2);
    addEdge(db, B, C, 3);

    const scores = personalizedPageRank(db, [A], { useSpecificity: false });
    const total = [...scores.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 3);
  });

  it('returns an empty map for empty seeds', () => {
    const db = createTestDb();
    const A = findOrCreateEntity(db, 'Solo', 'concept');
    const B = findOrCreateEntity(db, 'Mate', 'concept');
    addEdge(db, A, B);

    const scores = personalizedPageRank(db, []);
    expect(scores.size).toBe(0);
  });

  it('is deterministic — two runs give identical scores', () => {
    const db = createTestDb();
    const A = findOrCreateEntity(db, 'Det1', 'concept');
    const B = findOrCreateEntity(db, 'Det2', 'concept');
    const C = findOrCreateEntity(db, 'Det3', 'concept');
    addEdge(db, A, B, 2);
    addEdge(db, A, C);
    addEdge(db, B, C, 4);

    const run1 = personalizedPageRank(db, [A]);
    const run2 = personalizedPageRank(db, [A]);

    expect(run1.size).toBe(run2.size);
    for (const [id, score] of run1) {
      expect(run2.get(id)).toBe(score);
    }
  });

  it('rankMemoriesByPPR favors memories near the seed; disconnected omitted', () => {
    const db = createTestDb();
    const A = findOrCreateEntity(db, 'SeedEntity', 'concept');
    const B = findOrCreateEntity(db, 'MidEntity', 'concept');
    const C = findOrCreateEntity(db, 'NearEntity', 'concept'); // adjacent to A
    const D = findOrCreateEntity(db, 'FarEntity', 'concept'); // 3 hops from A
    const E = findOrCreateEntity(db, 'LoneEntity', 'concept'); // disconnected
    const F = findOrCreateEntity(db, 'LoneMate', 'concept');

    addEdge(db, A, C); // A—C
    addEdge(db, C, B); // C—B
    addEdge(db, B, D); // B—D  → D is far
    addEdge(db, E, F); // disconnected component

    const m1 = addMemory(db, 'memory near seed');
    const m2 = addMemory(db, 'memory far from seed');
    const m3 = addMemory(db, 'memory in disconnected component');
    link(db, m1, C); // near
    link(db, m2, D); // far
    link(db, m3, E); // disconnected → 0

    const ranked = rankMemoriesByPPR(db, [A], { useSpecificity: false });
    const ids = ranked.map((r) => r.memory_id);

    expect(ids).toContain(m1);
    expect(ids).toContain(m2);
    // m1 (near) ranks above m2 (far).
    expect(ids.indexOf(m1)).toBeLessThan(ids.indexOf(m2));
    // m3 is in a disconnected component → score 0 → omitted.
    expect(ids).not.toContain(m3);
  });

  it('respects the limit option', () => {
    const db = createTestDb();
    const A = findOrCreateEntity(db, 'Hub', 'concept');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const ent = findOrCreateEntity(db, `Spoke${i}`, 'concept');
      addEdge(db, A, ent);
      const m = addMemory(db, `mem ${i}`);
      link(db, m, ent);
      ids.push(m);
    }
    const mSeed = addMemory(db, 'seed mem');
    link(db, mSeed, A);

    const ranked = rankMemoriesByPPR(db, [A], { limit: 3, useSpecificity: false });
    expect(ranked.length).toBe(3);
  });
});
