import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';

describe('entity co-occurrence edges (Pillar 1, slice 1)', () => {
  it('creates co_occurs edges between entities found in the same memory', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    // Content yields multiple entities: React (tool), Docker (tool), AuthService (pattern).
    await handleStore(db, embedder, {
      content: 'We use React with Docker inside the AuthService.',
    });

    const edges = db
      .prepare("SELECT * FROM entity_relationships WHERE type = 'co_occurs'")
      .all();

    expect(edges.length).toBeGreaterThan(0);
  });

  it('bumps evidence_count when the same pair co-occurs again', async () => {
    const db = createTestDb();
    const embedder = new MockEmbeddingProvider();

    await handleStore(db, embedder, { content: 'React and Docker power the stack.' });
    await handleStore(db, embedder, { content: 'Again: React plus Docker in production.' });

    const edge = db
      .prepare(
        `SELECT er.evidence_count AS ec
           FROM entity_relationships er
           JOIN entities a ON a.id = er.source_entity_id
           JOIN entities b ON b.id = er.target_entity_id
          WHERE er.type = 'co_occurs'
            AND (a.normalized_name = 'react' OR b.normalized_name = 'react')
            AND (a.normalized_name = 'docker' OR b.normalized_name = 'docker')`,
      )
      .get() as { ec: number } | undefined;

    expect(edge).toBeDefined();
    expect(edge!.ec).toBeGreaterThanOrEqual(2);
  });
});
