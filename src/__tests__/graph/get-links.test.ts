import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleGet } from '../../tools/get.js';
import { createMemoryLink } from '../../graph/memory-links.js';

async function store(db: ReturnType<typeof createTestDb>, content: string) {
  return (await handleStore(db, new MockEmbeddingProvider(), { content })).memory;
}

describe('memory_get surfaces graph edges (Pillar 1, slice 4)', () => {
  it('returns outgoing links and backlinks for a memory', async () => {
    const db = createTestDb();
    const a = await store(db, 'Source note about auth');
    const b = await store(db, 'Target note about jwt');

    createMemoryLink(db, {
      sourceId: a.id,
      targetId: b.id,
      relation: 'links_to',
      confidence: 'EXTRACTED',
      confidenceScore: 1,
      sourceKind: 'wikilink',
    });

    const target = handleGet(db, { id: b.id, include_chunks: false });
    expect(target?.backlinks.some((l) => l.source_memory_id === a.id)).toBe(true);

    const source = handleGet(db, { id: a.id, include_chunks: false });
    expect(source?.links.some((l) => l.target_memory_id === b.id)).toBe(true);
  });

  it('returns empty link arrays for an unconnected memory', async () => {
    const db = createTestDb();
    const m = await store(db, 'Lonely note');
    const got = handleGet(db, { id: m.id, include_chunks: false });
    expect(got?.links).toEqual([]);
    expect(got?.backlinks).toEqual([]);
  });
});
