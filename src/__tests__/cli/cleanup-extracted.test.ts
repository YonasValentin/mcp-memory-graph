/**
 * Regression coverage for the cleanup-extracted SQL match (W11).
 *
 * Pre-fix: `tags LIKE '%auto-extracted%'` matched any tag containing the
 * literal substring, including values like `not-auto-extracted-related`.
 * Post-fix: json_each(memories.tags) compares exact tag values.
 *
 * The CLI script is a thin wrapper. We exercise the underlying SQL here
 * to assert match correctness without spawning the script (which writes
 * to the user's real DB path).
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

const SQL = `
  SELECT id FROM memories
   WHERE EXISTS (
           SELECT 1 FROM json_each(memories.tags)
            WHERE json_each.value = 'auto-extracted'
         )
`;

describe('cleanup-extracted exact tag match (W11)', () => {
  it('matches a memory tagged exactly auto-extracted', async () => {
    const r = await handleStore(db, embedder, {
      content: 'A quality auto-extracted memory we want to clean up.',
      tags: ['auto-extracted', 'decision'],
    });
    const matches = db.prepare(SQL).all() as { id: string }[];
    expect(matches.find((m) => m.id === r.memory.id)).toBeDefined();
  });

  it('does NOT match a memory tagged with a substring like not-auto-extracted-related', async () => {
    const r = await handleStore(db, embedder, {
      content: 'A user-tagged memory that happens to contain auto-extracted as a substring.',
      tags: ['not-auto-extracted-related'],
    });
    const matches = db.prepare(SQL).all() as { id: string }[];
    expect(matches.find((m) => m.id === r.memory.id)).toBeUndefined();
  });

  it('does NOT match a memory with no tags', async () => {
    const r = await handleStore(db, embedder, {
      content: 'A memory with no tags whatsoever for the matching check.',
    });
    const matches = db.prepare(SQL).all() as { id: string }[];
    expect(matches.find((m) => m.id === r.memory.id)).toBeUndefined();
  });
});
