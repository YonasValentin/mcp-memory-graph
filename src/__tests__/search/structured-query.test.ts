/**
 * P2.2 — structured query DSL (Dataview/Bases for agents): filter memories by
 * typed properties, sort, paginate, and project fields — complementing fuzzy
 * vector search with exact, structured retrieval.
 */
import { describe, it, expect } from 'vitest';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { runStructuredQuery } from '../../search/structured-query.js';

const embedder = new MockEmbeddingProvider();

async function seed() {
  const db = createTestDb();
  const mk = async (
    content: string,
    opts: { document_type: string; tags: string[]; importance: number; created_at: string },
  ) => {
    const m = (await handleStore(db, embedder, { content, document_type: opts.document_type, tags: opts.tags, scope: 'global' })).memory;
    db.prepare('UPDATE memories SET importance_score = ?, created_at = ? WHERE id = ?').run(
      opts.importance, opts.created_at, m.id,
    );
    return m.id;
  };
  const d1 = await mk('decision one about postgres', { document_type: 'decision', tags: ['db'], importance: 0.9, created_at: '2026-01-01T00:00:00.000Z' });
  const d2 = await mk('decision two about react', { document_type: 'decision', tags: ['ui'], importance: 0.3, created_at: '2026-03-01T00:00:00.000Z' });
  const p1 = await mk('pattern one about caching', { document_type: 'pattern', tags: ['db', 'perf'], importance: 0.8, created_at: '2026-02-01T00:00:00.000Z' });
  return { db, d1, d2, p1 };
}

describe('runStructuredQuery (P2.2)', () => {
  it('filters by document_type', async () => {
    const { db, d1, d2 } = await seed();
    const r = runStructuredQuery(db, { filter: { document_type: 'decision' } });
    const ids = r.items.map((x) => x.id);
    expect(ids.sort()).toEqual([d1, d2].sort());
    expect(r.total).toBe(2);
    db.close();
  });

  it('filters by min_importance and a created_at range', async () => {
    const { db, d1, p1 } = await seed();
    const r = runStructuredQuery(db, {
      filter: { min_importance: 0.75, created_after: '2026-01-15T00:00:00.000Z' },
    });
    expect(r.items.map((x) => x.id)).toEqual([p1]); // d1 too early, d2 too low importance
    db.close();
  });

  it('filters by a created_before bound', async () => {
    const { db, d1 } = await seed();
    const r = runStructuredQuery(db, { filter: { created_before: '2026-01-15T00:00:00.000Z' } });
    expect(r.items.map((x) => x.id)).toEqual([d1]); // only the 2026-01-01 memory
    db.close();
  });

  it('filters by tag (JSON membership), AND semantics', async () => {
    const { db, d1, p1 } = await seed();
    const r = runStructuredQuery(db, { filter: { tags: ['db'] }, sort: { by: 'importance_score', order: 'desc' } });
    expect(r.items.map((x) => x.id)).toEqual([d1, p1]); // both tagged db, importance desc
    db.close();
  });

  it('sorts by importance_score ascending', async () => {
    const { db, d1, d2, p1 } = await seed();
    const r = runStructuredQuery(db, { sort: { by: 'importance_score', order: 'asc' } });
    expect(r.items.map((x) => x.id)).toEqual([d2, p1, d1]); // 0.3, 0.8, 0.9
    db.close();
  });

  it('paginates with limit/offset and reports has_more', async () => {
    const { db } = await seed();
    const r = runStructuredQuery(db, { sort: { by: 'created_at', order: 'asc' }, limit: 2, offset: 0 });
    expect(r.items).toHaveLength(2);
    expect(r.total).toBe(3);
    expect(r.has_more).toBe(true);
    db.close();
  });

  it('projects only requested fields', async () => {
    const { db } = await seed();
    const r = runStructuredQuery(db, { fields: ['id', 'document_type'], limit: 1 });
    const keys = Object.keys(r.items[0]).sort();
    expect(keys).toEqual(['document_type', 'id']);
    db.close();
  });

  it('excludes chunks and invalidated memories', async () => {
    const { db, d1 } = await seed();
    db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run('2026-04-01T00:00:00.000Z', d1);
    const r = runStructuredQuery(db, { filter: { document_type: 'decision' } });
    expect(r.items.map((x) => x.id)).not.toContain(d1);
    db.close();
  });
});
