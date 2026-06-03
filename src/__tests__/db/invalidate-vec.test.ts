/**
 * Contract for bitemporal invalidation of the vec index.
 *
 * invalidateMemory RETAINS the memories_vec row (it only stamps valid_to) so an
 * `as_of` point-in-time VECTOR search can still rank a now-retired fact that was
 * valid at the queried instant (persona P1 — see asof-vector-reconstruction.test).
 * The "no leak" guarantee is upheld by every live-only consumer filtering retired
 * rows via the bitemporal WHERE, verified here through handleSearch.
 * (Earlier this DROPPED the vec row, which broke as_of vector reconstruction.)
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleSearch } from '../../tools/search.js';
import { invalidateMemory, getMemoryRowid } from '../../db/repository.js';

function vecCount(db: ReturnType<typeof createTestDb>, rowid: number): number {
  return (
    db
      .prepare<[bigint], { c: number }>('SELECT COUNT(*) AS c FROM memories_vec WHERE rowid = ?')
      .get(BigInt(rowid))?.c ?? 0
  );
}

describe('invalidateMemory retains the vec row but live search filters it', () => {
  it('keeps memories_vec (for as_of reconstruction) yet a current search excludes the retired memory', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const content = 'A fact that will later be retired.';
    const stored = await handleStore(db, embedder, { content, scope: 'project', namespace: 'inv' });
    const rowid = getMemoryRowid(db, stored.memory.id)!;

    expect(vecCount(db, rowid)).toBe(1);

    const changed = invalidateMemory(db, stored.memory.id);
    expect(changed).toBe(1);

    // Vec row RETAINED (the as_of-reconstruction requirement) ...
    expect(vecCount(db, rowid)).toBe(1);

    // ... but a current (non-as_of) search must not surface the retired memory.
    const res = await handleSearch(db, embedder, { query: content, limit: 10 });
    expect(JSON.stringify(res.results ?? []).includes('later be retired')).toBe(false);
  });
});
