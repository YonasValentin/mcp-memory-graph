import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../../testing/test-db.js';
import { createMemoryLink } from '../../graph/memory-links.js';
import { propagateInvalidation } from '../../graph/propagate.js';
import { handleInsights } from '../../tools/insights.js';
import { handleHealth } from '../../tools/health.js';
import { handleRevalidate } from '../../tools/revalidate.js';

function addMemory(
  db: Database.Database,
  id: string,
  opts: { document_type?: string; title?: string; createdAt?: string } = {},
): void {
  const created = opts.createdAt ?? '2026-06-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO memories (id, scope, namespace, title, content, document_type, created_at, updated_at, valid_from)
     VALUES (?, 'project', 'ns', ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.title ?? id, `content of ${id}`, opts.document_type ?? null, created, created, created);
}

function addConflict(db: Database.Database, oldId: string, newId: string, resolved = false): void {
  db.prepare(
    `INSERT INTO memory_conflicts (id, old_memory_id, new_memory_id, conflict_type, resolved_at)
     VALUES (?, ?, ?, 'superseded', ?)`,
  ).run(randomUUID(), oldId, newId, resolved ? '2026-06-02T00:00:00.000Z' : null);
}

describe('memory_insights (M3.2)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('surfaces unresolved conflicts (and skips resolved ones)', () => {
    addMemory(db, 'a');
    addMemory(db, 'b');
    addMemory(db, 'c');
    addConflict(db, 'a', 'b', false);
    addConflict(db, 'a', 'c', true); // resolved → not surfaced as unresolved
    const res = handleInsights(db, {});
    const unresolved = res.insights.filter((i) => i.type === 'unresolved_conflict');
    expect(unresolved).toHaveLength(1);
  });

  it('surfaces stale (needs_revalidation) memories', () => {
    addMemory(db, 'src');
    addMemory(db, 'dep');
    createMemoryLink(db, { sourceId: 'dep', targetId: 'src', relation: 'derived_from' });
    propagateInvalidation(db, 'src');
    const res = handleInsights(db, {});
    const stale = res.insights.filter((i) => i.type === 'stale');
    expect(stale).toHaveLength(1);
    expect(stale[0].memory_id).toBe('dep');
  });

  it('surfaces most-contradicted memories (>=2 conflicts)', () => {
    addMemory(db, 'hot');
    addMemory(db, 'x');
    addMemory(db, 'y');
    addConflict(db, 'hot', 'x');
    addConflict(db, 'hot', 'y');
    const res = handleInsights(db, {});
    const mc = res.insights.filter((i) => i.type === 'most_contradicted');
    expect(mc.some((i) => i.memory_id === 'hot')).toBe(true);
  });

  it('surfaces decisions with no supporting evidence', () => {
    addMemory(db, 'd1', { document_type: 'decision' });
    addMemory(db, 'd2', { document_type: 'decision' });
    addMemory(db, 'fact');
    createMemoryLink(db, { sourceId: 'd2', targetId: 'fact', relation: 'derived_from' }); // d2 has evidence
    const res = handleInsights(db, {});
    const noEv = res.insights.filter((i) => i.type === 'no_evidence_decision');
    expect(noEv.map((i) => i.memory_id)).toEqual(['d1']); // only d1 lacks evidence
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) addMemory(db, `dec${i}`, { document_type: 'decision' });
    const res = handleInsights(db, { limit: 2 });
    expect(res.insights).toHaveLength(2);
    expect(res.count).toBe(2);
  });
});

describe('memory_health (M3.2)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it('reports ok on a clean store', () => {
    addMemory(db, 'm1');
    const h = handleHealth(db, {});
    expect(h.status).toBe('ok');
    expect(h.memories.live).toBe(1);
    expect(h.attention_reasons).toEqual([]);
  });

  it('flips to attention with unresolved conflicts + stale + aging buckets', () => {
    addMemory(db, 'old', { createdAt: '2020-01-01T00:00:00.000Z' }); // > 180d
    addMemory(db, 'src');
    addMemory(db, 'dep');
    createMemoryLink(db, { sourceId: 'dep', targetId: 'src', relation: 'derived_from' });
    propagateInvalidation(db, 'src');
    addConflict(db, 'old', 'src', false);

    const h = handleHealth(db, {});
    expect(h.status).toBe('attention');
    expect(h.memories.stale).toBe(1);
    expect(h.memories.aging_180d).toBeGreaterThanOrEqual(1);
    expect(h.conflicts.unresolved).toBe(1);
    expect(h.attention_reasons.length).toBeGreaterThan(0);
  });
});

describe('memory_revalidate (M3.3)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    addMemory(db, 'source');
    addMemory(db, 'insight');
    createMemoryLink(db, { sourceId: 'insight', targetId: 'source', relation: 'derived_from' });
  });
  afterEach(() => db.close());

  it('preview is a dry-run that mutates nothing', () => {
    const res = handleRevalidate(db, { action: 'preview', id: 'source' });
    expect(res.blast_radius?.map((n) => n.id)).toEqual(['insight']);
    expect(handleRevalidate(db, { action: 'list' }).stale).toHaveLength(0); // nothing flagged
  });

  it('list reflects propagated staleness; confirm clears it', () => {
    propagateInvalidation(db, 'source');
    expect(handleRevalidate(db, { action: 'list' }).stale?.map((m) => m.id)).toEqual(['insight']);
    expect(handleRevalidate(db, { action: 'confirm', id: 'insight' }).confirmed).toBe(true);
    expect(handleRevalidate(db, { action: 'list' }).stale).toHaveLength(0);
  });

  it('preview/confirm require an id', () => {
    expect(() => handleRevalidate(db, { action: 'preview' })).toThrow();
    expect(() => handleRevalidate(db, { action: 'confirm' })).toThrow();
  });
});
