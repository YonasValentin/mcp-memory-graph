/**
 * RB-10 (16th-instance class): memory_attribution / memory_stats / memory_health
 * returned aggregate COUNT/GROUP BY rollups over the corpus with no access-ceiling
 * filter, so a sub-ceiling principal observed the count (and, for attribution, the
 * AUTHOR identity + per-author count) of OVER-ceiling rows in its namespace. The
 * same count-oracle class as battle-v9 mention_count / re-battle-6 community counts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleAttribution } from '../../tools/attribution.js';
import { handleStats } from '../../tools/stats.js';
import { handleHealth } from '../../tools/health.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

async function seed(): Promise<void> {
  // alpha namespace: one public (by bob), two confidential (by alice).
  await handleStore(db, embedder, { content: 'public note', scope: 'global', namespace: 'alpha', access_level: 'public', author: 'bob' });
  await handleStore(db, embedder, { content: 'secret one', scope: 'global', namespace: 'alpha', access_level: 'confidential', author: 'alice' });
  await handleStore(db, embedder, { content: 'secret two', scope: 'global', namespace: 'alpha', access_level: 'confidential', author: 'alice' });
}

const SUBCEILING = ['public'];
const FULL = ['public', 'internal', 'confidential', 'restricted'];

describe('RB-10: aggregate-count tools honour the access ceiling', () => {
  it('attribution hides over-ceiling counts AND the over-ceiling author identity', async () => {
    await seed();
    const sub = handleAttribution(db, { namespace: 'alpha', access_level_ceiling: SUBCEILING });
    expect(sub.total, 'only the public row counts').toBe(1);
    expect(Object.keys(sub.by_author), "alice (confidential author) must not surface").not.toContain('alice');
    expect(sub.by_author).toEqual({ bob: 1 });

    // full clearance sees everything (no over-block).
    const full = handleAttribution(db, { namespace: 'alpha', access_level_ceiling: FULL });
    expect(full.total).toBe(3);
    expect(full.by_author).toEqual({ bob: 1, alice: 2 });

    // legacy/local (no ceiling) unchanged.
    expect(handleAttribution(db, { namespace: 'alpha' }).total).toBe(3);
  });

  it('stats counts only at-or-below-ceiling rows', async () => {
    await seed();
    const sub = handleStats(db, { namespace: 'alpha', access_level_ceiling: SUBCEILING });
    expect(sub.total_memories).toBe(1);
    const full = handleStats(db, { namespace: 'alpha', access_level_ceiling: FULL });
    expect(full.total_memories).toBe(3);
    expect(handleStats(db, { namespace: 'alpha' }).total_memories).toBe(3);
  });

  it('health volume counts only at-or-below-ceiling rows', async () => {
    await seed();
    const sub = handleHealth(db, { namespace: 'alpha', access_level_ceiling: SUBCEILING });
    expect(sub.memories.live).toBe(1);
    const full = handleHealth(db, { namespace: 'alpha', access_level_ceiling: FULL });
    expect(full.memories.live).toBe(3);
    expect(handleHealth(db, { namespace: 'alpha' }).memories.live).toBe(3);
  });
});
