/**
 * battle-v7 L3 — change-propagation (M3.3) must fire on memory_condense and on a
 * consolidate dedup-MERGE, not only on update/forget/delete/store-supersede.
 *
 * THE BUG (MEDIUM, correctness): condense.ts and consolidate.ts call the
 * repository updateMemory/deleteMemory DIRECTLY, bypassing the propagateSafe()
 * the handlers (handleUpdate/handleDelete) wrap. So a memory derived_from a
 * source was NOT flagged stale when that source was condensed (content shrank to
 * a summary) or merged away during the dream cycle — leaving a dependent insight
 * silently pointing at content that no longer says what it derived from. Worse,
 * consolidate's deleteMemory FK-cascades the derived_from edge away, so the
 * dependent could never be found afterward.
 *
 * THE FIX: condense calls propagateSafe after a successful condense; the
 * consolidate merge calls propagateSafe on the candidate BEFORE the cascading
 * delete and on the survivor when its content changed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleCondense, handleRestore } from '../../tools/condense.js';
import { handleConsolidate } from '../../tools/consolidate.js';
import { insertMemory } from '../../db/repository.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import { contextualizeForEmbedding } from '../../search/contextual.js';
import type { MemoryRow } from '../../types.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();
beforeEach(() => {
  db = createTestDb();
});

function statusOf(id: string): string | null {
  return (
    db
      .prepare<[string], { revalidation_status: string | null }>(
        'SELECT revalidation_status FROM memories WHERE id = ?',
      )
      .get(id)?.revalidation_status ?? null
  );
}

function baseRow(id: string, content: string, importance = 0.7): MemoryRow {
  return {
    id, scope: 'project', namespace: 'ns', title: id, content,
    document_type: null, source: null, author: null, department: null, tags: null,
    access_level: 'internal', language: 'en', metadata: null,
    parent_id: null, chunk_index: null, version: 1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', expires_at: null,
    access_count: 0, last_accessed_at: null, importance_score: importance, confidence_score: 0.8,
  };
}

describe('change-propagation gaps — L3', () => {
  it('condense flags a derived_from dependent stale', async () => {
    const src = await handleStore(db, embedder, {
      content: 'Deploys use Kubernetes with ArgoCD canary rollouts gated on Prometheus SLO burn-rate alerts and manual approval for prod.',
      title: 'deploy decision',
    });
    const insight = await handleStore(db, embedder, { content: 'Insight: rollouts are SLO-gated.', title: 'insight' });
    createMemoryLink(db, { sourceId: insight.memory.id, targetId: src.memory.id, relation: 'derived_from' });
    expect(statusOf(insight.memory.id)).toBeNull();

    await handleCondense(db, embedder, {
      memories: [{ id: src.memory.id, summary: 'K8s + ArgoCD canary deploy.' }],
      target_level: 'summary',
    });

    expect(statusOf(insight.memory.id)).toBe('stale');

    // And restoring the source un-flags nothing of its own (the dependent stays
    // stale until it is itself revalidated) — restore still works end-to-end.
    const restored = await handleRestore(db, embedder, { id: src.memory.id });
    expect(restored.restored).toBe(true);
  });

  it('a consolidate dedup-merge flags both the merged-away and the survivor dependents stale', async () => {
    // Two near-duplicates sharing the PRIMARY's contextualized vector (the exact
    // setup the dedup probe matches), different content so the merge appends.
    const a = baseRow('mem-a', 'shared deduplication content for the merge stage.', 0.9);
    const ctxVec = await embedder.embed(
      contextualizeForEmbedding(a.content, { title: a.title, document_type: a.document_type, namespace: a.namespace }),
    );
    insertMemory(db, a, ctxVec);
    const b = { ...a, id: 'mem-b', importance_score: 0.4, content: 'a wholly different secondary clause to append.' };
    insertMemory(db, b, ctxVec);

    // Dependents: depA derived_from the survivor, depB derived_from the candidate.
    insertMemory(db, baseRow('dep-a', 'insight derived from mem-a'), await embedder.embed('dep-a'));
    insertMemory(db, baseRow('dep-b', 'insight derived from mem-b'), await embedder.embed('dep-b'));
    createMemoryLink(db, { sourceId: 'dep-a', targetId: 'mem-a', relation: 'derived_from' });
    createMemoryLink(db, { sourceId: 'dep-b', targetId: 'mem-b', relation: 'derived_from' });

    const report = await handleConsolidate(db, embedder, { similarity_threshold: 0.5, max_operations: 10 });
    expect(report.duplicates_merged).toBeGreaterThanOrEqual(1);

    // The candidate (mem-b) was deleted in the merge — its dependent must have been
    // flagged BEFORE the FK cascade dropped the edge.
    expect(statusOf('dep-b')).toBe('stale');
    // The survivor (mem-a) absorbed new content — its dependent is stale too.
    expect(statusOf('dep-a')).toBe('stale');
  });
});
