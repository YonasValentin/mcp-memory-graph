/**
 * v14 — handleStore stamps the owning memory's (scope, namespace) onto the
 * entities/edges it extracts, so a project-scoped memory's graph is tenant-local
 * and a forced-namespace store's graph carries the forced namespace.
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

describe('v14 (G5) — handleStore partitions the entity graph by NAMESPACE only', () => {
  afterEach(() => {
    delete process.env.MCP_API_NAMESPACE;
  });

  it('SINGLE-USER (unforced): a project-scoped store lands entities in the shared empty-namespace partition', async () => {
    await handleStore(db, embedder, {
      title: 'pg note',
      content: 'We use PostgreSQL and Redis for the projA stack.',
      scope: 'project',
      namespace: 'projA',
    });
    const es = db.prepare("SELECT namespace FROM entities").all() as Array<{ namespace: string }>;
    expect(es.length).toBeGreaterThan(0);
    for (const e of es) expect(e.namespace).toBe(''); // shared single-user graph, not per-namespace
  });

  it("SINGLE-USER (unforced): two namespaces storing the same concept SHARE one entity (the bridge)", async () => {
    await handleStore(db, embedder, {
      title: 'a', content: 'We use PostgreSQL and Redis for the stack.', scope: 'project', namespace: 'projA',
    });
    await handleStore(db, embedder, {
      title: 'b', content: 'We use PostgreSQL and Redis for the stack.', scope: 'project', namespace: 'projB',
    });
    const c = db
      .prepare("SELECT COUNT(*) c FROM entities WHERE normalized_name = 'redis'")
      .get() as { c: number };
    expect(c.c).toBe(1); // ONE shared row — cross-project bridge preserved
  });

  it('MULTI-TENANT (forced): two tenants storing the same concept get SEPARATE rows', async () => {
    process.env.MCP_API_NAMESPACE = 'tenant-a';
    await handleStore(db, embedder, {
      title: 'a', content: 'We use PostgreSQL and Redis for the stack.', scope: 'project', namespace: 'tenant-a',
    });
    process.env.MCP_API_NAMESPACE = 'tenant-b';
    await handleStore(db, embedder, {
      title: 'b', content: 'We use PostgreSQL and Redis for the stack.', scope: 'project', namespace: 'tenant-b',
    });
    const rows = db
      .prepare("SELECT namespace FROM entities WHERE normalized_name = 'redis' ORDER BY namespace")
      .all() as Array<{ namespace: string }>;
    expect(rows.map((r) => r.namespace)).toEqual(['tenant-a', 'tenant-b']);
  });
});
