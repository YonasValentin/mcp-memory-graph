/**
 * Group G3, Finding 7 — co-occurrence is now a memory_links signal.
 *
 * When two memories share >= 1 entity, the store bridges that into a
 * memory<->memory memory_links edge (relation 'co_occurs', source_kind
 * 'co_occurrence', confidence INFERRED) so /api/graph and memory_get.links
 * actually reflect co-occurrence — previously co-occurrence only ever wrote
 * entity_relationships, leaving the memory graph empty in normal use.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { getLinksAmong } from '../../graph/memory-links.js';
import { buildMemoryCooccurrenceLinks } from '../../graph/entity-store.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

function coLinks(): Array<{ source_memory_id: string; target_memory_id: string; confidence: string; evidence_count: number; confidence_score: number }> {
  return db
    .prepare("SELECT * FROM memory_links WHERE source_kind = 'co_occurrence'")
    .all() as never;
}

describe('co-occurrence -> memory_links bridge (F7)', () => {
  it('creates a memory_links co_occurs edge between two memories sharing entities', async () => {
    const a = await handleStore(db, embedder, { content: 'We use React with Docker in the AuthService.' });
    const b = await handleStore(db, embedder, { content: 'React plus Docker again power our stack.' });

    const links = coLinks();
    expect(links.length).toBeGreaterThan(0);

    const endpoints = new Set(links.flatMap((l) => [l.source_memory_id, l.target_memory_id]));
    expect(endpoints.has(a.memory.id)).toBe(true);
    expect(endpoints.has(b.memory.id)).toBe(true);

    // Tagged as an inferred co-occurrence signal.
    expect(links.every((l) => l.confidence === 'INFERRED')).toBe(true);

    // The edge is visible in the subgraph view that /api/graph uses.
    const amongLinks = getLinksAmong(db, [a.memory.id, b.memory.id]).filter(
      (l) => l.source_kind === 'co_occurrence',
    );
    expect(amongLinks.length).toBeGreaterThan(0);
  });

  it('does NOT create a co-occurrence edge between memories with no shared entity', async () => {
    const a = await handleStore(db, embedder, { content: 'We use React and Docker here.' });
    // No known/extractable entity overlap with the first memory.
    const b = await handleStore(db, embedder, { content: 'A plain sentence with nothing notable inside.' });

    const among = getLinksAmong(db, [a.memory.id, b.memory.id]).filter(
      (l) => l.source_kind === 'co_occurrence',
    );
    expect(among).toHaveLength(0);
  });

  it('bumps evidence_count when the same memory pair co-occurs again', async () => {
    const a = await handleStore(db, embedder, { content: 'React and Docker run the app.' });
    const b = await handleStore(db, embedder, { content: 'React and Docker again, more of them.' });

    // The entity id both memories share (created during the stores above).
    const shared = db
      .prepare<[string], { entity_id: string }>(
        'SELECT entity_id FROM memory_entities WHERE memory_id = ? LIMIT 1',
      )
      .get(a.memory.id)!;

    // Re-running the bridge for the same memory with the same shared entity must
    // upsert (bump evidence_count) the existing a<->b edge, not duplicate it.
    buildMemoryCooccurrenceLinks(db, b.memory.id, [shared.entity_id]);

    const among = getLinksAmong(db, [a.memory.id, b.memory.id]).filter(
      (l) => l.source_kind === 'co_occurrence',
    );
    expect(among).toHaveLength(1);
    expect(among[0].evidence_count).toBeGreaterThanOrEqual(2);
  });

  it('does NOT link to invalidated / chunk-child memories', async () => {
    const a = await handleStore(db, embedder, { content: 'React and Docker stack one.' });
    db.prepare("UPDATE memories SET valid_to = datetime('now') WHERE id = ?").run(a.memory.id);

    const b = await handleStore(db, embedder, { content: 'React and Docker stack two.' });

    // a is invalidated, so no co-occurrence edge should connect to it.
    const among = getLinksAmong(db, [a.memory.id, b.memory.id]).filter(
      (l) => l.source_kind === 'co_occurrence',
    );
    expect(among).toHaveLength(0);
  });
});
