/**
 * memory_get accepts an 8-char hex short-id prefix (the form the recall hooks
 * print) in addition to the full UUID. Prefix logic lives in resolveMemoryId so
 * getMemoryById stays exact; ambiguity is surfaced, never silently resolved.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleGet } from '../../tools/get.js';
import { resolveMemoryId } from '../../db/repository.js';

const embedder = new MockEmbeddingProvider();

function insertWithId(db: ReturnType<typeof createTestDb>, id: string): void {
  db.prepare(
    `INSERT INTO memories (id, scope, namespace, content, created_at, updated_at, valid_from)
     VALUES (?, 'global', 'test', 'row', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(id);
}

describe('memory_get short-id prefix', () => {
  it('resolves an 8-char prefix to the full memory via handleGet', async () => {
    const db = createTestDb();
    const stored = (await handleStore(db, embedder, { content: 'prefix target', scope: 'global' })).memory;
    const got = handleGet(db, { id: stored.id.slice(0, 8), include_chunks: false });
    expect(got?.memory.id).toBe(stored.id);
  });

  it('still resolves a full UUID exactly (fast path)', async () => {
    const db = createTestDb();
    const stored = (await handleStore(db, embedder, { content: 'exact', scope: 'global' })).memory;
    expect(resolveMemoryId(db, stored.id)).toBe(stored.id);
  });

  it('returns null for an unknown prefix and non-hex input', () => {
    const db = createTestDb();
    expect(resolveMemoryId(db, 'deadbeef')).toBeNull();
    expect(resolveMemoryId(db, 'not-hex-id')).toBeNull();
    expect(handleGet(db, { id: 'deadbeef', include_chunks: false })).toBeNull();
  });

  it('flags an ambiguous prefix instead of picking one silently', () => {
    const db = createTestDb();
    insertWithId(db, 'abcd1111-0000-0000-0000-000000000000');
    insertWithId(db, 'abcd2222-0000-0000-0000-000000000000');

    const res = resolveMemoryId(db, 'abcd');
    expect(res).toMatchObject({ ambiguous: expect.any(Array) });
    expect((res as { ambiguous: string[] }).ambiguous).toHaveLength(2);
    expect(() => handleGet(db, { id: 'abcd', include_chunks: false })).toThrow(/Ambiguous/);
  });
});
