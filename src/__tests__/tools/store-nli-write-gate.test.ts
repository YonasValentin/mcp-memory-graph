/**
 * R3 — self-correcting NLI write-gate, honouring the `on_conflict` contract.
 *
 * DETECTION runs on EVERY store whenever an NLI classifier is available: the gate
 * reads each near-neighbour as a premise vs. the new content as hypothesis and
 * catches real logical contradictions (negations) the cheap overlap heuristic is
 * blind to. That much is policy-independent.
 *
 * ACTING on a detected contradiction is NOT policy-independent. The documented
 * `on_conflict` contract is: "add" (default) inserts as new (an exact duplicate is
 * skipped) and NEVER retires an existing fact; "supersede" retires the conflicting
 * match. So a detected contradiction:
 *   - on the DEFAULT 'add' path → is REPORTED (conflicts + a loud warning) and the
 *     correction is added as new, but BOTH facts stay live. An NLI false positive
 *     (two unrelated notes scoring ~0.60) must never silently retire a memory.
 *   - on the 'supersede' path → bi-temporally retires the contradicted fact
 *     (operation DELETE), the caller having opted into the destructive resolution.
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
  async classify(premise: string, hypothesis: string) {
    this.calls++;
    // Symmetric: a genuine contradiction is a negation pair (exactly ONE side
    // negated), so it fires whichever text is the premise — modelling real NLI
    // symmetry and satisfying the H6 bidirectional gate.
    return premise.includes('NOT') !== hypothesis.includes('NOT')
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

describe('handleStore — NLI write-gate honours on_conflict', () => {
  it('DEFAULT add + contradiction: reported + warned, prior fact NOT retired, correction added anew', async () => {
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
    // This is the exact destructive-retire bug: 'add' must NOT retire the prior
    // fact on an NLI contradiction — it reports + warns and keeps both.
    const n = await handleStore(
      db,
      embedder,
      { content: 'HYPOTHESIS: The API does NOT use port 3000 — it uses 8080' },
      nli,
    );

    // The correction is added as new, NOT collapsed to a duplicate/NOOP…
    expect(n.stored).toBe(true);
    expect(n.operation).toBe('ADD');
    expect(memCount(db)).toBe(before + 1);

    // …and the prior fact is LEFT LIVE (valid_to still NULL) — no silent retire.
    expect(validToOf(db, e.memory.id)).toBeNull();

    // The contradiction is still surfaced: recorded, reported as 'contradicted',
    // and a loud warning nudges the caller to re-run with on_conflict='supersede'.
    expect(conflictCount(db)).toBeGreaterThan(0);
    expect(
      n.conflicts?.some((c) => c.existing_memory_id === e.memory.id && c.type === 'contradicted'),
    ).toBe(true);
    expect(n.warnings?.some((w) => /supersede/i.test(w))).toBe(true);
    expect(n.operation_reason).toMatch(/contradiction/i);
  });

  it('SUPERSEDE + contradiction: retires the prior fact (DELETE), no supersede-nudge warning', async () => {
    const db = createTestDb();
    const embedder = new ProximityEmbedder();
    const nli = new StubNli();

    const e = await handleStore(db, embedder, { content: 'PREMISE: The API uses port 3000' }, nli);
    const before = memCount(db);

    const n = await handleStore(
      db,
      embedder,
      {
        content: 'HYPOTHESIS: The API does NOT use port 3000 — it uses 8080',
        on_conflict: 'supersede',
      },
      nli,
    );

    // Opted into the destructive resolution: prior fact retired, correction added.
    expect(n.stored).toBe(true);
    expect(n.operation).toBe('DELETE');
    expect(memCount(db)).toBe(before + 1);
    expect(validToOf(db, e.memory.id)).not.toBeNull(); // retired (bi-temporal)
    // Not deleted — just invalidated.
    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get(e.memory.id)).toBeTruthy();
    // The "re-run with supersede" nudge is pointless here — the caller already did.
    expect(n.warnings).toBeUndefined();
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

  it('overlap heuristic says "duplicate" but a negation cue differs → contradiction wins, NOT a NOOP, and NOT retired on add', async () => {
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

    // The correction is NOT swallowed as a duplicate/NOOP — it is added as new.
    expect(n.stored).toBe(true);
    expect(n.operation).toBe('ADD');
    expect(memCount(db)).toBe(before + 1);
    // Reported conflict for the prior fact is `contradicted`, never `duplicate`.
    expect(n.conflicts?.some((c) => c.existing_memory_id === e.memory.id)).toBe(true);
    expect(n.conflicts?.every((c) => c.type !== 'duplicate')).toBe(true);
    // On the default 'add' path the prior fact stays live (no silent retire).
    expect(validToOf(db, e.memory.id)).toBeNull();
  });

  it('link-aware guard: does NOT retire a candidate the new memory links by id ([[id]])', async () => {
    const db = createTestDb();
    const embedder = new ProximityEmbedder();
    const nli = new StubNli();

    const e = await handleStore(db, embedder, { content: 'PREMISE: The API uses port 3000' }, nli);

    // The new note would NLI-contradict (it carries a NOT cue), but it explicitly
    // LINKS the prior memory by id — a reference signals "relates to", not
    // "supersedes". The guard must keep the prior fact valid even under supersede.
    const n = await handleStore(
      db,
      embedder,
      {
        content: `HYPOTHESIS: builds on the earlier note, NOT a correction — see [[${e.memory.id}]]`,
        on_conflict: 'supersede',
      },
      nli,
    );

    expect(validToOf(db, e.memory.id)).toBeNull(); // NOT retired — it was linked
    expect(n.operation).toBe('ADD');
  });

  it('link-aware guard: does NOT retire a candidate linked by 8-char short-id', async () => {
    const db = createTestDb();
    const embedder = new ProximityEmbedder();
    const nli = new StubNli();

    const e = await handleStore(db, embedder, { content: 'PREMISE: The API uses port 3000' }, nli);
    const n = await handleStore(
      db,
      embedder,
      {
        content: `HYPOTHESIS: related work, NOT a reversal — cf [[${e.memory.id.slice(0, 8)}]]`,
        on_conflict: 'supersede',
      },
      nli,
    );

    expect(validToOf(db, e.memory.id)).toBeNull();
    expect(n.operation).toBe('ADD');
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
