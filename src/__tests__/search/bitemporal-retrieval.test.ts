/**
 * Bi-temporal retrieval (Task T2).
 *
 * T1 added the validity columns; this task makes retrieval USE them. By default
 * search and list return only currently-valid memories
 * (`valid_to IS NULL AND tx_expired IS NULL`). When a caller passes `as_of`
 * (an ISO-8601 instant) they instead get what was valid at that point in time:
 * a row matches when it had become valid by `as_of` and had not yet been
 * invalidated or retracted then.
 *
 * These tests simulate invalidation by setting `valid_to` directly via SQL —
 * the logic that SETS `valid_to` (supersession) lands in T3.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { hybridSearch } from '../../search/hybrid.js';
import { handleList } from '../../tools/list.js';
import type { EmbeddingProvider } from '../../types.js';

function setValidTo(db: ReturnType<typeof createTestDb>, id: string, validTo: string): void {
  db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(validTo, id);
}

function setValidFrom(db: ReturnType<typeof createTestDb>, id: string, validFrom: string): void {
  db.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(validFrom, id);
}

function searchIds(
  db: ReturnType<typeof createTestDb>,
  embedder: EmbeddingProvider,
  query: string,
  as_of?: string,
): Promise<string[]> {
  return hybridSearch(db, embedder, {
    query,
    limit: 50,
    offset: 0,
    search_mode: 'hybrid',
    ...(as_of ? { as_of } : {}),
  }).then((r) => r.results.map((x) => x.memory.id));
}

describe('bi-temporal retrieval — T2', () => {
  it('default search excludes a memory whose valid_to is in the past', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    const { memory } = await handleStore(db, embedder, {
      content: 'superseded deployment runbook kubernetes',
    });
    setValidTo(db, memory.id, '2020-01-01T00:00:00.000Z');

    const ids = await searchIds(db, embedder, 'superseded deployment runbook kubernetes');
    expect(ids).not.toContain(memory.id);
  });

  it('default search returns a currently-valid memory matching the query', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    const { memory } = await handleStore(db, embedder, {
      content: 'current authentication policy oauth rotation',
    });

    const ids = await searchIds(db, embedder, 'current authentication policy oauth rotation');
    expect(ids).toContain(memory.id);
  });

  it('as_of before valid_to returns the memory, as_of after valid_to excludes it', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    const { memory } = await handleStore(db, embedder, {
      content: 'pricing tier enterprise discount terms',
    });
    // Fact was valid from store time until 2023-06-01, then invalidated.
    setValidFrom(db, memory.id, '2023-01-01T00:00:00.000Z');
    setValidTo(db, memory.id, '2023-06-01T00:00:00.000Z');

    const before = await searchIds(
      db,
      embedder,
      'pricing tier enterprise discount terms',
      '2023-03-01T00:00:00.000Z',
    );
    expect(before).toContain(memory.id);

    const after = await searchIds(
      db,
      embedder,
      'pricing tier enterprise discount terms',
      '2023-09-01T00:00:00.000Z',
    );
    expect(after).not.toContain(memory.id);
  });

  it('as_of before valid_from excludes the memory (did not exist yet)', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    const { memory } = await handleStore(db, embedder, {
      content: 'quarterly roadmap mobile redesign milestone',
    });
    setValidFrom(db, memory.id, '2024-01-01T00:00:00.000Z');

    const ids = await searchIds(
      db,
      embedder,
      'quarterly roadmap mobile redesign milestone',
      '2023-01-01T00:00:00.000Z',
    );
    expect(ids).not.toContain(memory.id);
  });

  it('default list excludes a memory whose valid_to is in the past', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    const valid = await handleStore(db, embedder, { content: 'list still-valid note' });
    const invalid = await handleStore(db, embedder, { content: 'list superseded note' });
    setValidTo(db, invalid.memory.id, '2020-01-01T00:00:00.000Z');

    const listed = handleList(db, { limit: 50 });
    const ids = listed.items.map((m) => m.id);

    expect(ids).toContain(valid.memory.id);
    expect(ids).not.toContain(invalid.memory.id);
  });

  it('list with as_of returns what was valid at that instant', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    const { memory } = await handleStore(db, embedder, { content: 'list point-in-time note' });
    setValidFrom(db, memory.id, '2023-01-01T00:00:00.000Z');
    setValidTo(db, memory.id, '2023-06-01T00:00:00.000Z');

    const before = handleList(db, { limit: 50, as_of: '2023-03-01T00:00:00.000Z' });
    expect(before.items.map((m) => m.id)).toContain(memory.id);

    const after = handleList(db, { limit: 50, as_of: '2023-09-01T00:00:00.000Z' });
    expect(after.items.map((m) => m.id)).not.toContain(memory.id);
  });
});
