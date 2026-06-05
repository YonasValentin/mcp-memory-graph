/**
 * battle-v8 B1 — partition pushdown: a foreign-namespace flood must not starve a
 * same-namespace near-duplicate out of the KNN window.
 *
 * THE RESIDUAL (of battle-v7 H1/H2): findNearDuplicates/detectConflicts post-
 * filtered a FIXED-k global nearest set (k = max(limit, 64)). If >= 64 foreign-
 * tenant rows are strictly NEARER than a same-tenant candidate, that candidate
 * falls past k and the post-filter never sees it → a same-namespace duplicate /
 * contradiction is silently missed (a duplicate accumulates).
 *
 * THE FIX: push the (scope, namespace) predicate INTO the memories_vec MATCH
 * (vec0 declares scope/namespace as filterable metadata columns), so the k
 * nearest are the k nearest SAME-tenant rows — foreign rows can't fill the
 * window. k returns to the true `limit`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { insertMemory, findNearDuplicates } from '../../db/repository.js';
import type { MemoryRow } from '../../types.js';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function unit(pairs: Array<[number, number]>): Float32Array {
  const v = new Float32Array(384);
  for (const [i, x] of pairs) v[i] = x;
  return v;
}
function row(id: string, namespace: string): MemoryRow {
  return {
    id, scope: 'global', namespace, title: id, content: `content ${id}`,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01', updated_at: '2026-01-01', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: 0.5, confidence_score: 0.7,
  };
}

describe('findNearDuplicates — B1: same-namespace candidate survives a foreign flood', () => {
  it('finds a projB near-duplicate even behind 70 nearer projA rows', () => {
    const probe = unit([[0, 1]]); // query axis
    const seedB = unit([[0, 0.9315], [1, 0.3637]]); // ~0.37 L2 from probe (in-range)
    const floodA = unit([[0, 0.9902], [2, 0.1396]]); // ~0.14 L2 — NEARER than seedB

    // 70 foreign (projA) rows strictly nearer than the projB candidate.
    for (let i = 0; i < 70; i++) insertMemory(db, row(`a${i}`, 'projA'), floodA);
    insertMemory(db, row('seedB', 'projB'), seedB);

    // Scoped to projB: the projB candidate MUST be found despite the projA flood.
    const scoped = findNearDuplicates(db, probe, 0.5, 10, { scope: 'global', namespace: 'projB' });
    expect(scoped.map((r) => r.id)).toContain('seedB');

    // Sanity: an UNSCOPED scan (no partition) returns only the nearer projA rows
    // within k=limit — i.e. the flood genuinely occupies the window.
    const unscoped = findNearDuplicates(db, probe, 0.5, 10);
    expect(unscoped.every((r) => r.id.startsWith('a'))).toBe(true);
  });

  it('scoping to projA still finds the projA rows; scoping to an empty namespace finds nothing', () => {
    const probe = unit([[0, 1]]);
    const v = unit([[0, 0.99], [2, 0.14]]);
    for (let i = 0; i < 3; i++) insertMemory(db, row(`a${i}`, 'projA'), v);
    expect(findNearDuplicates(db, probe, 0.5, 10, { scope: 'global', namespace: 'projA' }).length).toBe(3);
    expect(findNearDuplicates(db, probe, 0.5, 10, { scope: 'global', namespace: 'projC' }).length).toBe(0);
  });
});
