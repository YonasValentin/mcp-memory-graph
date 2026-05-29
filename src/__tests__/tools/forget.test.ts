/**
 * Pillar 8 (T24): GDPR-grade forget — soft-delete/tombstone (recoverable) and
 * hard erase with an export-before-delete portability guarantee.
 *
 * - soft (default): invalidate (stamp valid_to) so the row stays in `memories`,
 *   is excluded from default retrieval but remains queryable via as_of and is
 *   recoverable. Additive — leaves the existing memory_delete tool untouched.
 * - hard: build the full portability export FIRST, THEN hard-delete (cascade).
 *   The key correctness property is capture-then-erase ordering, so a Data
 *   Subject Access Request copy is always returned to the caller.
 *
 * Uses createTestDb + MockEmbeddingProvider + handleStore so runs stay isolated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleForget } from '../../tools/forget.js';
import { getMemoryById } from '../../db/repository.js';
import { hybridSearch } from '../../search/hybrid.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('handleForget', () => {
  it('soft (default): tombstones the memory but keeps the row recoverable and excludes it from search', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'the launch codes are 0000',
      title: 'Secret',
    });
    const id = stored.memory.id;

    const result = handleForget(db, { id });

    expect(result).toEqual({ forgotten: true, mode: 'soft', recoverable: true });

    // Row STILL EXISTS (recoverable) with valid_to now stamped.
    const row = getMemoryById(db, id);
    expect(row).not.toBeNull();
    expect(row!.valid_to).not.toBeNull();

    // Excluded from a default (currently-valid) hybrid search.
    const search = await hybridSearch(db, embedder, {
      query: 'launch codes',
      limit: 10,
      offset: 0,
      search_mode: 'hybrid',
    });
    expect(search.results.some((r) => r.memory.id === id)).toBe(false);
  });

  it('hard: returns a portability export AND removes the row entirely', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'delete me forever',
      title: 'Doomed',
      tags: ['gdpr', 'erase'],
    });
    const id = stored.memory.id;

    const result = handleForget(db, { id, hard: true });

    expect(result.forgotten).toBe(true);
    expect(result.mode).toBe('hard');
    expect(result.recoverable).toBe(false);
    expect(result.export).toBeDefined();
    expect(result.export!.id).toBe(id);
    expect(result.export!.content).toBe('delete me forever');
    expect(result.export!.tags).toEqual(['gdpr', 'erase']);

    // Row is gone — hard delete is irreversible.
    expect(getMemoryById(db, id)).toBeNull();
  });

  it('export-before-delete: the portability copy carries the content captured before erasure', async () => {
    const content = 'a one-of-a-kind sentence that must survive erasure as a portability copy';
    const stored = await handleStore(db, embedder, { content, title: 'DSAR' });
    const id = stored.memory.id;

    const result = handleForget(db, { id, hard: true });

    expect(result.export!.content).toBe(content);
    expect(getMemoryById(db, id)).toBeNull();
  });

  it('non-existent id: reports not forgotten and not recoverable', () => {
    const result = handleForget(db, { id: 'does-not-exist' });
    expect(result).toEqual({ forgotten: false, mode: 'soft', recoverable: false });

    const hardResult = handleForget(db, { id: 'does-not-exist', hard: true });
    expect(hardResult).toEqual({ forgotten: false, mode: 'hard', recoverable: false });
  });
});
