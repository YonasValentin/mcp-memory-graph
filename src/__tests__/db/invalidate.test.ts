/**
 * Invalidate-don't-delete (T3).
 *
 * Supersession must set `valid_to` rather than relying solely on the legacy
 * `superseded_at` flag, so an old fact is never hard-deleted: the row stays in
 * `memories` and remains queryable point-in-time via `as_of`. This covers the
 * `invalidateMemory` helper and the `recordConflicts` valid_to wiring.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { hybridSearch } from '../../search/hybrid.js';
import { invalidateMemory } from '../../db/repository.js';
import { recordConflicts } from '../../graph/conflict-resolver.js';
import type { SearchOptions } from '../../types.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

function searchOptions(query: string, overrides: Partial<SearchOptions> = {}): SearchOptions {
  return {
    query,
    limit: 10,
    offset: 0,
    search_mode: 'hybrid',
    ...overrides,
  };
}

function getRow(id: string) {
  return db
    .prepare<[string], { id: string; content: string; valid_to: string | null; superseded_at: string | null }>(
      'SELECT id, content, valid_to, superseded_at FROM memories WHERE id = ?',
    )
    .get(id);
}

describe('invalidateMemory — invalidate, do not delete', () => {
  it('sets a non-null valid_to, keeps the row, and leaves content unchanged', async () => {
    const content = 'The deploy target is the staging cluster.';
    const { memory } = await handleStore(db, embedder, { content });

    const changed = invalidateMemory(db, memory.id);
    expect(changed).toBe(1);

    const row = getRow(memory.id);
    expect(row).toBeDefined();
    expect(row!.valid_to).not.toBeNull();
    expect(row!.content).toBe(content);
  });

  it('excludes the memory from a default hybridSearch but keeps the row in memories', async () => {
    const content = 'Our caching layer uses Redis in production.';
    const { memory } = await handleStore(db, embedder, { content });

    const before = await hybridSearch(db, embedder, searchOptions(content));
    expect(before.results.some((r) => r.memory.id === memory.id)).toBe(true);

    invalidateMemory(db, memory.id);

    const after = await hybridSearch(db, embedder, searchOptions(content));
    expect(after.results.some((r) => r.memory.id === memory.id)).toBe(false);

    // Row still present in the table.
    const row = getRow(memory.id);
    expect(row).toBeDefined();
    expect(row!.valid_to).not.toBeNull();
  });

  it('honors an explicit valid_to and stays queryable point-in-time before it', async () => {
    const content = 'The API rate limit is one thousand requests per minute.';
    const { memory } = await handleStore(db, embedder, { content });

    // Push valid_from back so the as_of window straddles the explicit valid_to.
    db.prepare("UPDATE memories SET valid_from = '2023-06-01T00:00:00.000Z' WHERE id = ?").run(memory.id);

    const validTo = '2024-06-01T00:00:00.000Z';
    invalidateMemory(db, memory.id, validTo);

    const row = getRow(memory.id);
    expect(row!.valid_to).toBe(validTo);

    // Before valid_to → still returned.
    const beforeCut = await hybridSearch(
      db,
      embedder,
      searchOptions(content, { as_of: '2024-01-01T00:00:00.000Z' }),
    );
    expect(beforeCut.results.some((r) => r.memory.id === memory.id)).toBe(true);

    // After valid_to → excluded.
    const afterCut = await hybridSearch(
      db,
      embedder,
      searchOptions(content, { as_of: '2025-01-01T00:00:00.000Z' }),
    );
    expect(afterCut.results.some((r) => r.memory.id === memory.id)).toBe(false);
  });

  it('is idempotent — re-invalidation keeps the first valid_to (COALESCE)', async () => {
    const { memory } = await handleStore(db, embedder, { content: 'A fact that gets invalidated twice.' });

    const first = '2024-01-01T00:00:00.000Z';
    invalidateMemory(db, memory.id, first);
    invalidateMemory(db, memory.id, '2030-01-01T00:00:00.000Z');

    expect(getRow(memory.id)!.valid_to).toBe(first);
  });
});

describe('recordConflicts — supersession sets valid_to to the new memory valid_from', () => {
  it('invalidates the old memory at the new memory valid_from and keeps the old row', async () => {
    const oldStore = await handleStore(db, embedder, {
      content: 'We deploy to the legacy on-prem servers every Friday.',
    });
    const newStore = await handleStore(db, embedder, {
      content: 'We deploy to the cloud Kubernetes cluster continuously.',
    });

    const newValidFrom = db
      .prepare<[string], { valid_from: string }>('SELECT valid_from FROM memories WHERE id = ?')
      .get(newStore.memory.id)!.valid_from;

    recordConflicts(
      db,
      [
        {
          type: 'superseded',
          existing_memory_id: oldStore.memory.id,
          overlap_score: 0.8,
          description: 'x',
        },
      ],
      newStore.memory.id,
    );

    const oldRow = getRow(oldStore.memory.id);
    expect(oldRow).toBeDefined(); // not deleted
    expect(oldRow!.valid_to).toBe(newValidFrom);
    expect(oldRow!.superseded_at).not.toBeNull();
  });
});
