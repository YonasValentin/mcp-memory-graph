/**
 * battle-v7 H4 — memory_graph must exclude bi-temporally retired memories.
 *
 * THE BUG (HIGH, correctness): handleGraph's linked-memories query filtered
 * `parent_id IS NULL AND superseded_at IS NULL` but NOT the bi-temporal live
 * predicate (`valid_to IS NULL AND tx_expired IS NULL`). vec/graph rows are
 * RETAINED on bitemporal invalidation (for as_of reconstruction), so a
 * soft-forgotten / invalidated / NLI-superseded fact still surfaced in
 * graph().memories — a retired fact leaking back into a live traversal,
 * violating the §5 invariant "every retired-row consumer must filter
 * valid_to/tx_expired".
 *
 * THE FIX: build the WHERE from the single-source liveConditions() predicate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleGraph } from '../../tools/graph.js';
import { invalidateMemory } from '../../db/repository.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

function graphMemoryIds(entity: string): string[] {
  return handleGraph(db, { entity, include_memories: true, limit: 20 }).memories.map((m) => m.id);
}

describe('handleGraph — H4: retired memories never appear in graph traversal', () => {
  it('a live memory linked to an entity appears, then disappears once invalidated', async () => {
    // "redis" is a recognized tool → regex extraction links it to this memory.
    const r = await handleStore(db, embedder, {
      content: 'We cache entitlement lookups in redis with a 60-second TTL.',
      title: 'redis cache',
    });

    // Sanity: the live memory is reachable through its entity.
    expect(graphMemoryIds('redis')).toContain(r.memory.id);

    // Bi-temporally retire it (what soft-forget / NLI-supersede do).
    invalidateMemory(db, r.memory.id);

    // It must no longer surface in the live graph traversal.
    expect(graphMemoryIds('redis')).not.toContain(r.memory.id);
  });

  it('does not affect a sibling memory that is still live', async () => {
    const stale = await handleStore(db, embedder, {
      content: 'Old note: redis was evaluated for queueing.',
      title: 'redis old',
    });
    const live = await handleStore(db, embedder, {
      content: 'Current: redis backs the rate limiter token buckets.',
      title: 'redis live',
    });

    invalidateMemory(db, stale.memory.id);

    const ids = graphMemoryIds('redis');
    expect(ids).not.toContain(stale.memory.id);
    expect(ids).toContain(live.memory.id);
  });
});
