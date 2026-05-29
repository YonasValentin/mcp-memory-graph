/**
 * Group G3, Finding 10 — handleGraph must surface the REAL co-occurrence signal.
 *
 * findOrCreateRelationship only ever bumps evidence_count; strength stays at the
 * schema default 0.5 forever, so handleGraph reported a constant 0.5 carrying no
 * information. Now handleGraph surfaces evidence_count and derives a strength
 * that grows with it (saturating), so a pair seen many times reads stronger than
 * one seen once.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleGraph } from '../../tools/graph.js';
import { findOrCreateEntity, findOrCreateRelationship } from '../../graph/entity-store.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

function relTo(name: string, g: ReturnType<typeof handleGraph>, anchor: string) {
  const node = g.entities.find((e) => e.name === anchor);
  return node?.relationships.find((r) => r.target_entity === name);
}

describe('handleGraph — F10: surfaces real co-occurrence strength + evidence_count', () => {
  it('strength grows with evidence_count (not a constant 0.5)', () => {
    const anchor = findOrCreateEntity(db, 'Anchor', 'concept');
    const weak = findOrCreateEntity(db, 'WeakNeighbor', 'concept');
    const strong = findOrCreateEntity(db, 'StrongNeighbor', 'concept');

    // weak pair: seen once. strong pair: seen 5 times.
    findOrCreateRelationship(db, anchor, weak, 'co_occurs');
    for (let i = 0; i < 5; i++) findOrCreateRelationship(db, anchor, strong, 'co_occurs');

    const g = handleGraph(db, { entity: 'Anchor', depth: 1, limit: 10 });

    const weakRel = relTo('WeakNeighbor', g, 'Anchor');
    const strongRel = relTo('StrongNeighbor', g, 'Anchor');
    expect(weakRel).toBeDefined();
    expect(strongRel).toBeDefined();

    // The strong pair reads materially stronger than the weak pair.
    expect(strongRel!.strength).toBeGreaterThan(weakRel!.strength);
    // strength is a real number in [0,1].
    expect(strongRel!.strength).toBeLessThanOrEqual(1);
    expect(weakRel!.strength).toBeGreaterThan(0);
  });

  it('surfaces evidence_count on each relationship', () => {
    const anchor = findOrCreateEntity(db, 'Hub', 'concept');
    const other = findOrCreateEntity(db, 'Spoke', 'concept');
    findOrCreateRelationship(db, anchor, other, 'co_occurs');
    findOrCreateRelationship(db, anchor, other, 'co_occurs');
    findOrCreateRelationship(db, anchor, other, 'co_occurs');

    const g = handleGraph(db, { entity: 'Hub', depth: 1, limit: 10 });
    const rel = relTo('Spoke', g, 'Hub');
    expect(rel?.evidence_count).toBe(3);
  });
});
