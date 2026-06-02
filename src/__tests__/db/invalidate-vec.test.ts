/**
 * Regression for BATTLE-PLAN #7: invalidateMemory stamped valid_to but left the
 * memories_vec row in place, so a raw vector KNN MATCH still returned retired
 * memories and the vec index accumulated tombstones unbounded. Soft-deleting a
 * memory must also drop its vector (content stays in `memories`, so rebuild can
 * recompute it if ever needed).
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { invalidateMemory, getMemoryRowid } from '../../db/repository.js';

function vecCount(db: ReturnType<typeof createTestDb>, rowid: number): number {
  return (
    db
      .prepare<[bigint], { c: number }>('SELECT COUNT(*) AS c FROM memories_vec WHERE rowid = ?')
      .get(BigInt(rowid))?.c ?? 0
  );
}

describe('invalidateMemory drops the vector row', () => {
  it('removes the memories_vec row so retired memories cannot leak via raw MATCH', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const stored = await handleStore(db, embedder, {
      content: 'A fact that will later be retired.',
      scope: 'project',
      namespace: 'inv',
    });
    const rowid = getMemoryRowid(db, stored.memory.id)!;

    expect(vecCount(db, rowid)).toBe(1);

    const changed = invalidateMemory(db, stored.memory.id);
    expect(changed).toBe(1);
    expect(vecCount(db, rowid)).toBe(0);
  });
});
