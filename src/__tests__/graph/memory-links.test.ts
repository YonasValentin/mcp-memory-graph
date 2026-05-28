import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import {
  createMemoryLink,
  getOutgoingLinks,
  getBacklinks,
} from '../../graph/memory-links.js';

async function store(db: ReturnType<typeof createTestDb>, content: string) {
  const e = new MockEmbeddingProvider();
  return (await handleStore(db, e, { content })).memory;
}

describe('memory_links storage (Pillar 1, slice 2)', () => {
  it('stores a directed memory-to-memory link, readable as outgoing + backlink', async () => {
    const db = createTestDb();
    const a = await store(db, 'Note A about auth');
    const b = await store(db, 'Note B about jwt');

    createMemoryLink(db, {
      sourceId: a.id,
      targetId: b.id,
      relation: 'links_to',
      confidence: 'EXTRACTED',
      confidenceScore: 1,
      sourceKind: 'wikilink',
    });

    expect(getOutgoingLinks(db, a.id).map((l) => l.target_memory_id)).toContain(b.id);
    expect(getBacklinks(db, b.id).map((l) => l.source_memory_id)).toContain(a.id);
  });

  it('carries the confidence tag through to the stored row', async () => {
    const db = createTestDb();
    const a = await store(db, 'Note C');
    const b = await store(db, 'Note D');

    createMemoryLink(db, {
      sourceId: a.id,
      targetId: b.id,
      relation: 'links_to',
      confidence: 'EXTRACTED',
      confidenceScore: 1,
      sourceKind: 'wikilink',
    });

    const link = getOutgoingLinks(db, a.id)[0];
    expect(link.confidence).toBe('EXTRACTED');
    expect(link.source_kind).toBe('wikilink');
  });

  it('bumps evidence_count instead of duplicating on the same (source,target,relation)', async () => {
    const db = createTestDb();
    const a = await store(db, 'Note E');
    const b = await store(db, 'Note F');

    createMemoryLink(db, { sourceId: a.id, targetId: b.id, relation: 'links_to', confidence: 'INFERRED', confidenceScore: 0.6, sourceKind: 'similarity' });
    createMemoryLink(db, { sourceId: a.id, targetId: b.id, relation: 'links_to', confidence: 'INFERRED', confidenceScore: 0.6, sourceKind: 'similarity' });

    const rows = getOutgoingLinks(db, a.id);
    expect(rows.length).toBe(1);
    expect(rows[0].evidence_count).toBe(2);
  });
});
