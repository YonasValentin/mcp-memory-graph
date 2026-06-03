/**
 * hybridSearch pagination defaults (battle persona P5).
 *
 * `offset` is a load-bearing slice bound: filtered.slice(offset, offset+limit).
 * When an internal consumer (the way queryGraph seeds) omits offset, the old
 * code computed slice(undefined, NaN) and silently returned results:[] even
 * though total>0 — a confusing empty-but-nonzero result. offset must default to
 * 0 so an omitted offset behaves as "from the start".
 */
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { hybridSearch } from '../../search/hybrid.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

describe('hybridSearch defaults offset to 0 when omitted (PAGINATION-1)', () => {
  it('returns the matching rows instead of results:[] with total>0', async () => {
    db = createTestDb();
    await handleStore(db, embedder, { content: 'alpha note about postgres pooling' });
    await handleStore(db, embedder, { content: 'beta note about postgres indexes' });

    // Simulate an internal caller that forgets offset (the queryGraph footgun).
    const res = await hybridSearch(db, embedder, {
      query: 'postgres',
      limit: 10,
      search_mode: 'hybrid',
    } as Parameters<typeof hybridSearch>[2]);

    expect(res.total).toBeGreaterThan(0);
    expect(res.results.length).toBe(res.total); // not silently empty
  });
});
