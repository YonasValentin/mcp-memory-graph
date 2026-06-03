import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleSearch } from '../../tools/search.js';
import { invalidateMemory } from '../../db/repository.js';

const embedder = new MockEmbeddingProvider();

/**
 * as_of VECTOR reconstruction of a retired fact (persona P1).
 *
 * A point-in-time `as_of` query must reconstruct the validity window: a fact that
 * was valid at the queried instant but has since been retired/superseded should be
 * returned — including via `search_mode:'vector'`. Two things broke this:
 *   1. invalidateMemory DROPPED the retired fact's memories_vec row, so it was
 *      never a vector candidate (keyword/hybrid worked only via the surviving FTS
 *      row + matching terms).
 *   2. hybridSearch pushed `superseded_at IS NULL` unconditionally, filtering
 *      retired facts even in as_of mode.
 * The fix retains the vec row (live-only consumers filter by validity) and scopes
 * `superseded_at IS NULL` to current (non-as_of) mode.
 */
describe('as_of VECTOR search reconstructs a retired fact (ASOF-VEC-1)', () => {
  it('finds a fact valid at the instant via search_mode:vector after it is retired', async () => {
    const db = createTestDb();
    const content = 'The checkout API runs on port 3000.';
    const a = await handleStore(db, embedder, { content });
    // Pin a deterministic validity window: valid_from in the past, retired in the future-of-mid.
    db.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run('2024-01-01T00:00:00.000Z', a.memory.id);
    const mid = '2024-06-01T00:00:00.000Z';
    invalidateMemory(db, a.memory.id, '2024-12-01T00:00:00.000Z');

    // as_of the mid instant: vector search reconstructs the retired fact.
    const past = await handleSearch(db, embedder, { query: content, search_mode: 'vector', as_of: mid, limit: 10 });
    expect(/3000/.test(JSON.stringify(past.results ?? []))).toBe(true);

    // Current vector search must NOT return the retired fact.
    const now = await handleSearch(db, embedder, { query: content, search_mode: 'vector', limit: 10 });
    expect(/3000/.test(JSON.stringify(now.results ?? []))).toBe(false);
  });
});
