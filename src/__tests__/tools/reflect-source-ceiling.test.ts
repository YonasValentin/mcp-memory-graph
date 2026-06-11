/**
 * RB-9: memory_reflect store mode's derived_from source_ids loop was a cross-
 * namespace / over-ceiling existence+liveness oracle — its existence query had no
 * namespace/access_level filter and links_created incremented unconditionally
 * (even when createMemoryLink refused a cross-ns edge), and a same-namespace
 * over-ceiling source got a persisted derived_from edge. Fix: gate each source_id
 * through reconcileBlocked — a foreign/over-ceiling id is treated as non-existent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleReflect } from '../../tools/reflect.js';
import { runWithPrincipal, type PrincipalContext } from '../../lib/request-context.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

const P: PrincipalContext = { principal: 'p', keyId: 'k', namespaces: ['alpha'], maxAccessLevel: 'public' };

function edgeCount(targetId: string): number {
  return (
    db
      .prepare<[string], { c: number }>(
        "SELECT COUNT(*) c FROM memory_links WHERE target_memory_id = ? AND relation = 'derived_from'",
      )
      .get(targetId)!.c
  );
}

describe('RB-9: memory_reflect store source_ids honour namespace + ceiling', () => {
  it('a foreign-ns / over-ceiling source_id is neither counted nor linked', async () => {
    const own = await handleStore(db, embedder, { content: 'own public alpha note', scope: 'global', namespace: 'alpha', access_level: 'public' });
    const secret = await handleStore(db, embedder, { content: 'confidential alpha secret', scope: 'global', namespace: 'alpha', access_level: 'confidential' });
    const foreign = await handleStore(db, embedder, { content: 'public beta note', scope: 'global', namespace: 'beta', access_level: 'public' });

    const res = await runWithPrincipal(P, () =>
      handleReflect(db, embedder, {
        mode: 'store',
        insight: 'a brand new synthesized higher-level insight that will not dedupe',
        source_ids: [own.memory.id, secret.memory.id, foreign.memory.id],
        scope: 'global',
        namespace: 'alpha',
        access_level_ceiling: ['public'],
      } as Parameters<typeof handleReflect>[2]),
    );

    // Only the own public alpha source is linked + counted.
    expect((res as { links_created: number }).links_created, 'oracle: only own source counts').toBe(1);
    expect(edgeCount(own.memory.id)).toBe(1);
    expect(edgeCount(secret.memory.id), 'no edge to over-ceiling source').toBe(0);
    expect(edgeCount(foreign.memory.id), 'no edge to foreign-ns source').toBe(0);
  });

  it('full-clearance, single-namespace principal links a permitted source normally', async () => {
    const own = await handleStore(db, embedder, { content: 'own alpha note A', scope: 'global', namespace: 'alpha', access_level: 'confidential' });
    const res = await runWithPrincipal(
      { ...P, maxAccessLevel: 'restricted' },
      () =>
        handleReflect(db, embedder, {
          mode: 'store',
          insight: 'novel insight referencing the confidential alpha source',
          source_ids: [own.memory.id],
          scope: 'global',
          namespace: 'alpha',
          access_level_ceiling: ['public', 'internal', 'confidential', 'restricted'],
        } as Parameters<typeof handleReflect>[2]),
    );
    expect((res as { links_created: number }).links_created).toBe(1);
    expect(edgeCount(own.memory.id)).toBe(1);
  });
});
