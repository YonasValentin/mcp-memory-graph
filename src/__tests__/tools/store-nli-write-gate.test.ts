/**
 * R3 — self-correcting NLI write-gate on the DEFAULT store path.
 *
 * The HIGH correctness bug (BATTLE-PLAN §2 #6): "X uses port 3000" then "X does
 * NOT use port 3000" was classified a duplicate / NOOP (or a silent second
 * "current" fact) and the correction was dropped — because the NLI contradiction
 * check only ran when BOTH a classifier was injected AND on_conflict==='supersede'.
 * No default integration sets on_conflict, so the gate never fired in practice.
 *
 * Post-fix: whenever an NLI classifier is available, it runs over the near-dup
 * shortlist on EVERY store (regardless of on_conflict). A detected contradiction
 * is never a duplicate/NOOP — both facts are retained and the superseded one is
 * bi-temporally invalidated, with the contradiction recorded in memory_conflicts.
 *
 * The classifier is a DETERMINISTIC stub (no model download), mirroring the
 * existing graph/contradiction.test.ts pattern.
 */
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import type { NliClassifier } from '../../graph/contradiction.js';
import type { EmbeddingProvider } from '../../types.js';

/**
 * Deterministic NLI stub — no model. Flags the pair a 'contradiction'
 * (score 0.95) when the hypothesis contains the literal marker `NOT`; otherwise
 * 'neutral'. Premise is ignored, so each test controls exactly which pair fires.
 */
class StubNli implements NliClassifier {
  calls = 0;
  async classify(_premise: string, hypothesis: string) {
    this.calls++;
    return hypothesis.includes('NOT')
      ? { label: 'contradiction' as const, score: 0.95 }
      : { label: 'neutral' as const, score: 0.1 };
  }
}

/**
 * Places PREMISE and HYPOTHESIS exactly 0.45 L2 apart (inside the NLI shortlist
 * window ≤ 0.7 but outside the overlap heuristic's 0.4 break) and every other
 * text on a far axis — exactly the gap the NLI gate is meant to close.
 */
class ProximityEmbedder implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly modelName = 'proximity-test';
  async initialize(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    if (text.includes('PREMISE')) {
      v[0] = 1;
    } else if (text.includes('HYPOTHESIS')) {
      v[0] = 0.89875;
      v[1] = 0.43846;
    } else {
      v[2] = 1;
    }
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

function validToOf(db: Database.Database, id: string): string | null {
  return (
    db
      .prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?')
      .get(id)?.valid_to ?? null
  );
}
function memCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
}
function conflictCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as c FROM memory_conflicts').get() as { c: number }).c;
}

describe('handleStore — NLI write-gate on the DEFAULT (on_conflict=add) path', () => {
  it('canonical regression: fact then its negation is NOT a duplicate/NOOP; contradiction recorded, both retained', async () => {
    const db = createTestDb();
    const embedder = new ProximityEmbedder();
    const nli = new StubNli();

    // Store the original fact (default on_conflict, NLI present).
    const e = await handleStore(
      db,
      embedder,
      { content: 'PREMISE: The API uses port 3000' },
      nli,
    );
    expect(validToOf(db, e.memory.id)).toBeNull(); // currently valid

    const before = memCount(db);

    // Store the NEGATION with the DEFAULT on_conflict (no supersede) + the stub.
    // This is the exact scenario that previously dropped the correction.
    const n = await handleStore(
      db,
      embedder,
      { content: 'HYPOTHESIS: The API does NOT use port 3000 — it uses 8080' },
      nli,
    );

    // NOT classified a duplicate / NOOP — the correction is retained.
    expect(n.stored).toBe(true);
    expect(n.operation).toBe('DELETE');
    expect(memCount(db)).toBe(before + 1); // both facts kept (new one added)

    // The superseded (contradicted) fact is bi-temporally invalidated, not deleted.
    expect(validToOf(db, e.memory.id)).not.toBeNull();
    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get(e.memory.id)).toBeTruthy();

    // Contradiction recorded so the conflict is auditable, not silent.
    expect(conflictCount(db)).toBeGreaterThan(0);
    expect(n.operation_reason).toMatch(/contradiction/i);
  });

  it('no-classifier fallback: same default store does NOT invalidate the prior fact', async () => {
    const db = createTestDb();
    const embedder = new ProximityEmbedder();

    const e = await handleStore(db, embedder, { content: 'PREMISE: The API uses port 3000' });
    const n = await handleStore(db, embedder, {
      content: 'HYPOTHESIS: The API does NOT use port 3000 — it uses 8080',
    });

    // Without a classifier the gate cannot fire — the overlap heuristic is blind
    // at this distance, so the old fact stays valid (documented fallback).
    expect(validToOf(db, e.memory.id)).toBeNull();
    expect(n.operation).toBe('ADD');
  });

  it('lazy: classify() is never called when the shortlist is empty (no neighbors)', async () => {
    const db = createTestDb();
    const embedder = new ProximityEmbedder();
    const nli = new StubNli();

    // First store: nothing else in the DB → empty shortlist → NLI must not run.
    await handleStore(db, embedder, { content: 'PREMISE: The API uses port 3000' }, nli);
    expect(nli.calls).toBe(0);
  });

  it('overlap heuristic says "duplicate" but a negation cue differs → contradiction wins, NOT a NOOP', async () => {
    const db = createTestDb();
    // Same vector for both → heuristic vectorSim ≈ 1; the two contents also share
    // almost every significant word (high jaccard) → overlapScore > 0.85 →
    // detectConflicts would emit a `duplicate` and decideWriteOperation a NOOP.
    const collidingEmbedder: EmbeddingProvider = {
      dimensions: 384,
      modelName: 'colliding-test',
      async initialize() {},
      isReady() {
        return true;
      },
      async embed() {
        const v = new Float32Array(384);
        v[0] = 1;
        return v;
      },
      async embedBatch(texts: string[]) {
        const v = new Float32Array(384);
        v[0] = 1;
        return texts.map(() => v);
      },
    };
    const nli = new StubNli();

    const e = await handleStore(
      db,
      collidingEmbedder,
      { content: 'database connection pooling enabled production environment maximum sessions' },
      nli,
    );
    const before = memCount(db);

    const n = await handleStore(
      db,
      collidingEmbedder,
      // Same significant words → heuristic duplicate; but a NOT cue flips meaning.
      { content: 'database connection pooling NOT enabled production environment maximum sessions' },
      nli,
    );

    // The correction is NOT swallowed as a duplicate/NOOP.
    expect(n.stored).toBe(true);
    expect(n.operation).toBe('DELETE');
    expect(memCount(db)).toBe(before + 1);
    // Reported conflict for the prior fact is `contradicted`, never `duplicate`.
    expect(n.conflicts?.some((c) => c.existing_memory_id === e.memory.id)).toBe(true);
    expect(n.conflicts?.every((c) => c.type !== 'duplicate')).toBe(true);
    expect(validToOf(db, e.memory.id)).not.toBeNull();
  });

  it('with classifier but no contradiction (neutral): normal ADD, prior fact stays valid', async () => {
    const db = createTestDb();
    const embedder = new ProximityEmbedder();
    const nli = new StubNli();

    const e = await handleStore(db, embedder, { content: 'PREMISE: The API uses port 3000' }, nli);
    const n = await handleStore(
      db,
      embedder,
      // No NOT marker → StubNli returns neutral for the E/N pair.
      { content: 'HYPOTHESIS: The API also serves metrics on port 9090' },
      nli,
    );

    expect(validToOf(db, e.memory.id)).toBeNull();
    expect(n.operation).toBe('ADD');
  });
});
