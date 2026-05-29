/**
 * Pillar 4, T10 — local NLI contradiction detection → bi-temporal invalidation.
 *
 * At write time, an opt-in NLI classifier reads each (existing-memory, new-memory)
 * pair and flags real logical contradictions the cheap overlap heuristic misses.
 * On a contradiction we retire (invalidate) the old fact — self-correcting memory.
 *
 * The classifier is pluggable so this suite injects a DETERMINISTIC stub and
 * never downloads a model (mirrors the T6 reranker pattern). The integration
 * tests use a proximity embedder whose vectors land in the (0.4, 0.5) L2 band:
 * close enough to enter the NLI shortlist (findNearDuplicates ≤ 0.5) but far
 * enough that the overlap heuristic (detectConflicts breaks at > 0.4) stays
 * blind — exactly the gap NLI is meant to close.
 */
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import {
  detectContradictions,
  labelFromLogits,
  normalizeNliLabel,
  CrossEncoderNli,
  type NliClassifier,
} from '../../graph/contradiction.js';
import type { EmbeddingProvider } from '../../types.js';

/**
 * Deterministic NLI stub — no model. Marks a pair a 'contradiction' (score 0.95)
 * when the hypothesis contains the literal marker `NOT`; otherwise 'neutral'
 * (score 0.1). Premise is ignored — the marker fully determines the label so the
 * tests know exactly which candidates should be flagged.
 */
class StubNli implements NliClassifier {
  async classify(_premise: string, hypothesis: string) {
    return hypothesis.includes('NOT')
      ? { label: 'contradiction' as const, score: 0.95 }
      : { label: 'neutral' as const, score: 0.1 };
  }
}

/** A stub that returns 'contradiction' but with a LOW score, to exercise the
 *  minScore threshold gate. */
class LowScoreNli implements NliClassifier {
  async classify(_premise: string, _hypothesis: string) {
    return { label: 'contradiction' as const, score: 0.4 };
  }
}

