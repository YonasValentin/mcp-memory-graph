/**
 * THRUST R2 — make the graph signal COUNT (BATTLE-PLAN §3 R2, item 3).
 *
 * PPR previously weighted every edge purely by `evidence_count`, ignoring the
 * IDF-style `strength` that item 1 now writes. So an edge between two rare,
 * highly-specific entities counted the same as one between common hubs at equal
 * evidence. We fold `strength` into the edge weight: at equal evidence_count, a
 * stronger (more specific) edge routes more PPR mass to its target.
 *
 * Pure + deterministic — no embedder/model involved.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { personalizedPageRank } from '../../graph/pagerank.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

function addEntity(name: string, mentionCount = 1): string {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO entities (id, name, normalized_name, type, mention_count) VALUES (?, ?, ?, ?, ?)',
  ).run(id, name, name.toLowerCase(), 'concept', mentionCount);
  return id;
}

function addEdge(source: string, target: string, evidence: number, strength: number): void {
  db.prepare(
    'INSERT INTO entity_relationships (id, source_entity_id, target_entity_id, type, strength, evidence_count) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(randomUUID(), source, target, 'co_occurs', strength, evidence);
}

describe('R2 item 3 — PPR edge weight folds in strength (graph signal counts)', () => {
  it('a stronger edge routes more PPR mass than a weaker one at equal evidence', () => {
    // Seed --(strong)--> A   and   Seed --(weak)--> B, identical evidence_count.
    // Disable specificity so the ONLY difference is edge strength, isolating it.
    const seed = addEntity('Seed');
    const strongTarget = addEntity('StrongTarget');
    const weakTarget = addEntity('WeakTarget');

    addEdge(seed, strongTarget, 1, 0.9); // high specificity
    addEdge(seed, weakTarget, 1, 0.1); // low specificity

    const scores = personalizedPageRank(db, [seed], { useSpecificity: false });

    const strong = scores.get(strongTarget) ?? 0;
    const weak = scores.get(weakTarget) ?? 0;

    expect(strong).toBeGreaterThan(weak);
  });

  it('is deterministic across runs', () => {
    const seed = addEntity('S');
    const a = addEntity('A');
    const b = addEntity('B');
    addEdge(seed, a, 2, 0.7);
    addEdge(a, b, 1, 0.4);

    const first = personalizedPageRank(db, [seed]);
    const second = personalizedPageRank(db, [seed]);

    for (const [id, score] of first) {
      expect(second.get(id)).toBe(score);
    }
  });
});
