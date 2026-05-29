/**
 * Group G3, Finding 8 — similarity-edge confidence banding + threshold.
 *
 * The vec0 index uses L2 distance: for unit vectors d = sqrt(2*(1 - cos)).
 * buildSimilarityEdges now bands edges by L2 distance:
 *   - d <= AMBIGUOUS_DISTANCE_FLOOR (0.8, cos >= ~0.68) -> INFERRED (confident)
 *   - AMBIGUOUS_DISTANCE_FLOOR < d <= maxDistance (1.0, cos ~0.5..0.68)
 *       -> AMBIGUOUS (uncertain — feeds memory_questions 'verify')
 *   - d > maxDistance -> not linked.
 *
 * maxDistance default raised 0.5 -> 1.0 so genuinely-related MiniLM neighbours
 * (cos ~0.5+) link, while orthogonal content (cos ~0, d=1.414) still does not.
 *
 * Tests insert controlled unit vectors directly (the mock embedder's
 * near-orthogonal vectors are a no-op for similarity, so we never rely on it).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { insertMemory } from '../../db/repository.js';
import { buildSimilarityEdges } from '../../graph/similarity-edges.js';
import { getOutgoingLinks } from '../../graph/memory-links.js';
import type { MemoryRow } from '../../types.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

/** Unit vector whose first component is cos(theta) against the basis vector A. */
function vecWithCos(cos: number): Float32Array {
  const v = new Float32Array(384);
  v[0] = cos;
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v; // already unit length by construction
}

function row(id: string, content: string): MemoryRow {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id, scope: 'global', namespace: null, title: null, content,
    document_type: null, source: null, author: null, department: null,
    tags: null, access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1, created_at: now,
    updated_at: now, expires_at: null, access_count: 0, last_accessed_at: null,
    importance_score: 0.5, confidence_score: 0.7,
  };
}

describe('buildSimilarityEdges — F8 confidence banding (defaults)', () => {
  it('tags a confidently-similar neighbour (cos ~0.9, d~0.45) INFERRED', () => {
    const a = randomUUID(), b = randomUUID();
    const vA = vecWithCos(1);
    insertMemory(db, row(a, 'anchor'), vA);
    insertMemory(db, row(b, 'very similar'), vecWithCos(0.9)); // d ~0.447

    buildSimilarityEdges(db, a, vA); // use the production defaults

    const link = getOutgoingLinks(db, a).find((l) => l.source_kind === 'similarity');
    expect(link).toBeDefined();
    expect(link!.confidence).toBe('INFERRED');
  });

  it('tags a mid-band neighbour (cos ~0.55, d~0.95) AMBIGUOUS', () => {
    const a = randomUUID(), b = randomUUID();
    const vA = vecWithCos(1);
    insertMemory(db, row(a, 'anchor'), vA);
    insertMemory(db, row(b, 'loosely related'), vecWithCos(0.55)); // d ~0.949

    buildSimilarityEdges(db, a, vA);

    const link = getOutgoingLinks(db, a).find((l) => l.target_memory_id === b);
    expect(link).toBeDefined();
    expect(link!.confidence).toBe('AMBIGUOUS');
  });

  it('links genuinely-related neighbours that the old 0.5 threshold missed (cos ~0.7, d~0.77)', () => {
    const a = randomUUID(), b = randomUUID();
    const vA = vecWithCos(1);
    insertMemory(db, row(a, 'anchor'), vA);
    insertMemory(db, row(b, 'related topic'), vecWithCos(0.7)); // d ~0.775 > old 0.5

    buildSimilarityEdges(db, a, vA);

    const link = getOutgoingLinks(db, a).find((l) => l.target_memory_id === b);
    expect(link).toBeDefined();
    expect(link!.confidence).toBe('INFERRED'); // d 0.775 <= 0.8 floor
  });

  it('does NOT link orthogonal / unrelated content (cos ~0, d~1.41)', () => {
    const a = randomUUID(), b = randomUUID();
    const vA = vecWithCos(1);
    insertMemory(db, row(a, 'anchor'), vA);
    insertMemory(db, row(b, 'unrelated'), vecWithCos(0)); // d ~1.414 > maxDistance 1.0

    buildSimilarityEdges(db, a, vA);

    const link = getOutgoingLinks(db, a).find((l) => l.target_memory_id === b);
    expect(link).toBeUndefined();
  });
});
