/**
 * Direct coverage of the conflict CLASSIFICATION bands in detectConflicts —
 * superseded (0.75–0.85] and contradicted (0.65–0.75] — that were previously
 * c8-ignored on the claim the mock embedder couldn't reach them.
 *
 * detectConflicts only considers candidates within L2 distance 0.4, so the band
 * cannot be driven by distance. Instead we pin every stored/query embedding to
 * the SAME constant vector (vectorSim ≈ 1.0) and let the keyword (jaccard)
 * overlap alone decide the band — the proven pattern from write-gate.test.ts:
 *   overlapScore = 0.5 * 1.0 + 0.5 * jaccard.
 */
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { insertMemory } from '../../db/repository.js';
import { detectConflicts } from '../../graph/conflict-resolver.js';
import type { MemoryRow } from '../../types.js';

const DIM = 384;
/** Constant vector → distance ~0 to itself, so vectorSim ≈ 1.0. */
const CONST_VEC = (): Float32Array => new Float32Array(DIM).fill(0.05);

function seedMemory(db: Database.Database, id: string, content: string): void {
  const row: MemoryRow = {
    id,
    scope: 'project',
    namespace: 'test',
    title: id,
    content,
    document_type: null,
    source: null,
    author: null,
    department: null,
    tags: null,
    access_level: 'internal',
    language: 'en',
    metadata: null,
    parent_id: null,
    chunk_index: null,
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    expires_at: null,
    access_count: 0,
    last_accessed_at: null,
    importance_score: 0.5,
    confidence_score: 0.5,
  };
  insertMemory(db, row, CONST_VEC());
}

// Existing significant set (len>=4, non-stopword): {alpha, bravo, charlie, delta}.
const EXISTING = 'alpha bravo charlie delta';
// Share 3 of 4 + 1 new → intersection 3, union 5 → jaccard 0.6 → overlap 0.80 → superseded.
const SUPERSEDED = 'alpha bravo charlie zulu';
// Share 2 of 4 + 2 new → intersection 2, union 6 → jaccard 0.333 → overlap 0.667 → contradicted.
const CONTRADICTED = 'alpha bravo yankee zulu';
// Share 1 of 4 + 3 new → intersection 1, union 7 → jaccard 0.143 → overlap 0.571 → none.
const NONE = 'alpha xray yankee zulu';

describe('detectConflicts — classification bands (vector pinned, jaccard drives the band)', () => {
  it('classifies a 0.75–0.85 overlap as SUPERSEDED', () => {
    const db = createTestDb();
    seedMemory(db, 'sup-1', EXISTING);
    const out = detectConflicts(db, CONST_VEC(), SUPERSEDED);
    const hit = out.find((c) => c.existing_memory_id === 'sup-1');
    expect(hit?.type).toBe('superseded');
    expect(hit!.overlap_score).toBeGreaterThan(0.75);
    expect(hit!.overlap_score).toBeLessThanOrEqual(0.85);
    expect(hit!.description).toContain('Superseded');
  });

  it('classifies a 0.65–0.75 overlap as CONTRADICTED', () => {
    const db = createTestDb();
    seedMemory(db, 'con-1', EXISTING);
    const out = detectConflicts(db, CONST_VEC(), CONTRADICTED);
    const hit = out.find((c) => c.existing_memory_id === 'con-1');
    expect(hit?.type).toBe('contradicted');
    expect(hit!.overlap_score).toBeGreaterThan(0.65);
    expect(hit!.overlap_score).toBeLessThanOrEqual(0.75);
    expect(hit!.description).toContain('contradiction');
  });

  it('classifies a near-identical match as a DUPLICATE (> 0.85)', () => {
    const db = createTestDb();
    seedMemory(db, 'dup-1', EXISTING);
    // Identical content → jaccard 1.0 → overlap 1.0 → duplicate.
    const out = detectConflicts(db, CONST_VEC(), EXISTING);
    const hit = out.find((c) => c.existing_memory_id === 'dup-1');
    expect(hit?.type).toBe('duplicate');
    expect(hit!.overlap_score).toBeGreaterThan(0.85);
  });

  it('returns no conflict below the contradicted band (<= 0.65)', () => {
    const db = createTestDb();
    seedMemory(db, 'low-1', EXISTING);
    const out = detectConflicts(db, CONST_VEC(), NONE);
    expect(out.find((c) => c.existing_memory_id === 'low-1')).toBeUndefined();
  });

  it('is read-only — classifying a superseded match does not mutate the matched row', () => {
    const db = createTestDb();
    seedMemory(db, 'ro-1', EXISTING);
    detectConflicts(db, CONST_VEC(), SUPERSEDED);
    const row = db
      .prepare<[string], { superseded_at: string | null }>('SELECT superseded_at FROM memories WHERE id = ?')
      .get('ro-1');
    expect(row?.superseded_at).toBeNull();
  });
});
