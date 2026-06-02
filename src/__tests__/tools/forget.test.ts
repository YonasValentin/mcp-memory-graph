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
import { handleIngest } from '../../tools/ingest.js';
import { handleForget } from '../../tools/forget.js';
import { getMemoryById, updateMemory } from '../../db/repository.js';
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

  it('hard: erases CHILD-CHUNK content from FTS5 + vec indexes (no right-to-erasure residue)', async () => {
    // ingest creates a parent + child chunks; each chunk carries the secret.
    const secret = 'swordfishclassified';
    const longContent = `${secret} ` + 'lorem ipsum dolor sit amet '.repeat(200);
    const { parent_id } = await handleIngest(db, embedder, {
      content: longContent,
      title: 'Sensitive Doc',
      chunk_size: 256,
    });

    // Capture every descendant rowid (parent + chunks) BEFORE erasure so we can
    // assert the vec table is clean for each of them afterwards.
    const subtree = db
      .prepare<[string], { rowid: number }>(
        `WITH RECURSIVE sub(id) AS (
           SELECT id FROM memories WHERE id = ?
           UNION ALL
           SELECT m.id FROM memories m JOIN sub ON m.parent_id = sub.id
         )
         SELECT m.rowid AS rowid FROM memories m JOIN sub ON m.id = sub.id`,
      )
      .all(parent_id);
    expect(subtree.length).toBeGreaterThan(1); // proves chunks exist

    // Pre-condition: the secret is present in FTS and the vec rows exist.
    const ftsBefore = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM memories_fts WHERE memories_fts MATCH 'swordfishclassified'")
      .get();
    expect(ftsBefore!.c).toBeGreaterThan(0);

    handleForget(db, { id: parent_id, hard: true });

    // Parent and all chunks are gone from memories.
    expect(getMemoryById(db, parent_id)).toBeNull();

    // No FTS residue anywhere.
    const ftsAfter = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM memories_fts WHERE memories_fts MATCH 'swordfishclassified'")
      .get();
    expect(ftsAfter!.c).toBe(0);

    // No vec residue for ANY descendant rowid.
    const checkVec = db.prepare<[number], { c: number }>('SELECT COUNT(*) AS c FROM memories_vec WHERE rowid = ?');
    for (const { rowid } of subtree) {
      expect(checkVec.get(rowid)!.c).toBe(0);
    }
  });

  it('hard: erases descendant chunks even when title/author/department/tags are null', async () => {
    // No title/author/department/tags → chunks carry NULLs, exercising the
    // null-column fallbacks in the FTS delete payload.
    const secret = 'mackerelundercover';
    const longContent = `${secret} ` + 'lorem ipsum dolor sit amet '.repeat(200);
    const { parent_id } = await handleIngest(db, embedder, {
      content: longContent,
      chunk_size: 256,
    });

    const before = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM memories_fts WHERE memories_fts MATCH 'mackerelundercover'")
      .get();
    expect(before!.c).toBeGreaterThan(0);

    handleForget(db, { id: parent_id, hard: true });

    const after = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM memories_fts WHERE memories_fts MATCH 'mackerelundercover'")
      .get();
    expect(after!.c).toBe(0);
    expect(getMemoryById(db, parent_id)).toBeNull();
  });

  it('hard: includes the erased memory version history in the portability export', async () => {
    const stored = await handleStore(db, embedder, { content: 'v1 content', title: 'Edited' });
    const id = stored.memory.id;

    // Two edits → two memory_versions rows (prior content the system retained).
    updateMemory(db, id, { content: 'v2 content' });
    updateMemory(db, id, { content: 'v3 content' });

    const versionsBefore = db
      .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM memory_versions WHERE memory_id = ?')
      .get(id);
    expect(versionsBefore!.c).toBe(2);

    const result = handleForget(db, { id, hard: true });

    // The export must carry the historical versions about to be destroyed.
    expect(result.versions).toBeDefined();
    expect(result.versions!.length).toBe(2);
    const contents = result.versions!.map((v) => v.content).sort();
    expect(contents).toEqual(['v1 content', 'v2 content']);

    // And the history is gone from the DB (cascade-deleted).
    const versionsAfter = db
      .prepare<[string], { c: number }>('SELECT COUNT(*) AS c FROM memory_versions WHERE memory_id = ?')
      .get(id);
    expect(versionsAfter!.c).toBe(0);
  });

  it('soft: does not capture version history (only hard erase returns it)', async () => {
    const stored = await handleStore(db, embedder, { content: 'keep me', title: 'Soft' });
    updateMemory(db, stored.memory.id, { content: 'edited' });

    const result = handleForget(db, { id: stored.memory.id });
    expect(result.versions).toBeUndefined();
  });
});
