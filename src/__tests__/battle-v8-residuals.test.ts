/**
 * battle-v8 residual fixes found by adversarially attacking the battle-v7 fixes:
 *  C1 hardSplitContent off-by-one, C3 delete-filter document_type, B2 communities
 *  retired-leak, B3 ingest access_level, B4 restore residuals (subtree scope +
 *  child redirect).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../testing/test-db.js';
import { MockEmbeddingProvider } from '../testing/mock-embedder.js';
import { CachedEmbeddingProvider } from '../embeddings/cache.js';
import { hardSplitContent } from '../chunking/strategies.js';
import { MemoryDeleteSchema } from '../schemas/index.js';
import { handleDelete } from '../tools/delete.js';
import { handleStore } from '../tools/store.js';
import { handleIngest } from '../tools/ingest.js';
import { handleForget } from '../tools/forget.js';
import { handleRestore } from '../tools/condense.js';
import { handleCommunities } from '../tools/communities.js';
import { invalidateMemory } from '../db/repository.js';
import { createMemoryLink } from '../graph/memory-links.js';
import { findOrCreateEntity } from '../graph/entity-store.js';

const embedder = new CachedEmbeddingProvider(new MockEmbeddingProvider());
let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

describe('C1 — hardSplitContent never exceeds chunkSize at a window-edge break', () => {
  it('a space landing exactly on the window edge does not yield a chunkSize+1 piece', () => {
    const pieces = hardSplitContent('abcd efgh ijkl', 4);
    expect(pieces.every((p) => p.length <= 4)).toBe(true);
    expect(pieces.join('')).toBe('abcd efgh ijkl'); // lossless
  });
});

describe('C3 — memory_delete filter accepts + applies document_type', () => {
  it('schema keeps document_type and a by-type filter deletes matching rows', async () => {
    expect(MemoryDeleteSchema.parse({ filter: { document_type: 'note' } }).filter?.document_type).toBe('note');
    await handleStore(db, embedder, { content: 'a throwaway note', document_type: 'note' });
    await handleStore(db, embedder, { content: 'a real decision', document_type: 'decision' });
    const r = handleDelete(db, { filter: { document_type: 'note' } });
    expect(r.deleted).toBe(1);
    expect(db.prepare("SELECT COUNT(*) c FROM memories WHERE document_type='decision'").get()).toEqual({ c: 1 });
  });
});

describe('B3 — memory_ingest honours access_level', () => {
  it('a confidential ingest marks the parent + chunks confidential, not public', async () => {
    const r = await handleIngest(db, embedder, {
      content: 'Confidential runbook. '.repeat(60),
      access_level: 'confidential',
      chunk_size: 200,
    });
    const levels = db
      .prepare<[string], { access_level: string }>('SELECT DISTINCT access_level FROM memories WHERE id = ? OR parent_id = ?')
      .all(r.parent_id, r.parent_id)
      .map((x) => x.access_level);
    expect(levels).toEqual(['confidential']);
  });
});

describe('B2 — memory_communities excludes retired member memories', () => {
  it('a soft-forgotten memory id is not listed in member_memory_ids', async () => {
    const a = await handleStore(db, embedder, { content: 'redis caching keeps entitlements fast' });
    const b = await handleStore(db, embedder, { content: 'redis also backs the rate limiter' });
    // Link both to a shared entity so they form a community.
    const e = findOrCreateEntity(db, 'redis', 'tool');
    createMemoryLink(db, { sourceId: a.memory.id, targetId: b.memory.id, relation: 'co_occurrence' });
    db.prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?,?)').run(a.memory.id, e);
    db.prepare('INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?,?)').run(b.memory.id, e);

    invalidateMemory(db, a.memory.id); // soft-forget a

    const res = handleCommunities(db, {});
    const ids = (res.communities ?? []).flatMap((c: { member_memory_ids?: string[] }) => c.member_memory_ids ?? []);
    expect(ids).not.toContain(a.memory.id);
  });
});

describe('B4 — restore residuals', () => {
  it('restoring a parent does NOT revive a child forgotten independently earlier', async () => {
    const ing = await handleIngest(db, embedder, { content: 'Alpha part. '.repeat(50) + '\n\n' + 'Beta part. '.repeat(50), chunk_size: 150 });
    const child = db.prepare<[string], { id: string }>('SELECT id FROM memories WHERE parent_id = ? LIMIT 1').get(ing.parent_id)!.id;

    handleForget(db, { id: child }); // independent child forget (earlier instant)
    await new Promise((r) => setTimeout(r, 5));
    handleForget(db, { id: ing.parent_id }); // later parent forget (cascades to the rest)

    await handleRestore(db, embedder, { id: ing.parent_id });

    // The independently-forgotten child stays tombstoned; the parent is live again.
    expect(db.prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?').get(child)!.valid_to).not.toBeNull();
    expect(db.prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?').get(ing.parent_id)!.valid_to).toBeNull();
  });

  it('restoring a CHILD id redirects to the whole document', async () => {
    const ing = await handleIngest(db, embedder, { content: 'Gamma part. '.repeat(50), chunk_size: 150 });
    handleForget(db, { id: ing.parent_id });
    const child = db.prepare<[string], { id: string }>('SELECT id FROM memories WHERE parent_id = ? LIMIT 1').get(ing.parent_id)!.id;

    const res = await handleRestore(db, embedder, { id: child });
    expect(res.restored).toBe(true);
    // The parent (and the whole subtree) is reinstated.
    expect(db.prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?').get(ing.parent_id)!.valid_to).toBeNull();
  });
});
