import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { findNearDuplicates } from '../../db/repository.js';

describe('findNearDuplicates excludes bi-temporally invalidated rows (DB-7)', () => {
  it('does not return a memory whose valid_to is set', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const content = 'A memory about distributed consensus and raft leader election.';
    const { memory } = await handleStore(db, embedder, { content });

    const queryVec = await embedder.embed(content);

    // Live: the exact-match row is found (distance ~0).
    const before = findNearDuplicates(db, queryVec, 2.0, 10);
    expect(before.some((r) => r.id === memory.id)).toBe(true);

    // Soft-invalidate (tombstone) — the vec row is intentionally NOT deleted.
    db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(
      '2026-01-01T00:00:00.000Z',
      memory.id,
    );

    // After invalidation it must be excluded from near-duplicate results.
    const after = findNearDuplicates(db, queryVec, 2.0, 10);
    expect(after.some((r) => r.id === memory.id)).toBe(false);
  });

  it('excludes a transaction-superseded row (tx_expired set)', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();
    const content = 'Another memory about vector databases and ANN indexes.';
    const { memory } = await handleStore(db, embedder, { content });
    const queryVec = await embedder.embed(content);

    db.prepare('UPDATE memories SET tx_expired = ? WHERE id = ?').run(
      '2026-01-01T00:00:00.000Z',
      memory.id,
    );

    const after = findNearDuplicates(db, queryVec, 2.0, 10);
    expect(after.some((r) => r.id === memory.id)).toBe(false);
  });
});
