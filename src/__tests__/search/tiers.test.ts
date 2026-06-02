/**
 * MemGPT-style memory tiers (Task T13).
 *
 * Each memory is classified hot / recall / archival purely from its access
 * recency + frequency (and optional T11 stability). The classifier is PURE and
 * deterministic — tests pass an explicit `now`. A `memory_tiers` read tool
 * surfaces the tier distribution + the hot set.
 *
 * CONSTRAINT: this is strictly ADDITIVE — no schema change, derives from
 * existing columns (access_count, last_accessed_at, created_at, stability), and
 * does not touch search/store/consolidate behavior. These tests pin the
 * classifier rules and the tool's counting + filtering.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { classifyTier } from '../../search/tiers.js';
import { handleMemoryTiers } from '../../tools/tiers.js';

const NOW = new Date('2026-05-29T00:00:00.000Z');

/** ISO string for `days` days before NOW. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

describe('classifyTier', () => {
  it('access_count ≥ HOT threshold → hot regardless of age', () => {
    expect(
      classifyTier(
        { access_count: 12, last_accessed_at: daysAgo(365), created_at: daysAgo(400) },
        NOW,
      ),
    ).toBe('hot');
  });

  it('recently accessed (low access) → hot', () => {
    expect(
      classifyTier(
        { access_count: 1, last_accessed_at: daysAgo(2), created_at: daysAgo(300) },
        NOW,
      ),
    ).toBe('hot');
  });

  it('old + barely accessed → archival', () => {
    expect(
      classifyTier(
        { access_count: 0, last_accessed_at: daysAgo(120), created_at: daysAgo(200) },
        NOW,
      ),
    ).toBe('archival');
  });

  it('old but access_count ≥ ARCHIVAL_MAX_ACCESS → recall (not archival, not hot)', () => {
    expect(
      classifyTier(
        { access_count: 5, last_accessed_at: daysAgo(120), created_at: daysAgo(200) },
        NOW,
      ),
    ).toBe('recall');
  });

  it('middle age + light access → recall', () => {
    expect(
      classifyTier(
        { access_count: 1, last_accessed_at: daysAgo(30), created_at: daysAgo(60) },
        NOW,
      ),
    ).toBe('recall');
  });

  it('null last_accessed_at → falls back to created_at', () => {
    // created 2 days ago → recent → hot
    expect(
      classifyTier(
        { access_count: 0, last_accessed_at: null, created_at: daysAgo(2) },
        NOW,
      ),
    ).toBe('hot');
    // created 120 days ago, never accessed → archival
    expect(
      classifyTier(
        { access_count: 0, last_accessed_at: null, created_at: daysAgo(120) },
        NOW,
      ),
    ).toBe('archival');
  });
});

describe('handleMemoryTiers', () => {
  const embedder = new MockEmbeddingProvider();
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  /** Force a memory's recency/frequency so its tier is deterministic. */
  function setAccess(id: string, accessCount: number, lastAccessedAt: string): void {
    db.prepare('UPDATE memories SET access_count = ?, last_accessed_at = ? WHERE id = ?').run(
      accessCount,
      lastAccessedAt,
      id,
    );
  }

  it('tallies counts across tiers and lists the hot memories', async () => {
    const hotA = await handleStore(db, embedder, { content: 'hot recent fact', title: 'Hot A' });
    const hotB = await handleStore(db, embedder, { content: 'hot frequent fact', title: 'Hot B' });
    const recall = await handleStore(db, embedder, { content: 'middling fact', title: 'Recall' });
    const arch = await handleStore(db, embedder, { content: 'forgotten fact', title: 'Archival' });

    setAccess(hotA.memory.id, 1, daysAgo(1)); // recent → hot
    setAccess(hotB.memory.id, 15, daysAgo(200)); // frequent → hot
    setAccess(recall.memory.id, 1, daysAgo(30)); // middle → recall
    setAccess(arch.memory.id, 0, daysAgo(120)); // old + cold → archival

    const result = handleMemoryTiers(db, { now: NOW });

    expect(result.total).toBe(4);
    expect(result.counts).toEqual({ hot: 2, recall: 1, archival: 1 });

    const hotIds = result.hot_memories.map((m) => m.id);
    expect(hotIds).toContain(hotA.memory.id);
    expect(hotIds).toContain(hotB.memory.id);
    expect(hotIds).not.toContain(recall.memory.id);
    expect(hotIds).not.toContain(arch.memory.id);
    // hot_memories carry titles, most-recently-accessed first
    expect(result.hot_memories[0]).toMatchObject({ id: hotA.memory.id, title: 'Hot A' });
  });

  it('filters by scope/namespace and excludes invalidated (valid_to set) memories', async () => {
    const keep = await handleStore(db, embedder, {
      content: 'kept project fact',
      title: 'Keep',
      scope: 'project',
      namespace: 'alpha',
    });
    const other = await handleStore(db, embedder, {
      content: 'other namespace fact',
      title: 'Other',
      scope: 'project',
      namespace: 'beta',
    });
    const invalidated = await handleStore(db, embedder, {
      content: 'retired project fact',
      title: 'Invalidated',
      scope: 'project',
      namespace: 'alpha',
    });

    setAccess(keep.memory.id, 1, daysAgo(1));
    setAccess(other.memory.id, 1, daysAgo(1));
    setAccess(invalidated.memory.id, 1, daysAgo(1));
    // Bi-temporal invalidation: mark as no longer currently valid.
    db.prepare("UPDATE memories SET valid_to = ? WHERE id = ?").run(daysAgo(0), invalidated.memory.id);

    const result = handleMemoryTiers(db, { scope: 'project', namespace: 'alpha', now: NOW });

    // Only `keep` survives the scope/namespace + bi-temporal filter.
    expect(result.total).toBe(1);
    expect(result.counts).toEqual({ hot: 1, recall: 0, archival: 0 });
    expect(result.hot_memories.map((m) => m.id)).toEqual([keep.memory.id]);
  });
});
