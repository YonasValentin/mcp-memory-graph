/**
 * THRUST R2 — Self-weaving knowledge graph (BATTLE-PLAN §3 R2, items 1 & 4).
 *
 * Two open gaps the thrust closes:
 *   1. `entity_relationships.strength` was the dead schema default 0.5 forever —
 *      `findOrCreateRelationship` only ever bumped evidence_count. We now write
 *      an IDF-style specificity into `strength`: an edge between two RARE
 *      entities (low mention_count) is stronger than one between common hubs,
 *      and the strength grows as the pair accumulates evidence.
 *   2. `weaveGraphEdges(db, memoryId)` recomputes the strengths of the edges
 *      touching a freshly-stored memory's entities as a single localized,
 *      fail-soft post-commit side-effect (mirrors the entity-extraction block).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import {
  findOrCreateEntity,
  findOrCreateRelationship,
  weaveGraphEdges,
  edgeStrength,
} from '../../graph/entity-store.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

function readStrength(db: Database.Database, source: string, target: string, type = 'co_occurs'): number {
  // findOrCreateRelationship stores the pair in the order passed (no
  // canonicalization), so match either direction.
  const row = db
    .prepare<[string, string, string, string, string], { strength: number }>(
      `SELECT strength FROM entity_relationships
        WHERE type = ?
          AND ((source_entity_id = ? AND target_entity_id = ?)
            OR (source_entity_id = ? AND target_entity_id = ?))`,
    )
    .get(type, source, target, target, source);
  return row!.strength;
}

describe('R2 item 1 — IDF-weighted edge strength (not the dead 0.5 default)', () => {
  it('rarer shared entities form a stronger edge than common hubs', () => {
    // Two RARE entities (mentioned once each) vs two COMMON hubs (mentioned many times).
    const rareA = findOrCreateEntity(db, 'RareA', 'concept'); // mention_count 1
    const rareB = findOrCreateEntity(db, 'RareB', 'concept'); // mention_count 1

    const hubA = findOrCreateEntity(db, 'HubA', 'concept');
    const hubB = findOrCreateEntity(db, 'HubB', 'concept');
    // Inflate the hubs' mention_count so they are "common".
    for (let i = 0; i < 20; i++) {
      findOrCreateEntity(db, 'HubA', 'concept');
      findOrCreateEntity(db, 'HubB', 'concept');
    }

    findOrCreateRelationship(db, rareA, rareB, 'co_occurs');
    findOrCreateRelationship(db, hubA, hubB, 'co_occurs');

    const rareStrength = readStrength(db, rareA, rareB);
    const hubStrength = readStrength(db, hubA, hubB);

    // The rare pair reads materially stronger than the popular hub pair.
    expect(rareStrength).toBeGreaterThan(hubStrength);
    // Both are real numbers in (0,1] — not the dead constant 0.5.
    expect(rareStrength).toBeGreaterThan(0);
    expect(rareStrength).toBeLessThanOrEqual(1);
    expect(hubStrength).toBeGreaterThan(0);
    // The hub edge must NOT be left at the schema default.
    expect(hubStrength).not.toBe(0.5);
  });

  it('strength grows as the same pair accumulates evidence', () => {
    const a = findOrCreateEntity(db, 'Alpha', 'concept');
    const b = findOrCreateEntity(db, 'Beta', 'concept');

    findOrCreateRelationship(db, a, b, 'co_occurs');
    const once = readStrength(db, a, b);

    for (let i = 0; i < 4; i++) findOrCreateRelationship(db, a, b, 'co_occurs');
    const fiveTimes = readStrength(db, a, b);

    expect(fiveTimes).toBeGreaterThan(once);
    expect(fiveTimes).toBeLessThanOrEqual(1);
  });

  it('edgeStrength is pure and deterministic', () => {
    // Rarer (lower mention sum) → stronger; more evidence → stronger.
    expect(edgeStrength(1, 1, 1)).toBe(edgeStrength(1, 1, 1));
    expect(edgeStrength(1, 1, 1)).toBeGreaterThan(edgeStrength(50, 50, 1));
    expect(edgeStrength(1, 1, 5)).toBeGreaterThan(edgeStrength(1, 1, 1));
    expect(edgeStrength(1, 1, 1)).toBeGreaterThan(0);
    expect(edgeStrength(1, 1, 1)).toBeLessThanOrEqual(1);
  });
});

describe('R2 item 4 — weaveGraphEdges recomputes strengths for a memory fail-soft', () => {
  it('refreshes the persisted strength of edges touching the memory entities', () => {
    const a = findOrCreateEntity(db, 'Gamma', 'concept');
    const b = findOrCreateEntity(db, 'Delta', 'concept');
    const memoryId = 'm-weave-1';
    db.prepare('INSERT INTO memories (id, content) VALUES (?, ?)').run(memoryId, 'weave body');
    // Create the edge directly via the relationship helper, then link both
    // entities to the memory so weaveGraphEdges can find the pair.
    findOrCreateRelationship(db, a, b, 'co_occurs');
    db.prepare(
      'INSERT INTO memory_entities (memory_id, entity_id, role, extracted_by, confidence) VALUES (?, ?, ?, ?, ?)',
    ).run(memoryId, a, 'mention', 'regex', 0.9);
    db.prepare(
      'INSERT INTO memory_entities (memory_id, entity_id, role, extracted_by, confidence) VALUES (?, ?, ?, ?, ?)',
    ).run(memoryId, b, 'mention', 'regex', 0.9);

    // Corrupt the strength back to the dead default to prove weaving rewrites it.
    db.prepare(
      "UPDATE entity_relationships SET strength = 0.5 WHERE type = 'co_occurs'",
    ).run();

    weaveGraphEdges(db, memoryId);

    const strength = readStrength(db, a, b);
    expect(strength).not.toBe(0.5);
    expect(strength).toBeGreaterThan(0);
  });

  it('is a fail-soft no-op for a memory with no linked entities', () => {
    expect(() => weaveGraphEdges(db, 'nonexistent-memory')).not.toThrow();
  });
});
