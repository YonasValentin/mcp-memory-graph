/**
 * battle-v9 — memory_related and memory_unlinked_mentions must not leak across
 * (scope, namespace). Both ran a GLOBAL vec0 KNN with no partition, so on a
 * shared/multi-tenant DB they returned other tenants' and private scope='user'
 * memories (a real cross-tenant read leak reproduced over MCP dispatch). Fix:
 * vec0 (scope, namespace) partition pushdown confined to the target's partition.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleRelated } from '../../tools/related.js';
import { findUnlinkedMentions } from '../../graph/unlinked-mentions.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

const CONTENT = 'pgbouncer transaction pooling avoids connection exhaustion under load';

describe('memory_related / memory_unlinked_mentions — cross-namespace isolation', () => {
  it('related never returns a memory from another namespace', async () => {
    const a = await handleStore(db, embedder, { content: CONTENT, namespace: 'tenant-a' });
    await handleStore(db, embedder, { content: CONTENT, namespace: 'tenant-b' }); // foreign near-dup
    const res = await handleRelated(db, embedder, { id: a.memory.id, limit: 10 });
    const nss = res.map((r) => (r as { memory?: { namespace?: string } }).memory?.namespace ?? (r as { namespace?: string }).namespace);
    expect(nss.every((n) => n === 'tenant-a' || n === undefined)).toBe(true);
    // the foreign tenant-b row must NOT appear
    const ids = res.map((r) => (r as { memory?: { id?: string } }).memory?.id ?? (r as { id?: string }).id);
    const bId = db.prepare<[], { id: string }>("SELECT id FROM memories WHERE namespace='tenant-b'").get()!.id;
    expect(ids).not.toContain(bId);
  });

  it('unlinked_mentions never returns a memory from another namespace', async () => {
    const a = await handleStore(db, embedder, { content: CONTENT, namespace: 'tenant-a' });
    await handleStore(db, embedder, { content: CONTENT, namespace: 'tenant-b' });
    const mentions = await findUnlinkedMentions(db, embedder, a.memory.id, { limit: 10, minSimilarity: 0 });
    const bId = db.prepare<[], { id: string }>("SELECT id FROM memories WHERE namespace='tenant-b'").get()!.id;
    expect(mentions.map((m) => m.id)).not.toContain(bId);
  });
});
