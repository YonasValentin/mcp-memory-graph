import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleSearch } from '../../tools/search.js';
import { handleStats } from '../../tools/stats.js';
import { handleConsolidate } from '../../tools/consolidate.js';

const embedder = new MockEmbeddingProvider();

/**
 * TTL collation regression (battle persona P7).
 *
 * `expires_at` is written ISO-8601-with-millis-Z (`…T…Z`). Every expiry comparison
 * must compare it against an ISO-Z "now" (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`),
 * NOT space-format `datetime('now')` — otherwise a same-day expired row lexically
 * out-sorts now (`'T'` 0x54 > `' '` 0x20), so it LEAKS into search, is counted as
 * live by stats, and escapes `prune_expired`. Mirrors the valid_to/updated_at
 * invariant already enforced in repository.ts.
 *
 * Uses a 60-seconds-ago expiry so the date prefix collides with `now` (the case
 * that exposes the 'T' vs ' ' mis-sort).
 */
describe('expires_at TTL is enforced with ISO-Z collation (TTL-1)', () => {
  it('an already-expired memory is excluded from search and counted as expired by stats', async () => {
    const db = createTestDb();
    const expired = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await handleStore(db, embedder, { content: 'EXPIRED token rotation note', expires_at: expired });
    await handleStore(db, embedder, { content: 'LIVE token rotation note', expires_at: future });

    const res = await handleSearch(db, embedder, { query: 'token rotation note', limit: 20 });
    const text = JSON.stringify(res.results ?? []);
    expect(/LIVE/.test(text)).toBe(true);
    expect(/EXPIRED/.test(text)).toBe(false); // expired row must NOT leak into search

    const stats = await handleStats(db, {});
    expect(stats.expired_count).toBe(1);
  });

  it('memory_consolidate prune_expired removes the same-day expired row', async () => {
    const db = createTestDb();
    const expired = new Date(Date.now() - 60_000).toISOString();
    await handleStore(db, embedder, { content: 'stale ephemeral note', expires_at: expired });
    await handleStore(db, embedder, { content: 'durable note' });

    // Measure PHYSICAL presence, not total_memories — stats now (correctly)
    // excludes expired rows from total_memories, so the prune must be observed by
    // the row actually leaving the table. A mis-sorted ('T' vs ' ') same-day
    // expired row would ESCAPE prune and leave rawCount at 2.
    const rawCount = () =>
      db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM memories').get()!.c;
    expect(rawCount()).toBe(2); // both rows physically present before prune

    await handleConsolidate(db, embedder, { prune_expired: true, dry_run: false });

    expect(rawCount()).toBe(1); // same-day expired row was physically pruned
    const survivor = db
      .prepare<[], { content: string }>('SELECT content FROM memories')
      .get()!;
    expect(survivor.content).toBe('durable note');
  });
});
