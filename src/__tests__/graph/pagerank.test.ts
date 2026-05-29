import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { findOrCreateEntity, findOrCreateRelationship } from '../../graph/entity-store.js';
import {
  personalizedPageRank,
  rankMemoriesByPPR,
  sumMemoryScores,
} from '../../graph/pagerank.js';

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

  it('specificity tilt down-weights a high-mention hub vs. a rare node', () => {
    const db = createTestDb();
    // Symmetric graph: seed S links to two structurally identical leaves H and
    // R (same edge weight, both leaves, both one hop from S). The ONLY thing
    // distinguishing them is mention_count, so any score difference is purely
    // the specificity tilt.
    const S = findOrCreateEntity(db, 'SeedRoot', 'concept');
    const H = findOrCreateEntity(db, 'HubLeaf', 'concept'); // common → low specificity
    const R = findOrCreateEntity(db, 'RareLeaf', 'concept'); // rare → high specificity

    addEdge(db, S, H);
    addEdge(db, S, R);

    // Make H a hub (high mention_count) and R rare. Direct SQL so the counts are
    // deterministic and not perturbed by findOrCreateEntity's per-call bumps.
    db.prepare('UPDATE entities SET mention_count = ? WHERE id = ?').run(1000, H);
    db.prepare('UPDATE entities SET mention_count = ? WHERE id = ?').run(0, R);

    // Without specificity the graph is symmetric → H and R score identically.
    const flat = personalizedPageRank(db, [S], { useSpecificity: false });
    expect(flat.get(H)).toBeCloseTo(flat.get(R)!, 10);

    // With specificity the rare leaf out-ranks the hub, and the hub is measurably
    // down-weighted relative to the flat (symmetric) baseline.
    const tilted = personalizedPageRank(db, [S], { useSpecificity: true });
    expect(tilted.get(R)!).toBeGreaterThan(tilted.get(H)!);
    expect(tilted.get(H)!).toBeLessThan(flat.get(H)!);
  });

  it('excludes retracted/expired/superseded memories from the ranking', () => {
    const db = createTestDb();
    const A = findOrCreateEntity(db, 'SeedEnt', 'concept');
    const B = findOrCreateEntity(db, 'NeighborEnt', 'concept');
    addEdge(db, A, B);

    const live = addMemory(db, 'live memory near seed');
    const retracted = addMemory(db, 'retracted memory near seed');
    const expired = addMemory(db, 'tx-expired memory near seed');
    const superseded = addMemory(db, 'superseded memory near seed');
    for (const m of [live, retracted, expired, superseded]) link(db, m, B);

    // Retire three of the four memories via the three retirement columns.
    db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', retracted);
    db.prepare('UPDATE memories SET tx_expired = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', expired);
    db.prepare('UPDATE memories SET superseded_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', superseded);

    const ranked = rankMemoriesByPPR(db, [A], { useSpecificity: false });
    const ids = ranked.map((r) => r.memory_id);

    expect(ids).toContain(live);
    expect(ids).not.toContain(retracted);
    expect(ids).not.toContain(expired);
    expect(ids).not.toContain(superseded);
  });

  it('sumMemoryScores pins the float summation order (row order cannot change the result)', () => {
    // Float += is not associative, so summing the same per-entity scores in a
    // different order can yield bit-different totals. The exact float values
    // below DO differ when summed left-to-right vs reversed; sumMemoryScores must
    // pin the order (by entity id) so the link/row order it receives is
    // irrelevant — the same memory always gets the same bit-for-bit score.
    const entityScores = new Map<string, number>([
      ['ent-a', 0.1],
      ['ent-b', 0.2],
      ['ent-c', 0.30000000000000004],
      ['ent-d', 0.1 + 0.2], // 0.30000000000000004 again — float-fussy values
    ]);
    const forward = [
      { memory_id: 'm', entity_id: 'ent-a' },
      { memory_id: 'm', entity_id: 'ent-b' },
      { memory_id: 'm', entity_id: 'ent-c' },
      { memory_id: 'm', entity_id: 'ent-d' },
    ];
    const reversed = [...forward].reverse();

    const fwd = sumMemoryScores(forward, entityScores).get('m');
    const rev = sumMemoryScores(reversed, entityScores).get('m');
    // Bit-identical regardless of the order the links arrive in.
    expect(fwd).toBe(rev);
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
