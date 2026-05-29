/**
 * Group G3, Findings 1 & 2 — store.ts write-path atomicity + NLI shortlist guard.
 *
 *  F1: bi-temporal invalidation (both the NLI-contradiction path and the
 *      heuristic DELETE path) must happen INSIDE the persist() transaction so a
 *      failed insert rolls back the retire — never leaving a fact retired with no
 *      replacement.
 *  F2: the NLI candidate shortlist must filter `parent_id IS NULL`, matching the
 *      heuristic detectConflicts guard, so it can never invalidate a chunk child
 *      of a chunked document.
 *
 * Tests use crafted Float32Array embeddings + a deterministic stub NLI so the
 * behaviour is hermetic (the mock embedder's near-orthogonal vectors are no-ops
 * for similarity, so we insert controlled vectors directly).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import { insertMemory } from '../../db/repository.js';
import type { EmbeddingProvider, MemoryRow } from '../../types.js';
import type { NliClassifier } from '../../graph/contradiction.js';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

/** A 384-dim unit vector seeded in its first few slots. */
function unit(vals: number[]): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < vals.length; i++) v[i] = vals[i];
  let n = 0;
  for (let i = 0; i < 384; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 384; i++) v[i] /= n;
  return v;
}

function baseRow(id: string, content: string, overrides: Partial<MemoryRow> = {}): MemoryRow {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id, scope: 'global', namespace: null, title: null, content,
    document_type: null, source: null, author: null, department: null,
    tags: null, access_level: 'public', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1, created_at: now,
    updated_at: now, expires_at: null, access_count: 0, last_accessed_at: null,
    importance_score: 0.5, confidence_score: 0.7,
    ...overrides,
  };
}

/** Embedder that always returns the same crafted vector, regardless of text. */
function fixedEmbedder(vec: Float32Array): EmbeddingProvider {
  return {
    dimensions: 384,
    modelName: 'fixed',
    async initialize() {},
    isReady() { return true; },
    async embed() { return vec; },
    async embedBatch(texts: string[]) { return texts.map(() => vec); },
  };
}

/** NLI stub: judges every (premise, hypothesis) pair a high-confidence contradiction. */
const alwaysContradicts: NliClassifier = {
  async classify() {
    return { label: 'contradiction', score: 0.99 };
  },
};

function validTo(id: string): string | null {
  return (
    db.prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?').get(id)
      ?.valid_to ?? null
  );
}

describe('handleStore — F1: bi-temporal invalidation is atomic with the insert', () => {
  it('NLI-contradiction path: a failed insert rolls back the invalidation (old fact survives)', async () => {
    const v = unit([1, 0.01, 0]);
    // Seed an existing, currently-valid memory the NLI will contradict.
    const oldId = randomUUID();
    insertMemory(db, baseRow(oldId, 'The API listens on port 3000.'), v);
    expect(validTo(oldId)).toBeNull();

    // Force the persist() transaction to fail: a BEFORE INSERT trigger that
    // aborts every new row in `memories`. insertMemory runs inside persist(),
    // so this makes the whole transaction roll back.
    db.exec(
      `CREATE TRIGGER fail_insert BEFORE INSERT ON memories
       BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END;`,
    );

    const embedder = fixedEmbedder(v);
    await expect(
      handleStore(
        db,
        embedder,
        { content: 'The API does NOT listen on port 3000.', on_conflict: 'supersede' },
        alwaysContradicts,
      ),
    ).rejects.toThrow(/forced insert failure/);

    // The old fact must still be valid — the retire was rolled back with the insert.
    expect(validTo(oldId)).toBeNull();
  });

  it('heuristic DELETE path: a failed insert rolls back the invalidation (old fact survives)', async () => {
    const v = unit([1, 0.01, 0]);
    const oldId = randomUUID();
    // Same vector → vectorSim ≈ 1; partially-overlapping significant words →
    // jaccard in the contradicted band, so detectConflicts returns a
    // 'contradicted' conflict and on_conflict='supersede' decides DELETE.
    const oldContent = 'deployment scheduler triggers morning batch';
    const newContent = 'deployment scheduler runs nightly batch';
    insertMemory(db, baseRow(oldId, oldContent), v);
    expect(validTo(oldId)).toBeNull();

    db.exec(
      `CREATE TRIGGER fail_insert BEFORE INSERT ON memories
       BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END;`,
    );

    const embedder = fixedEmbedder(v);
    await expect(
      handleStore(db, embedder, { content: newContent, on_conflict: 'supersede' }),
    ).rejects.toThrow(/forced insert failure/);

    // The DELETE-path retire must have rolled back with the failed insert.
    expect(validTo(oldId)).toBeNull();
  });

  it('NLI-contradiction path: on success the old fact IS retired and the new one inserted', async () => {
    const v = unit([1, 0.01, 0]);
    const oldId = randomUUID();
    insertMemory(db, baseRow(oldId, 'The API listens on port 3000.'), v);

    const embedder = fixedEmbedder(v);
    const result = await handleStore(
      db,
      embedder,
      { content: 'The API does NOT listen on port 3000.', on_conflict: 'supersede' },
      alwaysContradicts,
    );

    expect(result.stored).toBe(true);
    expect(result.operation).toBe('DELETE');
    expect(validTo(oldId)).not.toBeNull(); // old retired
    expect(validTo(result.memory.id)).toBeNull(); // new is current
  });
});

describe('handleStore — F2: NLI shortlist excludes chunk children (parent_id IS NULL)', () => {
  it('does NOT invalidate a chunk child even when it is the nearest contradiction candidate', async () => {
    const v = unit([1, 0.01, 0]);
    // A chunked document: a parent + one child chunk. Only the CHILD is the
    // vector-near candidate (the parent has a distant vector).
    const parentId = randomUUID();
    const childId = randomUUID();
    insertMemory(db, baseRow(parentId, 'Doc header', { parent_id: null }), unit([0, 1, 0]));
    insertMemory(
      db,
      baseRow(childId, 'Chunk: the service uses port 3000.', { parent_id: parentId, chunk_index: 0 }),
      v,
    );
    expect(validTo(childId)).toBeNull();

    const embedder = fixedEmbedder(v);
    await handleStore(
      db,
      embedder,
      { content: 'The service does NOT use port 3000.', on_conflict: 'supersede' },
      alwaysContradicts,
    );

    // The chunk child must remain valid — chunk children are never contradiction
    // candidates (matches detectConflicts' parent_id guard).
    expect(validTo(childId)).toBeNull();
  });
});
