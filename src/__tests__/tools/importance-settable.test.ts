import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleUpdate } from '../../tools/update.js';
import { runStructuredQuery } from '../../search/structured-query.js';

const embedder = new MockEmbeddingProvider();

/**
 * importance_score must be settable at write time (persona P2).
 *
 * It was advertised as a memory_store param but the handler always overwrote it
 * with computeContentSignal(content), so governance/criticality could not be
 * assigned and the deterministic `min_importance` structured filter operated on
 * a value the caller couldn't control. Mirrors the existing settable
 * confidence_score. Falls back to the content signal when omitted.
 */
describe('importance_score is settable on store + update (IMPORTANCE-1)', () => {
  it('store honours an explicit importance_score and falls back to computed when omitted', async () => {
    const db = createTestDb();
    const set = await handleStore(db, embedder, { content: 'Board-level decision: incorporate in Delaware', importance_score: 0.95 });
    expect(set.memory.importance_score).toBe(0.95);

    const computed = await handleStore(db, embedder, { content: 'minor passing note' });
    expect(computed.memory.importance_score).not.toBe(0.95);
    expect(typeof computed.memory.importance_score).toBe('number');
  });

  it('update honours an explicit importance_score', async () => {
    const db = createTestDb();
    const m = await handleStore(db, embedder, { content: 'reclassify me later', importance_score: 0.9 });
    const updated = await handleUpdate(db, embedder, { id: m.memory.id, importance_score: 0.2 });
    expect(updated?.importance_score).toBe(0.2);
  });

  it('min_importance structured filter respects the assigned value', async () => {
    const db = createTestDb();
    await handleStore(db, embedder, { content: 'critical', importance_score: 0.9, namespace: 'imp' });
    await handleStore(db, embedder, { content: 'trivial', importance_score: 0.1, namespace: 'imp' });
    const res = runStructuredQuery(db, { filter: { namespace: 'imp', min_importance: 0.8 } });
    expect(res.total).toBe(1);
  });
});
