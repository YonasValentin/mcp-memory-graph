/**
 * Bi-temporal substrate coverage (schema v6).
 *
 * Memories and edges gain validity columns so facts can be "invalidated, not
 * deleted" and queried point-in-time (Zep/Graphiti model): `valid_from`,
 * `valid_to`, `tx_expired`. This task is schema + store defaults only — on
 * insert `valid_from` mirrors `created_at` (the fact became true when first
 * learned), while `valid_to`/`tx_expired` are NULL (still valid, not retracted).
 * Retrieval filtering and invalidation logic land in later tasks.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { createMemoryLink } from '../../graph/memory-links.js';

const BITEMPORAL_COLUMNS = ['valid_from', 'valid_to', 'tx_expired'] as const;

function columnNames(db: ReturnType<typeof createTestDb>, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe('bi-temporal substrate — schema v6', () => {
  it('adds valid_from/valid_to/tx_expired to memories', () => {
    const db = createTestDb();
    const names = columnNames(db, 'memories');
    for (const col of BITEMPORAL_COLUMNS) {
      expect(names).toContain(col);
    }
  });

  it('adds valid_from/valid_to/tx_expired to memory_links', () => {
    const db = createTestDb();
    const names = columnNames(db, 'memory_links');
    for (const col of BITEMPORAL_COLUMNS) {
      expect(names).toContain(col);
    }
  });

  it('stored memory has valid_from = created_at and NULL valid_to/tx_expired', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    const { memory } = await handleStore(db, embedder, { content: 'a bi-temporal fact' });

    const row = db
      .prepare<[string], { created_at: string; valid_from: string | null; valid_to: string | null; tx_expired: string | null }>(
        'SELECT created_at, valid_from, valid_to, tx_expired FROM memories WHERE id = ?',
      )
      .get(memory.id);

    expect(row).toBeDefined();
    expect(row!.valid_from).toBe(row!.created_at);
    expect(row!.valid_to).toBeNull();
    expect(row!.tx_expired).toBeNull();
  });

  it('created memory_link has valid_from set and NULL valid_to/tx_expired', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    const a = await handleStore(db, embedder, { content: 'edge source memory' });
    const b = await handleStore(db, embedder, { content: 'edge target memory' });

    const linkId = createMemoryLink(db, { sourceId: a.memory.id, targetId: b.memory.id });
    expect(linkId).not.toBe('');

    const row = db
      .prepare<[string], { valid_from: string | null; valid_to: string | null; tx_expired: string | null }>(
        'SELECT valid_from, valid_to, tx_expired FROM memory_links WHERE id = ?',
      )
      .get(linkId);

    expect(row).toBeDefined();
    expect(row!.valid_from).not.toBeNull();
    expect(row!.valid_to).toBeNull();
    expect(row!.tx_expired).toBeNull();
  });
});
