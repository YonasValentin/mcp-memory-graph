/**
 * Regression for BATTLE-PLAN #3/#4: memory_export, memory_stats and
 * memory_manifest omitted the bitemporal validity filter, so they counted /
 * exported soft-deleted (invalidated) rows that memory_list and search exclude.
 * Backups resurrected dead facts; stats over-counted and drifted with every
 * supersede. All read surfaces must agree with memory_list on what is "live".
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleList } from '../../tools/list.js';
import { handleStats } from '../../tools/stats.js';
import { handleManifest } from '../../tools/manifest.js';
import { handleExport } from '../../tools/export.js';
import { invalidateMemory } from '../../db/repository.js';

async function seed() {
  const db = createTestDb();
  const embedder = new MockEmbeddingProvider();
  const contents = [
    'We use PostgreSQL as the primary datastore for billing.',
    'Authentication uses JWT bearer tokens with short expiry.',
    'Caching is handled by Redis with a 60 second TTL.',
  ];
  const ids: string[] = [];
  for (const content of contents) {
    const r = await handleStore(db, embedder, { content, scope: 'project', namespace: 'pred' });
    ids.push(r.memory.id);
  }
  invalidateMemory(db, ids[2]); // soft-delete the Redis memory
  return { db, ids };
}

describe('live-row predicate excludes retired rows everywhere', () => {
  it('memory_list (the oracle) returns only the 2 live memories', async () => {
    const { db } = await seed();
    expect(handleList(db, { namespace: 'pred', limit: 100 }).total).toBe(2);
  });

  it('memory_stats.total_memories matches the live count', async () => {
    const { db } = await seed();
    expect(handleStats(db, { scope: 'project', namespace: 'pred' }).total_memories).toBe(2);
  });

  it('memory_manifest excludes the retired memory', async () => {
    const { db } = await seed();
    expect(handleManifest(db, { namespace: 'pred', limit: 100 }).total).toBe(2);
  });

  it('memory_export does not resurrect the retired memory', async () => {
    const { db, ids } = await seed();
    const exp = handleExport(db, { scope: 'project', namespace: 'pred' });
    expect(exp.count).toBe(2);
    expect(exp.memories.map((m) => m.id)).not.toContain(ids[2]);
  });
});
