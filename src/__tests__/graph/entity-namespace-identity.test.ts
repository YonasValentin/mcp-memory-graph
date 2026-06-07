/**
 * battle-v14 G5/G2 — entity identity is per NAMESPACE only (the tenant boundary),
 * never per scope. The graph partition namespace is forcedNamespace() ?? '':
 *  - SINGLE-USER (unforced): every entity lands in the one shared partition (''),
 *    so a global-scope memory and project-scope memories all share one concept row
 *    (cross-project bridge preserved, exactly as pre-v14).
 *  - MULTI-TENANT (forced=T): every entity lands in namespace T (per-tenant), and
 *    a global-scope + project-scope memory WITHIN the tenant still share one row
 *    (no intra-tenant scope fragmentation).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  delete process.env.MCP_API_NAMESPACE;
});

function rows(normalized: string) {
  return db
    .prepare('SELECT scope, namespace, mention_count FROM entities WHERE normalized_name = ?')
    .all(normalized) as Array<{ scope: string; namespace: string; mention_count: number }>;
}

describe('G5 — single-user (unforced): one entity row per concept, shared across scopes/namespaces', () => {
  it('a global-scope memory and two project memories share ONE postgres entity (the cross-project bridge)', async () => {
    await handleStore(db, embedder, { scope: 'global', content: 'Global: we use PostgreSQL and Redis org-wide.', title: 'anchor' });
    await handleStore(db, embedder, { scope: 'project', namespace: 'projA', content: 'projA runs PostgreSQL and Redis.', title: 'a' });
    await handleStore(db, embedder, { scope: 'project', namespace: 'projB', content: 'projB uses PostgreSQL and Redis.', title: 'b' });
    // exactly ONE redis entity row, in the shared partition.
    const r = rows('redis');
    expect(r.length).toBe(1);
    expect(r[0].namespace).toBe('');
    // it accumulated all three mentions (no fragmentation).
    expect(r[0].mention_count).toBe(3);
    // projA and projB share the entity id (the bridge).
    const shared = db
      .prepare(
        `SELECT COUNT(*) c FROM memory_entities me1
           JOIN memories m1 ON m1.id = me1.memory_id
           JOIN memory_entities me2 ON me2.entity_id = me1.entity_id
           JOIN memories m2 ON m2.id = me2.memory_id
          WHERE m1.namespace = 'projA' AND m2.namespace = 'projB'`,
      )
      .get() as { c: number };
    expect(shared.c).toBeGreaterThan(0);
  });
});

describe('G5 — multi-tenant (forced): per-tenant, but no intra-tenant scope fragmentation', () => {
  it('within a forced tenant a global-scope and project-scope memory share one entity row', async () => {
    process.env.MCP_API_NAMESPACE = 'tenant-a';
    // server forces namespace; both stores land in tenant-a regardless of caller scope.
    await handleStore(db, embedder, { scope: 'global', namespace: 'tenant-a', content: 'Redis is our cache.', title: 'g' });
    await handleStore(db, embedder, { scope: 'project', namespace: 'tenant-a', content: 'We tuned Redis pools.', title: 'p' });
    const r = rows('redis');
    expect(r.length).toBe(1);
    expect(r[0].namespace).toBe('tenant-a');
    expect(r[0].mention_count).toBe(2);
  });

  it('two forced tenants get SEPARATE entity rows for the same concept', async () => {
    process.env.MCP_API_NAMESPACE = 'tenant-a';
    await handleStore(db, embedder, { scope: 'project', namespace: 'tenant-a', content: 'Redis here.', title: 'a' });
    process.env.MCP_API_NAMESPACE = 'tenant-b';
    await handleStore(db, embedder, { scope: 'project', namespace: 'tenant-b', content: 'Redis there.', title: 'b' });
    const r = rows('redis');
    expect(r.length).toBe(2);
    expect(r.map((x) => x.namespace).sort()).toEqual(['tenant-a', 'tenant-b']);
  });
});
