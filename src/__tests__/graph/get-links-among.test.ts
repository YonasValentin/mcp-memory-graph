import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { createMemoryLink, getLinksAmong } from '../../graph/memory-links.js';

async function store(db: ReturnType<typeof createTestDb>, content: string) {
  return (await handleStore(db, new MockEmbeddingProvider(), { content })).memory;
}

describe('getLinksAmong is bound-parameter safe (GRAPH-1)', () => {
  it('does not throw on an id set larger than SQLite\'s 32k variable limit', () => {
    const db = createTestDb();
    // 20k ids would bind 40k params in the old 2x-IN query → "too many SQL
    // variables". After chunking it must return [] without throwing.
    const manyIds = Array.from({ length: 20_000 }, (_, i) => `nonexistent-${i}`);
    expect(() => getLinksAmong(db, manyIds)).not.toThrow();
    expect(getLinksAmong(db, manyIds)).toEqual([]);
  });

  it('stitches edges across chunks and excludes edges pointing outside the set', async () => {
    const db = createTestDb();
    const a = await store(db, 'A');
    const b = await store(db, 'B');
    const c = await store(db, 'C');
    const outside = await store(db, 'Outside');

    // a->b (high), b->c (low): both internal but land in different source chunks
    // when chunkSize=1. a->outside must be excluded (target not in the set).
    createMemoryLink(db, { sourceId: a.id, targetId: b.id, relation: 'links_to', confidence: 'EXTRACTED', confidenceScore: 0.9, sourceKind: 'wikilink' });
    createMemoryLink(db, { sourceId: b.id, targetId: c.id, relation: 'links_to', confidence: 'INFERRED', confidenceScore: 0.3, sourceKind: 'similarity' });
    createMemoryLink(db, { sourceId: a.id, targetId: outside.id, relation: 'links_to', confidence: 'EXTRACTED', confidenceScore: 1, sourceKind: 'wikilink' });

    const set = [a.id, b.id, c.id];
    // Force multi-chunk traversal with chunkSize=1 to prove batch stitching.
    const links = getLinksAmong(db, set, 1);

    const pairs = links.map((l) => `${l.source_memory_id}->${l.target_memory_id}`);
    expect(pairs).toContain(`${a.id}->${b.id}`);
    expect(pairs).toContain(`${b.id}->${c.id}`);
    expect(pairs).not.toContain(`${a.id}->${outside.id}`);
    expect(links).toHaveLength(2);
    // Global ordering preserved across chunks: confidence_score DESC.
    expect(links[0].confidence_score).toBeGreaterThanOrEqual(links[1].confidence_score);
  });
});
