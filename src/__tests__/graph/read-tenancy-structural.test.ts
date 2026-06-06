/**
 * v14 — read-path isolation after the write path stamps partitions. With entity
 * identity per (normalized_name, scope, namespace), a forced tenant's graph read
 * must never surface another tenant's entity name, id, mention_count, or a
 * relationship, EVEN when both tenants use the same concept name. This pins the
 * structural guarantee (and reveals whether the legacy post-filters are still
 * load-bearing).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleGraph } from '../../tools/graph.js';
import { handleCommunities } from '../../tools/communities.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  delete process.env.MCP_API_NAMESPACE;
});

/** Seed a shared-DB two-tenant graph: both projects mention 'Redis' + 'Kafka',
 *  each heavily so their global mention_count would differ. */
async function seedTwoTenants() {
  // projA: Redis mentioned via 1 memory.
  await handleStore(db, embedder, {
    title: 'a1', content: 'We use Redis and Kafka in projA.', scope: 'project', namespace: 'projA',
  });
  // projB: Redis + Kafka mentioned via 3 memories (higher global volume).
  for (let i = 0; i < 3; i++) {
    await handleStore(db, embedder, {
      title: `b${i}`, content: 'Redis and Kafka power projB heavily.', scope: 'project', namespace: 'projB',
    });
  }
}

describe('v14 read-path isolation — handleGraph under a forced namespace', () => {
  it('browse-all returns only the forced tenant entities', async () => {
    await seedTwoTenants();
    const g = handleGraph(db, { include_memories: true, limit: 50 }, 'projA');
    // Every surfaced memory must belong to projA.
    for (const m of g.memories) expect(m.namespace).toBe('projA');
    // Entity ids must be the projA rows, never projB's.
    const projBEntityIds = new Set(
      (db.prepare("SELECT id FROM entities WHERE namespace = 'projB'").all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    );
    for (const e of g.entities) expect(projBEntityIds.has(e.id)).toBe(false);
  });

  it('mention_count is tenant-local (does not leak projB volume)', async () => {
    await seedTwoTenants();
    const g = handleGraph(db, { include_memories: false, limit: 50 }, 'projA');
    const redis = g.entities.find((e) => e.name.toLowerCase() === 'redis');
    expect(redis).toBeDefined();
    // projA mentioned Redis via 1 memory; projB's 3 must not inflate it.
    expect(redis!.mention_count).toBeLessThanOrEqual(1);
  });

  it('a specific-entity query never returns the foreign tenant row', async () => {
    await seedTwoTenants();
    const g = handleGraph(db, { entity: 'Redis', depth: 2, include_memories: true }, 'projA');
    const projBEntityIds = new Set(
      (db.prepare("SELECT id FROM entities WHERE namespace = 'projB'").all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    );
    for (const e of g.entities) expect(projBEntityIds.has(e.id)).toBe(false);
    for (const m of g.memories) expect(m.namespace).toBe('projA');
  });
});

describe('v14 F3 — a residual (global,\'\') cross-linked entity is not surfaced to a forced tenant', () => {
  it('handleGraph/handleCommunities hide a global-partition entity name even when cross-linked to the tenant', async () => {
    process.env.MCP_API_NAMESPACE = 'tenantB';
    await handleStore(db, embedder, {
      title: 'b', content: 'tenantB note about networking', scope: 'project', namespace: 'tenantB',
    });
    const bMem = db.prepare("SELECT id FROM memories WHERE namespace='tenantB'").get() as { id: string };
    // Simulate a migration/residual artefact: a SHARED (global,'') entity whose
    // NAME carries a foreign secret, cross-linked to tenantB's own memory.
    const secret = randomUUID();
    db.prepare(
      "INSERT INTO entities (id,name,normalized_name,type,scope,namespace,mention_count) VALUES (?, 'ApolloTenantASecret','apollotenantasecret','project','global','',42)",
    ).run(secret);
    db.prepare(
      "INSERT OR IGNORE INTO memory_entities (memory_id,entity_id,role,extracted_by,confidence) VALUES (?,?,'mention','regex',0.9)",
    ).run(bMem.id, secret);

    const g = handleGraph(db, { limit: 50 }, 'tenantB');
    expect(g.entities.some((e) => e.name === 'ApolloTenantASecret')).toBe(false);
    const c = handleCommunities(db, { limit: 50, min_size: 1 }, 'tenantB');
    expect(JSON.stringify(c)).not.toContain('ApolloTenantASecret');
  });
});
