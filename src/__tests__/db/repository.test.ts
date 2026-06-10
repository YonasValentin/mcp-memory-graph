import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import {
  insertMemory,
  updateMemory,
  deleteMemory,
  deleteMemoriesByFilter,
  getMemoryById,
  listMemories,
  rowToMemory,
  findNearDuplicates,
  recordAccess,
  updateQualityScores,
} from '../../db/repository.js';
import type { MemoryRow } from '../../types.js';

const embedder = new MockEmbeddingProvider();

function makeRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  const now = new Date().toISOString();
  return {
    id: `test-${Math.random().toString(36).slice(2)}`,
    scope: 'project',
    namespace: 'test-ns',
    title: 'Test Memory',
    content: 'This is test content for the memory.',
    document_type: 'note',
    source: 'test',
    author: 'tester',
    department: null,
    tags: JSON.stringify(['test', 'unit']),
    access_level: 'internal',
    language: 'en',
    metadata: JSON.stringify({ key: 'value' }),
    parent_id: null,
    chunk_index: null,
    version: 1,
    created_at: now,
    updated_at: now,
    expires_at: null,
    access_count: 0,
    last_accessed_at: null,
    importance_score: 0.5,
    confidence_score: 0.5,
    ...overrides,
  };
}

describe('repository', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('insertMemory', () => {
    it('inserts a memory and returns id + rowid', async () => {
      const row = makeRow({ id: 'mem-1' });
      const embedding = await embedder.embed(row.content);
      const result = insertMemory(db, row, embedding);

      expect(result.id).toBe('mem-1');
      expect(result.rowid).toBeGreaterThan(0);
    });

    it('stores content in all three tables (memories, vec, fts)', async () => {
      const row = makeRow({ id: 'mem-2' });
      const embedding = await embedder.embed(row.content);
      insertMemory(db, row, embedding);

      const mem = db.prepare('SELECT * FROM memories WHERE id = ?').get('mem-2');
      expect(mem).toBeDefined();

      const vec = db.prepare('SELECT rowid FROM memories_vec LIMIT 1').get();
      expect(vec).toBeDefined();

      const fts = db.prepare("SELECT * FROM memories_fts WHERE memories_fts MATCH ?").all('"test content"');
      expect(fts.length).toBeGreaterThan(0);
    });

    it('rejects duplicate IDs', async () => {
      const row = makeRow({ id: 'dup-1' });
      const embedding = await embedder.embed(row.content);
      insertMemory(db, row, embedding);

      expect(() => insertMemory(db, row, embedding)).toThrow();
    });
  });

  describe('getMemoryById', () => {
    it('returns null for non-existent ID', () => {
      expect(getMemoryById(db, 'does-not-exist')).toBeNull();
    });

    it('returns the stored memory', async () => {
      const row = makeRow({ id: 'get-1', title: 'Findable' });
      insertMemory(db, row, await embedder.embed(row.content));

      const found = getMemoryById(db, 'get-1');
      expect(found).not.toBeNull();
      expect(found!.title).toBe('Findable');
      expect(found!.content).toBe(row.content);
    });
  });

  describe('updateMemory', () => {
    it('returns null for non-existent ID', async () => {
      const result = updateMemory(db, 'no-exist', { title: 'x' });
      expect(result).toBeNull();
    });

    it('updates title and increments version', async () => {
      const row = makeRow({ id: 'upd-1' });
      insertMemory(db, row, await embedder.embed(row.content));

      const updated = updateMemory(db, 'upd-1', { title: 'New Title' });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('New Title');
      expect(updated!.version).toBe(2);
    });

    it('stamps updated_at in ISO-8601 Z format so it collates with valid_to/created_at', async () => {
      const row = makeRow({ id: 'fmt-1' });
      insertMemory(db, row, await embedder.embed(row.content));

      updateMemory(db, 'fmt-1', { title: 'edited' });

      const after = db
        .prepare('SELECT updated_at FROM memories WHERE id = ?')
        .get('fmt-1') as { updated_at: string };
      // Must be toISOString()/strftime Z form (T separator + trailing Z), NOT
      // datetime('now')'s space-separated form — otherwise it mis-collates
      // against the ISO-Z valid_to tombstone in the git union merge, silently
      // suppressing a later live edit (data loss).
      expect(after.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    });

    it('creates a version history entry', async () => {
      const row = makeRow({ id: 'upd-2', title: 'Original' });
      insertMemory(db, row, await embedder.embed(row.content));

      updateMemory(db, 'upd-2', { title: 'Changed' });

      const versions = db
        .prepare('SELECT * FROM memory_versions WHERE memory_id = ?')
        .all('upd-2') as { title: string; version: number }[];
      expect(versions).toHaveLength(1);
      expect(versions[0].title).toBe('Original');
      expect(versions[0].version).toBe(1);
    });

    it('re-embeds when content changes', async () => {
      const row = makeRow({ id: 'upd-3', content: 'original content' });
      const origEmb = await embedder.embed(row.content);
      insertMemory(db, row, origEmb);

      const newEmb = await embedder.embed('new content');
      const updated = updateMemory(db, 'upd-3', { content: 'new content' }, newEmb);
      expect(updated!.content).toBe('new content');
    });
  });

  describe('deleteMemory', () => {
    it('returns false for non-existent ID', () => {
      expect(deleteMemory(db, 'no-exist')).toBe(false);
    });

    it('deletes from all three tables', async () => {
      const row = makeRow({ id: 'del-1' });
      insertMemory(db, row, await embedder.embed(row.content));

      const result = deleteMemory(db, 'del-1');
      expect(result).toBe(true);

      expect(getMemoryById(db, 'del-1')).toBeNull();
    });

    it('cascade deletes child chunks', async () => {
      const parent = makeRow({ id: 'parent-1' });
      insertMemory(db, parent, await embedder.embed(parent.content));

      const child = makeRow({ id: 'child-1', parent_id: 'parent-1', chunk_index: 0 });
      insertMemory(db, child, await embedder.embed(child.content));

      deleteMemory(db, 'parent-1');
      expect(getMemoryById(db, 'child-1')).toBeNull();
    });
  });

  describe('deleteMemoriesByFilter', () => {
    it('returns 0 with no matching filter', async () => {
      const row = makeRow({ scope: 'project' });
      insertMemory(db, row, await embedder.embed(row.content));

      expect(deleteMemoriesByFilter(db, { scope: 'global' })).toBe(0);
    });

    it('deletes matching memories', async () => {
      const r1 = makeRow({ id: 'f1', scope: 'project', namespace: 'a' });
      const r2 = makeRow({ id: 'f2', scope: 'project', namespace: 'b' });
      const r3 = makeRow({ id: 'f3', scope: 'global', namespace: 'a' });
      for (const r of [r1, r2, r3]) {
        insertMemory(db, r, await embedder.embed(r.content));
      }

      const deleted = deleteMemoriesByFilter(db, { scope: 'project' });
      expect(deleted).toBe(2);
      expect(getMemoryById(db, 'f3')).not.toBeNull();
    });

    it('returns 0 with empty filter', () => {
      expect(deleteMemoriesByFilter(db, {})).toBe(0);
    });
  });

  describe('listMemories', () => {
    it('returns empty list from empty db', () => {
      const result = listMemories(db, { limit: 10, offset: 0 });
      expect(result.memories).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('paginates correctly', async () => {
      for (let i = 0; i < 5; i++) {
        const row = makeRow({ id: `list-${i}` });
        insertMemory(db, row, await embedder.embed(row.content));
      }

      const page1 = listMemories(db, { limit: 2, offset: 0 });
      expect(page1.memories).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = listMemories(db, { limit: 2, offset: 2 });
      expect(page2.memories).toHaveLength(2);
    });

    it('filters by scope', async () => {
      const r1 = makeRow({ id: 'ls-1', scope: 'project' });
      const r2 = makeRow({ id: 'ls-2', scope: 'global' });
      for (const r of [r1, r2]) {
        insertMemory(db, r, await embedder.embed(r.content));
      }

      const result = listMemories(db, { limit: 10, offset: 0, scope: 'project' });
      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].id).toBe('ls-1');
    });
  });

  describe('rowToMemory', () => {
    it('parses valid JSON tags and metadata', () => {
      const row = makeRow({
        tags: '["a","b"]',
        metadata: '{"key":"val"}',
      });
      const mem = rowToMemory(row);
      expect(mem.tags).toEqual(['a', 'b']);
      expect(mem.metadata).toEqual({ key: 'val' });
    });

    it('handles corrupted JSON tags gracefully', () => {
      const row = makeRow({ tags: '{invalid json' });
      const mem = rowToMemory(row);
      expect(mem.tags).toEqual([]);
    });

    it('handles corrupted JSON metadata gracefully', () => {
      const row = makeRow({ metadata: 'not-json' });
      const mem = rowToMemory(row);
      expect(mem.metadata).toBeNull();
    });

    it('handles null tags and metadata', () => {
      const row = makeRow({ tags: null as unknown as string, metadata: null });
      const mem = rowToMemory(row);
      expect(mem.tags).toEqual([]);
      expect(mem.metadata).toBeNull();
    });

    it('filters non-string tags', () => {
      const row = makeRow({ tags: '["valid", 123, null, "also-valid"]' });
      const mem = rowToMemory(row);
      expect(mem.tags).toEqual(['valid', 'also-valid']);
    });

    it('rejects array metadata', () => {
      const row = makeRow({ metadata: '[1,2,3]' });
      const mem = rowToMemory(row);
      expect(mem.metadata).toBeNull();
    });

    // team-E2E LOW: a memory retired by the NLI write-gate / supersede policy
    // looked identical to a live one over memory_get — rowToMemory dropped the
    // bi-temporal columns, so users couldn't see WHY it left search.
    it('maps the bi-temporal columns (valid_from/valid_to/superseded_at)', () => {
      const row = makeRow({
        valid_from: '2026-01-01T00:00:00.000Z',
        valid_to: '2026-02-01T00:00:00.000Z',
        superseded_at: '2026-02-01T00:00:00.000Z',
      });
      const mem = rowToMemory(row);
      expect(mem.valid_from).toBe('2026-01-01T00:00:00.000Z');
      expect(mem.valid_to).toBe('2026-02-01T00:00:00.000Z');
      expect(mem.superseded_at).toBe('2026-02-01T00:00:00.000Z');
    });

    it('defaults the bi-temporal columns to null when unset', () => {
      const mem = rowToMemory(makeRow());
      expect(mem.valid_from).toBeNull();
      expect(mem.valid_to).toBeNull();
      expect(mem.superseded_at).toBeNull();
    });
  });

  describe('findNearDuplicates', () => {
    it('returns empty for db with no memories', async () => {
      const emb = await embedder.embed('test');
      const results = findNearDuplicates(db, emb, 0.5, 10);
      expect(results).toHaveLength(0);
    });

    it('finds near-duplicate by embedding', async () => {
      const content = 'This is a specific test string for duplication';
      const row = makeRow({ id: 'dup-test', content });
      const embedding = await embedder.embed(content);
      insertMemory(db, row, embedding);

      // Search with the same embedding should find it
      const results = findNearDuplicates(db, embedding, 2.0, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe('dup-test');
      expect(results[0].distance).toBeLessThan(0.01);
    });

    it('respects distance threshold', async () => {
      const row = makeRow({ id: 'thresh-1', content: 'alpha beta gamma' });
      insertMemory(db, row, await embedder.embed(row.content));

      const differentEmb = await embedder.embed('completely unrelated zzzz');
      // Very tight threshold — should exclude distant matches
      const results = findNearDuplicates(db, differentEmb, 0.001, 10);
      expect(results).toHaveLength(0);
    });
  });

  describe('recordAccess', () => {
    it('increments access count', async () => {
      const row = makeRow({ id: 'acc-1' });
      insertMemory(db, row, await embedder.embed(row.content));

      recordAccess(db, [
        { memory_id: 'acc-1', access_type: 'search', query_text: 'test' },
      ]);

      const mem = getMemoryById(db, 'acc-1');
      expect(mem!.access_count).toBe(1);
      expect(mem!.last_accessed_at).not.toBeNull();
    });

    it('does nothing for empty entries', () => {
      recordAccess(db, []);
      // Should not throw
    });
  });

  describe('updateQualityScores', () => {
    it('updates scores for all non-chunk memories', async () => {
      const r1 = makeRow({ id: 'qs-1' });
      const r2 = makeRow({ id: 'qs-2' });
      for (const r of [r1, r2]) {
        insertMemory(db, r, await embedder.embed(r.content));
      }

      const count = updateQualityScores(db);
      expect(count).toBe(2);
    });

    it('skips child chunks', async () => {
      const parent = makeRow({ id: 'qs-parent' });
      insertMemory(db, parent, await embedder.embed(parent.content));
      const child = makeRow({ id: 'qs-child', parent_id: 'qs-parent', chunk_index: 0 });
      insertMemory(db, child, await embedder.embed(child.content));

      const count = updateQualityScores(db);
      expect(count).toBe(1);
    });
  });
});