/**
 * Embedder that places the existing fact E and the new fact N exactly 0.45 L2
 * apart (two unit vectors separated by a fixed angle), and every other text on
 * a far-away axis. 0.45 sits in the NLI-shortlist window but outside the
 * heuristic's 0.4 break, so the overlap heuristic never fires for the E/N pair.
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
      v[0] = 1; // E sits on axis 0
    } else if (text.includes('HYPOTHESIS')) {
      // 0.45 L2 from axis-0 unit vector: sqrt(2 - 2*cosθ) = 0.45 → cosθ ≈ 0.89875
      v[0] = 0.89875;
      v[1] = 0.43846;
    } else {
      v[2] = 1; // unrelated content — far from both E and N
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

describe('detectContradictions (pure, stub-driven)', () => {
  it('returns only candidates the classifier marks contradiction', async () => {
    const nli = new StubNli();
    const out = await detectContradictions(nli, 'the API does NOT use 3000', [
      { id: 'a', content: 'unrelated fact' },
      { id: 'b', content: 'another unrelated note' },
    ]);
    // newContent contains NOT → all candidates flagged (stub keys off hypothesis)
    expect(out.map((o) => o.id).sort()).toEqual(['a', 'b']);
    expect(out.every((o) => o.score === 0.95)).toBe(true);
  });

  it('returns [] when the new content has no contradiction marker', async () => {
    const nli = new StubNli();
    const out = await detectContradictions(nli, 'the API uses 3000', [
      { id: 'a', content: 'the API uses 3000' },
    ]);
    expect(out).toEqual([]);
  });

  it('returns [] for an empty candidate list', async () => {
    const out = await detectContradictions(new StubNli(), 'anything NOT here', []);
    expect(out).toEqual([]);
  });

  it('respects the minScore threshold (drops low-confidence contradictions)', async () => {
    const candidates = [{ id: 'a', content: 'x' }];
    // default minScore (0.6): LowScoreNli's 0.4 is dropped
    expect(await detectContradictions(new LowScoreNli(), 'q', candidates)).toEqual([]);
    // explicit lower threshold lets it through
    const out = await detectContradictions(new LowScoreNli(), 'q', candidates, { minScore: 0.3 });
    expect(out).toEqual([{ id: 'a', score: 0.4 }]);
  });
});

describe('handleStore — NLI contradiction → invalidation (opt-in)', () => {
  it('with nli + supersede: invalidates the contradicted memory and inserts the new one (DELETE)', async () => {
    const db = createTestDb();
    const embedder = new ProximityEmbedder();

    const e = await handleStore(db, embedder, {
      content: 'PREMISE: The API uses port 3000',
    });
    expect(validToOf(db, e.memory.id)).toBeNull(); // E currently valid

    const before = memCount(db);
    const n = await handleStore(
      db,
      embedder,
      {
        content: 'HYPOTHESIS: The API does NOT use port 3000 — it uses 8080',
        on_conflict: 'supersede',
      },
      new StubNli(),
    );

    // E retired (still present, valid_to stamped), N inserted, op = DELETE
    expect(validToOf(db, e.memory.id)).not.toBeNull();
    expect(n.operation).toBe('DELETE');
    expect(n.stored).toBe(true);
    expect(memCount(db)).toBe(before + 1);
    // E is not deleted, just invalidated
    expect(
      db.prepare('SELECT id FROM memories WHERE id = ?').get(e.memory.id),
    ).toBeTruthy();
  });

  it('without nli (default): the same store does NOT invalidate E (opt-in proven)', async () => {
    const db = createTestDb();
    const embedder = new ProximityEmbedder();

    const e = await handleStore(db, embedder, {
      content: 'PREMISE: The API uses port 3000',
    });

    const n = await handleStore(db, embedder, {
      content: 'HYPOTHESIS: The API does NOT use port 3000 — it uses 8080',
      on_conflict: 'supersede',
    });

    // No NLI → the overlap heuristic is blind at this distance → E stays valid.
    expect(validToOf(db, e.memory.id)).toBeNull();
    expect(n.operation).toBe('ADD');
  });

  it('with nli but no contradiction in the shortlist: normal ADD, nothing invalidated', async () => {
    const db = createTestDb();
    const embedder = new ProximityEmbedder();

    const e = await handleStore(db, embedder, {
      content: 'PREMISE: The API uses port 3000',
    });

    const n = await handleStore(
      db,
      embedder,
      {
        // No NOT marker → StubNli returns neutral for the E/N pair.
        content: 'HYPOTHESIS: The API also serves metrics on port 9090',
        on_conflict: 'supersede',
      },
      new StubNli(),
    );

    expect(validToOf(db, e.memory.id)).toBeNull();
    expect(n.operation).toBe('ADD');
  });
});

describe('normalizeNliLabel (pure)', () => {
  it('maps raw model labels to the three-class vocabulary (case-insensitive)', () => {
    expect(normalizeNliLabel('CONTRADICTION')).toBe('contradiction');
    expect(normalizeNliLabel('Entailment')).toBe('entailment');
    expect(normalizeNliLabel('neutral')).toBe('neutral');
    expect(normalizeNliLabel('LABEL_0')).toBe('neutral'); // unknown → neutral (safe default)
    expect(normalizeNliLabel('')).toBe('neutral');
  });
});

describe('labelFromLogits (pure)', () => {
  // Xenova/nli-deberta-v3-xsmall emits 3 logits; its config.id2label is
  // {0:contradiction, 1:entailment, 2:neutral}. We softmax → argmax → map the
  // winning index through id2label → normalizeNliLabel.
  const id2label = { '0': 'contradiction', '1': 'entailment', '2': 'neutral' };

  it('picks contradiction when its logit dominates (argmax + softmax)', () => {
    const { label, score } = labelFromLogits([8, -2, -1], id2label);
    expect(label).toBe('contradiction');
    expect(score).toBeGreaterThan(0.9); // softmax confidence of the winning class
    expect(score).toBeLessThanOrEqual(1);
  });

  it('picks entailment when index 1 dominates', () => {
    const { label } = labelFromLogits([-3, 9, 0], id2label);
    expect(label).toBe('entailment');
  });

  it('picks neutral when index 2 dominates', () => {
    const { label } = labelFromLogits([0, 1, 7], id2label);
    expect(label).toBe('neutral');
  });

  it('distinguishes a contradiction pair from an entailment pair (input-dependent)', () => {
    // The bug this fix removes returned identical scores regardless of input;
    // crafted logits must yield DIFFERENT labels.
    expect(labelFromLogits([6, 0, -1], id2label).label).toBe('contradiction');
    expect(labelFromLogits([-1, 6, 0], id2label).label).toBe('entailment');
  });

  it('softmax score is the probability of the argmax class (sums to 1 across classes)', () => {
    // Equal logits → uniform 1/3 each; the reported score is the winner's prob.
    const { score } = labelFromLogits([1, 1, 1], id2label);
    expect(score).toBeCloseTo(1 / 3, 5);
  });

  it('routes the winning index through normalizeNliLabel (unknown label → neutral)', () => {
    // A single-label config (like the broken ms-marco one) → unknown → neutral.
    expect(labelFromLogits([5], { '0': 'LABEL_0' }).label).toBe('neutral');
  });
});

describe('CrossEncoderNli — constructs hermetically', () => {
  it('constructs without loading a model and exposes classify()', () => {
    const nli = new CrossEncoderNli();
    expect(nli).toBeInstanceOf(CrossEncoderNli);
    expect(typeof nli.classify).toBe('function');
    expect(nli.isReady()).toBe(false); // no model loaded on construction
    expect(nli.modelName).toContain('nli'); // default model id resolved
  });
});
