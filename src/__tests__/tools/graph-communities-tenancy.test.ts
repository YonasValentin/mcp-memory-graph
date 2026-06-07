/**
 * battle-v9 CLASS 2 — memory_graph + memory_communities cross-tenant leak.
 *
 * Both surfaces operate over the SHARED entity graph (entities carry no
 * namespace). A single entity (e.g. "redis") can co-occur in memories of
 * different tenants, so:
 *   - memory_graph returned linked-memory id/title/namespace for ANY tenant, and
 *   - memory_communities returned member_memory_ids across tenants,
 * leaking foreign content over POST /mcp on an MCP_API_NAMESPACE deployment.
 * Their schemas carry no namespace, so withForcedNs at the registration cannot
 * reach them — the fix is a forced-namespace filter threaded into the handlers
 * (restrict the entity set to the tenant's subgraph AND filter the memory join
 * to the forced namespace, since a shared entity still links foreign memories).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleGraph } from '../../tools/graph.js';
import { handleCommunities } from '../../tools/communities.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  delete process.env.MCP_API_NAMESPACE;
});

async function seedTwoTenants() {
  // Each tenant runs a per-tenant FORCED server (G5: the entity graph is
  // partitioned by the forced namespace), so each gets its OWN "redis" row in its
  // namespace. A forced read sees only its own; an unforced read browses both.
  process.env.MCP_API_NAMESPACE = 'tenant-a';
  const a = await handleStore(db, embedder, {
    content: 'Tenant A caches entitlements in redis next to postgres.',
    title: 'A redis',
    namespace: 'tenant-a',
  });
  process.env.MCP_API_NAMESPACE = 'tenant-b';
  const b = await handleStore(db, embedder, {
    content: 'Tenant B fronts redis with kafka for its event stream.',
    title: 'B redis',
    namespace: 'tenant-b',
  });
  delete process.env.MCP_API_NAMESPACE;
  return { a: a.memory.id, b: b.memory.id };
}

describe('memory_graph — forced-namespace isolation', () => {
  it('unforced: both tenants visible through the shared entity (control)', async () => {
    const { a, b } = await seedTwoTenants();
    const ids = handleGraph(db, { entity: 'redis', include_memories: true }).memories.map((m) => m.id);
    expect(ids).toContain(a);
    expect(ids).toContain(b);
  });

  it('forced to tenant-a: tenant-b memory never surfaces through the shared entity', async () => {
    const { a, b } = await seedTwoTenants();
    const result = handleGraph(db, { entity: 'redis', include_memories: true }, 'tenant-a');
    const ids = result.memories.map((m) => m.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);
    // a tenant-b-only entity (kafka) must not appear in tenant-a's entity set
    expect(result.entities.map((e) => e.name.toLowerCase())).not.toContain('kafka');
  });
});

describe('memory_communities — forced-namespace isolation', () => {
  it('forced to tenant-a: no member_memory_id belongs to tenant-b', async () => {
    const { a, b } = await seedTwoTenants();
    const forced = handleCommunities(db, {}, 'tenant-a');
    const members = forced.communities.flatMap((c) => c.member_memory_ids);
    expect(members).toContain(a);
    expect(members).not.toContain(b);
  });

  it('unforced: tenant-b member is reachable (control)', async () => {
    const { b } = await seedTwoTenants();
    const all = handleCommunities(db, {});
    const members = all.communities.flatMap((c) => c.member_memory_ids);
    expect(members).toContain(b);
  });
});

describe('server.ts threads forcedNamespace() into graph/communities (wiring guard)', () => {
  const src = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.ts'),
    'utf8',
  );
  it('memory_graph passes forcedNamespace() to the handler', () => {
    expect(src).toContain('return handleGraph(getDb(), parsed, forcedNamespace());');
  });
  it('memory_communities passes forcedNamespace() to the handler', () => {
    expect(src).toContain('return handleCommunities(getDb(), parsed, forcedNamespace());');
  });
});
