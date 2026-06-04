import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import { invalidateMemory } from '../../db/repository.js';
import {
  propagateInvalidation,
  computeBlastRadius,
  clearRevalidation,
  listStaleMemories,
} from '../../graph/propagate.js';

/** Insert a bare valid memory row (no embedding needed for graph propagation). */
function addMemory(db: Database.Database, id: string, title = id): void {
  db.prepare(
    `INSERT INTO memories (id, scope, namespace, title, content, created_at, valid_from)
     VALUES (?, 'project', 'ns', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(id, title, `content of ${id}`);
}

function statusOf(db: Database.Database, id: string): string | null {
  return (
    db
      .prepare<[string], { revalidation_status: string | null }>(
        'SELECT revalidation_status FROM memories WHERE id = ?',
      )
      .get(id)?.revalidation_status ?? null
  );
}

describe('change-propagation (M3.3)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('flags insights derived_from a changed source as stale', () => {
    addMemory(db, 'source');
    addMemory(db, 'insight');
    // insight derived_from source (real reflect.ts edge direction)
    createMemoryLink(db, { sourceId: 'insight', targetId: 'source', relation: 'derived_from' });

    const { flagged } = propagateInvalidation(db, 'source');
    expect(flagged).toEqual(['insight']);
    expect(statusOf(db, 'insight')).toBe('stale');
    expect(statusOf(db, 'source')).toBeNull(); // the changed node itself is untouched
  });

  it('does NOT propagate across associative edges (similar_to/co_occurs/links_to)', () => {
    addMemory(db, 'a');
    addMemory(db, 'b');
    createMemoryLink(db, { sourceId: 'b', targetId: 'a', relation: 'similar_to' });
    createMemoryLink(db, { sourceId: 'b', targetId: 'a', relation: 'links_to' });

    const { flagged } = propagateInvalidation(db, 'a');
    expect(flagged).toEqual([]);
    expect(statusOf(db, 'b')).toBeNull();
  });

  it('walks multi-hop dependency chains, bounded by maxDepth', () => {
    addMemory(db, 'root');
    addMemory(db, 'd1');
    addMemory(db, 'd2');
    addMemory(db, 'd3');
    createMemoryLink(db, { sourceId: 'd1', targetId: 'root', relation: 'derived_from' });
    createMemoryLink(db, { sourceId: 'd2', targetId: 'd1', relation: 'derived_from' });
    createMemoryLink(db, { sourceId: 'd3', targetId: 'd2', relation: 'derived_from' });

    const full = computeBlastRadius(db, 'root');
    expect(full.map((n) => n.id).sort()).toEqual(['d1', 'd2', 'd3']);
    expect(full.find((n) => n.id === 'd1')!.depth).toBe(1);
    expect(full.find((n) => n.id === 'd3')!.depth).toBe(3);

    const shallow = computeBlastRadius(db, 'root', { maxDepth: 1 });
    expect(shallow.map((n) => n.id)).toEqual(['d1']);
  });

  it('is cycle-safe', () => {
    addMemory(db, 'x');
    addMemory(db, 'y');
    createMemoryLink(db, { sourceId: 'y', targetId: 'x', relation: 'derived_from' });
    createMemoryLink(db, { sourceId: 'x', targetId: 'y', relation: 'derived_from' });
    // Should terminate and flag both the other node, not infinite-loop.
    const { flagged } = propagateInvalidation(db, 'x');
    expect(flagged).toEqual(['y']);
  });

  it('blast_radius is a pure dry-run — mutates nothing', () => {
    addMemory(db, 'src');
    addMemory(db, 'dep');
    createMemoryLink(db, { sourceId: 'dep', targetId: 'src', relation: 'derived_from' });

    const preview = computeBlastRadius(db, 'src');
    expect(preview.map((n) => n.id)).toEqual(['dep']);
    expect(statusOf(db, 'dep')).toBeNull(); // NOT flagged by the dry-run
  });

  it('skips already-retired dependents', () => {
    addMemory(db, 's');
    addMemory(db, 'retired');
    createMemoryLink(db, { sourceId: 'retired', targetId: 's', relation: 'derived_from' });
    invalidateMemory(db, 'retired'); // tombstone the dependent

    const { flagged } = propagateInvalidation(db, 's');
    expect(flagged).toEqual([]); // a tombstoned dependent is not flagged
  });

  it('clearRevalidation un-flags and listStaleMemories reflects it', () => {
    addMemory(db, 'srcc');
    addMemory(db, 'depc');
    createMemoryLink(db, { sourceId: 'depc', targetId: 'srcc', relation: 'derived_from' });
    propagateInvalidation(db, 'srcc');

    expect(listStaleMemories(db).map((m) => m.id)).toEqual(['depc']);
    expect(clearRevalidation(db, 'depc')).toBe(true);
    expect(statusOf(db, 'depc')).toBeNull();
    expect(listStaleMemories(db)).toHaveLength(0);
  });

  it('is idempotent — re-flagging a stale row reports no new flags', () => {
    addMemory(db, 's2');
    addMemory(db, 'd');
    createMemoryLink(db, { sourceId: 'd', targetId: 's2', relation: 'derived_from' });
    expect(propagateInvalidation(db, 's2').flagged).toEqual(['d']);
    expect(propagateInvalidation(db, 's2').flagged).toEqual([]); // already stale
  });
});
