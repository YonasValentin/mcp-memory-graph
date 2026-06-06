/**
 * v14 — handleStore stamps the owning memory's (scope, namespace) onto the
 * entities/edges it extracts, so a project-scoped memory's graph is tenant-local
 * and a forced-namespace store's graph carries the forced namespace.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

describe('v14 — handleStore plumbs partition into the entity graph', () => {
  it('a project-scoped store creates entities in that (scope, namespace)', async () => {
    await handleStore(db, embedder, {
      title: 'pg note',
      content: 'We use PostgreSQL and Redis for the projA stack.',
      scope: 'project',
      namespace: 'projA',
    });
    const es = db.prepare('SELECT DISTINCT scope, namespace FROM entities').all() as Array<{
      scope: string;
      namespace: string;
    }>;
    expect(es.length).toBeGreaterThan(0);
    for (const e of es) expect(e).toEqual({ scope: 'project', namespace: 'projA' });
  });

  it('two namespaces storing the same concept get separate entity rows', async () => {
    await handleStore(db, embedder, {
      title: 'a', content: 'We use PostgreSQL and Redis for the stack.', scope: 'project', namespace: 'projA',
    });
    await handleStore(db, embedder, {
      title: 'b', content: 'We use PostgreSQL and Redis for the stack.', scope: 'project', namespace: 'projB',
    });
    const c = db
      .prepare("SELECT COUNT(*) c FROM entities WHERE normalized_name = 'redis'")
      .get() as { c: number };
    expect(c.c).toBe(2);
  });

  it('a global-scoped store lands in the shared bridge partition', async () => {
    await handleStore(db, embedder, {
      title: 'g', content: 'We use PostgreSQL and Redis for the stack.', scope: 'global',
    });
    const e = db
      .prepare("SELECT scope, namespace FROM entities WHERE normalized_name = 'redis'")
      .get() as { scope: string; namespace: string };
    expect(e).toEqual({ scope: 'global', namespace: '' });
  });
});
