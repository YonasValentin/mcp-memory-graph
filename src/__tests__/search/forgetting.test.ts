/**
 * Spaced-repetition forgetting curve (Task T11).
 *
 * Every memory carries a `stability` (default 1.0) that grows on each access.
 * retention = e^(-Δt/stability) is exposed two opt-in ways:
 *   (a) a ranking multiplier via the new `'forgetting'` decay type, and
 *   (b) a prune signal via consolidate's optional `forgetting_floor`.
 *
 * CONSTRAINT: both are OPT-IN, default OFF, so the existing temporal/consolidate
 * behavior stays identical. These tests pin both the new behavior and the
 * default-unchanged invariant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleGet } from '../../tools/get.js';
import { handleConsolidate } from '../../tools/consolidate.js';
import { computeRetention, applyTemporalDecay } from '../../search/temporal.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

function stabilityOf(id: string): number {
  const row = db
    .prepare<[string], { stability: number }>('SELECT stability FROM memories WHERE id = ?')
    .get(id);
  return row!.stability;
}

describe('computeRetention', () => {
  it('returns 1.0 at age 0', () => {
    expect(computeRetention(0, 1)).toBeCloseTo(1.0, 10);
    expect(computeRetention(0, 50)).toBeCloseTo(1.0, 10);
  });

  it('decreases as age grows (monotonic) and stays within (0,1]', () => {
    const r1 = computeRetention(1, 5);
    const r10 = computeRetention(10, 5);
    const r100 = computeRetention(100, 5);
    expect(r1).toBeGreaterThan(r10);
    expect(r10).toBeGreaterThan(r100);
    expect(r1).toBeLessThanOrEqual(1);
    expect(r100).toBeGreaterThan(0);
  });

  it('higher stability → higher retention at the same age', () => {
    const low = computeRetention(10, 2);
    const high = computeRetention(10, 20);
    expect(high).toBeGreaterThan(low);
  });
});

describe("applyTemporalDecay — type 'forgetting'", () => {
  // applyTemporalDecay reads the wall clock (`new Date()`) on EVERY call to
  // compute age. Tests here build `createdAt` from one clock read and then
  // compare results across separate calls — each doing its own read. Under
  // parallel-run CPU load two adjacent reads can straddle a millisecond
  // boundary, shifting the computed age by ~1e-8 days and the result in its
  // ~12th digit, which flipped the strict `.toBe()` equality below (passed
  // isolated/fast, flaked under load). Pin the clock so every read in this block
  // returns the same instant — the assertions then test the decay invariants,
  // not clock jitter.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses stability: higher stability → less decay', () => {
    const createdAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const low = applyTemporalDecay(1, createdAt, { type: 'forgetting' }, undefined, 2);
    const high = applyTemporalDecay(1, createdAt, { type: 'forgetting' }, undefined, 50);
    expect(high).toBeGreaterThan(low);
    expect(low).toBeGreaterThan(0);
    expect(high).toBeLessThanOrEqual(1);
  });

  it('defaults stability to 1 when omitted', () => {
    const createdAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const got = applyTemporalDecay(1, createdAt, { type: 'forgetting' });
    expect(got).toBeCloseTo(computeRetention(5, 1), 5);
  });

  it("leaves the other decay types unchanged", () => {
    const createdAt = new Date(Date.now() - 10 * 86_400_000).toISOString();
    // 'none' is identity regardless of stability arg.
    expect(applyTemporalDecay(0.8, createdAt, { type: 'none' }, undefined, 99)).toBe(0.8);
    // 'exponential' / 'linear' must ignore the stability arg entirely.
    const expWith = applyTemporalDecay(1, createdAt, { type: 'exponential' }, undefined, 99);
    const expWithout = applyTemporalDecay(1, createdAt, { type: 'exponential' });
    expect(expWith).toBe(expWithout);
  });
});

describe('migration v7 — stability column', () => {
  it('fresh DB has a stability column defaulting to 1.0', () => {
    const cols = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('stability');
  });

  it('a stored memory has stability 1.0', async () => {
    const { memory } = await handleStore(db, embedder, { content: 'a stability fact' });
    expect(stabilityOf(memory.id)).toBe(1.0);
  });
});

describe('access reinforcement', () => {
  it('bumps stability by the increment on each access', async () => {
    const { memory } = await handleStore(db, embedder, { content: 'reinforce me' });
    const before = stabilityOf(memory.id);

    const N = 3;
    for (let i = 0; i < N; i++) {
      handleGet(db, { id: memory.id, include_chunks: false });
    }

    const after = stabilityOf(memory.id);
    // N accesses × 0.5 increment.
    expect(after).toBeCloseTo(before + N * 0.5, 10);
  });
});

describe('consolidate — opt-in forgetting_floor prune', () => {
  async function seedOld(content: string): Promise<string> {
    const { memory } = await handleStore(db, embedder, { content });
    return memory.id;
  }

  function makeStaleLowStability(id: string): void {
    // Old + last accessed long ago + low stability + low access_count.
    db.prepare(
      "UPDATE memories SET created_at = datetime('now','-200 days'), last_accessed_at = datetime('now','-200 days'), stability = 1.0, access_count = 0, importance_score = 0.1 WHERE id = ?",
    ).run(id);
  }

  function makeWellReinforced(id: string): void {
    // Old but frequently accessed → high stability → high retention → survives.
    db.prepare(
      "UPDATE memories SET created_at = datetime('now','-200 days'), last_accessed_at = datetime('now','-200 days'), stability = 500.0, access_count = 50 WHERE id = ?",
    ).run(id);
  }

  it('prunes an old, low-stability, low-access memory when forgetting_floor is set', async () => {
    const doomed = await seedOld('ephemeral note nobody revisits');
    makeStaleLowStability(doomed);

    const report = await handleConsolidate(db, embedder, {
      prune_expired: false,
      forgetting_floor: 0.5,
    });

    expect(report.forgetting_pruned).toBeGreaterThanOrEqual(1);
    const stillThere = db
      .prepare<[string], { id: string }>('SELECT id FROM memories WHERE id = ?')
      .get(doomed);
    expect(stillThere).toBeUndefined();
  });

  it('keeps a frequently-accessed (high stability) memory even when forgetting_floor is set', async () => {
    const survivor = await seedOld('canonical fact accessed all the time');
    makeWellReinforced(survivor);

    await handleConsolidate(db, embedder, {
      prune_expired: false,
      forgetting_floor: 0.5,
    });

    const stillThere = db
      .prepare<[string], { id: string }>('SELECT id FROM memories WHERE id = ?')
      .get(survivor);
    expect(stillThere?.id).toBe(survivor);
  });

  it('prunes NOTHING via the forgetting pass when forgetting_floor is undefined (default unchanged)', async () => {
    const doomed = await seedOld('ephemeral note default path');
    makeStaleLowStability(doomed);

    const report = await handleConsolidate(db, embedder, { prune_expired: false });

    expect(report.forgetting_pruned).toBe(0);
    const stillThere = db
      .prepare<[string], { id: string }>('SELECT id FROM memories WHERE id = ?')
      .get(doomed);
    expect(stillThere?.id).toBe(doomed);
  });
});
