/**
 * T9 — mem0-style write gate.
 *
 * `decideWriteOperation` is a PURE classifier that turns conflict-detection
 * output + an `on_conflict` policy into one of ADD / UPDATE / DELETE / NOOP.
 * The default policy ('add') can only ever yield NOOP or ADD, which keeps
 * today's store behaviour byte-identical (UPDATE/DELETE are strictly opt-in).
 *
 * The pure-function tests below cover every branch deterministically with no
 * embedder. The integration tests drive the same branches through
 * `handleStore` using a stub embedder that pins the vector distance so the
 * keyword-overlap term alone decides which conflict band a candidate lands in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { decideWriteOperation } from '../../graph/write-gate.js';
import type { ConflictResult } from '../../graph/conflict-resolver.js';
import type { EmbeddingProvider } from '../../types.js';

// ── pure helpers ───────────────────────────────────────────────────────────

function conflict(type: ConflictResult['type'], id = 'mem-x'): ConflictResult {
  return { type, existing_memory_id: id, overlap_score: 0.8, description: 't' };
}

describe('decideWriteOperation — pure classifier', () => {
  it('1. duplicate present → NOOP even when onConflict is update', () => {
    const d = decideWriteOperation([conflict('duplicate', 'dup-1')], 'update');
    expect(d.op).toBe('NOOP');
    expect(d.targetId).toBe('dup-1');
  });

  it('1b. duplicate present → NOOP even when onConflict is supersede', () => {
    const d = decideWriteOperation(
      [conflict('duplicate', 'dup-1'), conflict('contradicted', 'c-1')],
      'supersede',
    );
    expect(d.op).toBe('NOOP');
    expect(d.targetId).toBe('dup-1');
  });

  it('2. onConflict add + superseded present → ADD (opt-in off)', () => {
    const d = decideWriteOperation([conflict('superseded', 's-1')], 'add');
    expect(d.op).toBe('ADD');
    expect(d.targetId).toBeUndefined();
  });

  it('3. onConflict update + superseded present → UPDATE', () => {
    const d = decideWriteOperation([conflict('superseded', 's-1')], 'update');
    expect(d.op).toBe('UPDATE');
    expect(d.targetId).toBe('s-1');
  });

  it('3b. onConflict update + only contradicted present → ADD (update targets superseded only)', () => {
    const d = decideWriteOperation([conflict('contradicted', 'c-1')], 'update');
    expect(d.op).toBe('ADD');
  });

  it('4. onConflict supersede + contradicted present → DELETE', () => {
    const d = decideWriteOperation([conflict('contradicted', 'c-1')], 'supersede');
    expect(d.op).toBe('DELETE');
    expect(d.targetId).toBe('c-1');
  });

  it('5. onConflict supersede + superseded present → DELETE', () => {
    const d = decideWriteOperation([conflict('superseded', 's-1')], 'supersede');
    expect(d.op).toBe('DELETE');
    expect(d.targetId).toBe('s-1');
  });

  it('6. no conflicts → ADD', () => {
    const d = decideWriteOperation([], 'supersede');
    expect(d.op).toBe('ADD');
    expect(d.targetId).toBeUndefined();
  });
});

// ── integration via handleStore ─────────────────────────────────────────────

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

function memCount(): number {
  return (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
}
function versionCount(id: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) as c FROM memory_versions WHERE memory_id = ?')
      .get(id) as { c: number }
  ).c;
}

describe('handleStore — write gate (default path)', () => {
  it('7. default store of novel content → operation ADD, row exists', async () => {
    const r = await handleStore(db, embedder, { content: 'Novel fact about caching layers.' });
    expect(r.operation).toBe('ADD');
    expect(r.stored).toBe(true);
    expect(memCount()).toBe(1);
  });

  it('8. identical content twice → 2nd is NOOP, only one row', async () => {
    const content = 'We use PostgreSQL for our primary database in production environments.';
    const r1 = await handleStore(db, embedder, { content });
    expect(r1.operation).toBe('ADD');

    const r2 = await handleStore(db, embedder, { content });
    expect(r2.operation).toBe('NOOP');
    expect(r2.stored).toBe(false);
    expect(r2.memory.id).toBe(r1.memory.id);
    expect(memCount()).toBe(1);
  });
});

/**
 * Stub embedder that pins every vector to the same constant → vector distance
 * is ~0 for any candidate, so vectorSim ≈ 1.0 and the keyword-overlap (jaccard)
 * term alone decides the conflict band:
 *   overlapScore = 0.5*1.0 + 0.5*jaccard.
 * Band targets (see conflict-resolver thresholds):
 *   jaccard ∈ (0.5, 0.7]  → score ∈ (0.75, 0.85]  → 'superseded'
 *   jaccard ∈ (0.3, 0.5]  → score ∈ (0.65, 0.75]  → 'contradicted'
 */
class ConstantEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly modelName = 'constant-test';
  async initialize(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  async embed(): Promise<Float32Array> {
    return new Float32Array(this.dimensions).fill(0.05);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dimensions).fill(0.05));
  }
}

describe('handleStore — UPDATE / DELETE bands (deterministic)', () => {
  const constEmbedder = new ConstantEmbeddingProvider();

  // Significant words (len>=4, non-stopword) drive jaccard.
  // Existing significant set: {alpha, bravo, charlie, delta} (4 words)
  const existingContent = 'alpha bravo charlie delta';

  // SUPERSEDED band: share 3 of existing's 4 + 1 new = intersection 3, union 5
  // → jaccard 0.6 ∈ (0.5,0.7] → superseded.
  const supersededContent = 'alpha bravo charlie zulu';

  // CONTRADICTED band: share 2 of existing's 4 + 2 new = intersection 2, union 6
  // → jaccard 0.333 ∈ (0.3,0.5] → contradicted.
  const contradictedContent = 'alpha bravo yankee zulu';

  it('9a. UPDATE merges into target, no new row, version bumped, version row added', async () => {
    const seed = await handleStore(db, constEmbedder, { content: existingContent });
    expect(seed.operation).toBe('ADD');
    const targetId = seed.memory.id;
    const versionsBefore = versionCount(targetId);

    const r = await handleStore(db, constEmbedder, {
      content: supersededContent,
      on_conflict: 'update',
    });

    expect(r.operation).toBe('UPDATE');
    expect(r.memory.id).toBe(targetId); // same row, not a new one
    expect(memCount()).toBe(1); // no new row inserted
    // append-merge: target now contains BOTH texts
    expect(r.memory.content).toContain(existingContent);
    expect(r.memory.content).toContain(supersededContent);
    expect(r.memory.version).toBe(seed.memory.version + 1); // version bumped
    expect(versionCount(targetId)).toBe(versionsBefore + 1); // history row added
  });

  it('9b. DELETE invalidates the old row (still present) and inserts the new one', async () => {
    const seed = await handleStore(db, constEmbedder, { content: existingContent });
    const oldId = seed.memory.id;

    const r = await handleStore(db, constEmbedder, {
      content: contradictedContent,
      on_conflict: 'supersede',
    });

    expect(r.operation).toBe('DELETE');
    expect(r.stored).toBe(true);
    expect(r.memory.id).not.toBe(oldId); // new current row
    expect(memCount()).toBe(2); // old retired but NOT hard-deleted

    const oldRow = db
      .prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?')
      .get(oldId);
    expect(oldRow?.valid_to).not.toBeNull(); // invalidated point-in-time
  });

  it('9c. default policy leaves superseded-band store as a plain ADD', async () => {
    await handleStore(db, constEmbedder, { content: existingContent });
    const r = await handleStore(db, constEmbedder, { content: supersededContent });
    expect(r.operation).toBe('ADD');
    expect(memCount()).toBe(2);
  });
});
