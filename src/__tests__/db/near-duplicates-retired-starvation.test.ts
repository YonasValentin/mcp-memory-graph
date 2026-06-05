/**
 * battle-v9 item 13 — in-partition retired-row starvation.
 *
 * findNearDuplicates retained retired vec rows (correct: as_of needs them) but
 * post-filtered them AFTER a fixed k=limit window. So when >= k newer RETIRED
 * near-dups share a partition, an older LIVE near-dup is pushed past the window
 * and silently dropped — falsifying battle-v8's "can never starve" claim WITHIN
 * a partition. A `live` vec0 metadata column would mean recreating the embedding
 * store (drop+repopulate = unacceptable data-loss risk on a real DB), so the fix
 * is bounded adaptive widening: re-query with a growing k until enough LIVE rows
 * are found or the partition is exhausted. as_of stays correct (retired rows are
 * untouched).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { insertMemory, findNearDuplicates, invalidateMemory } from '../../db/repository.js';
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

describe('findNearDuplicates — retired rows must not starve a live near-dup', () => {
  it('finds a live near-dup hidden behind k nearer RETIRED rows in the same partition', () => {
    const probe = unit([[0, 1]]);
    const near = unit([[0, 0.99], [2, 0.14]]); // ~0.14 L2 — nearer (retired)
    const far = unit([[0, 0.9315], [1, 0.3637]]); // ~0.37 L2 — farther, live, in range

    // 6 retired near-dups strictly nearer than the live candidate, same partition.
    for (let i = 0; i < 6; i++) {
      insertMemory(db, row(`r${i}`, 'P'), near);
      invalidateMemory(db, `r${i}`);
    }
    insertMemory(db, row('live0', 'P'), far);

    // limit=1: a fixed k=1 returns the single nearest (a RETIRED row) → skipped →
    // []. Adaptive widening must keep going until the live row is found.
    const res = findNearDuplicates(db, probe, 0.6, 1, { scope: 'global', namespace: 'P' });
    expect(res.map((r) => r.id)).toEqual(['live0']);
  });

  it('still returns nothing when ALL near rows are retired (no false live)', () => {
    const probe = unit([[0, 1]]);
    const near = unit([[0, 0.99], [2, 0.14]]);
    for (let i = 0; i < 5; i++) {
      insertMemory(db, row(`r${i}`, 'P'), near);
      invalidateMemory(db, `r${i}`);
    }
    expect(findNearDuplicates(db, probe, 0.6, 3, { scope: 'global', namespace: 'P' })).toEqual([]);
  });
});
