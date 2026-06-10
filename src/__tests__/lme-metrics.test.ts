// Unit test for the LongMemEval metric math (scripts/bench/lme-metrics.mjs).
// Deterministic, no model — pins the recall_any@k / recall_all@k / binary-NDCG@k
// formulas to the official LongMemEval `src/retrieval/eval_utils.py` semantics
// so the published numbers cannot silently drift.
import { describe, it, expect } from 'vitest';
import {
  evaluateRetrieval,
  binaryNdcgAtK,
  aggregate,
} from '../../scripts/bench/lme-metrics.mjs';

describe('evaluateRetrieval (official eval_utils.py semantics)', () => {
  // Ranked session ids (already deduplicated), best first.
  const ranked = ['s1', 'answer_a', 's2', 'answer_b', 's3', 's4'];

  it('recall_any@k: any one evidence id in top-k', () => {
    const correct = new Set(['answer_a', 'answer_b']);
    expect(evaluateRetrieval(ranked, correct, 1).recall_any).toBe(0);
    expect(evaluateRetrieval(ranked, correct, 2).recall_any).toBe(1);
    expect(evaluateRetrieval(ranked, correct, 5).recall_any).toBe(1);
  });

  it('recall_all@k: every evidence id in top-k', () => {
    const correct = new Set(['answer_a', 'answer_b']);
    expect(evaluateRetrieval(ranked, correct, 2).recall_all).toBe(0); // only answer_a
    expect(evaluateRetrieval(ranked, correct, 4).recall_all).toBe(1); // both
    expect(evaluateRetrieval(ranked, correct, 5).recall_all).toBe(1);
  });

  it('single-evidence question: any == all', () => {
    const correct = new Set(['answer_a']);
    const r = evaluateRetrieval(ranked, correct, 3);
    expect(r.recall_any).toBe(1);
    expect(r.recall_all).toBe(1);
  });

  it('miss at every k when no evidence retrieved', () => {
    const correct = new Set(['answer_zzz']);
    const r = evaluateRetrieval(ranked, correct, 6);
    expect(r.recall_any).toBe(0);
    expect(r.recall_all).toBe(0);
    expect(r.ndcg).toBe(0);
  });
});

describe('binaryNdcgAtK', () => {
  it('perfect ranking = 1', () => {
    // Both evidence docs at the top, 2 evidence total.
    const ranked = ['answer_a', 'answer_b', 's1', 's2'];
    const correct = new Set(['answer_a', 'answer_b']);
    expect(binaryNdcgAtK(ranked, correct, 5)).toBeCloseTo(1, 10);
  });

  it('rank 1 (0-based) is UNDISCOUNTED — official eval_utils.py convention', () => {
    // 1-evidence question, evidence at the 2nd position. Official dcg() leaves
    // rel[1] undiscounted (weight 1.0), so dcg = idcg = 1 → NDCG = 1.0.
    // (A naive 1/log2(i+2) curve would wrongly report ~0.631 here — the
    // battle-v17 regression this test now guards against.)
    const ranked = ['s1', 'answer_a', 's2'];
    const correct = new Set(['answer_a']);
    expect(binaryNdcgAtK(ranked, correct, 5)).toBeCloseTo(1, 10);
  });

  it('evidence at rank 3 of a 1-evidence question: dcg=1/log2(3), idcg=1', () => {
    const ranked = ['s1', 's2', 'answer_a'];
    const correct = new Set(['answer_a']);
    expect(binaryNdcgAtK(ranked, correct, 5)).toBeCloseTo(1 / Math.log2(3), 10);
  });

  it('idcg caps at min(k, |correct|), official discount curve', () => {
    // 3 evidence docs but k=2. Top-2 rel = [1,0] → dcg = rel[0] + rel[1]/log2(2)
    // = 1. Ideal top-2 = [1,1] → idcg = 1 + 1/log2(2) = 2. NDCG = 0.5.
    const ranked = ['answer_a', 's1', 'answer_b', 'answer_c'];
    const correct = new Set(['answer_a', 'answer_b', 'answer_c']);
    expect(binaryNdcgAtK(ranked, correct, 2)).toBeCloseTo(0.5, 10);
  });

  it('matches the official eval_utils.py worked cases', () => {
    // From battle-v17 verification: official NDCG@5 for these rankings.
    const k = 5;
    expect(binaryNdcgAtK(['a', 'x', 'y', 'z', 'b'], new Set(['a', 'b']), k)).toBeCloseTo(0.715, 3);
    expect(binaryNdcgAtK(['x', 'y', 'z', 'b', 'c'], new Set(['b', 'c', 'd']), k)).toBeCloseTo(
      // rel=[0,0,0,1,1], dcg = 1/log2(4)+1/log2(5)=0.5+0.4307=0.9307;
      // idcg top-3 of 3 = 1+1+1/log2(3)=2.6309 → 0.3538
      0.9307 / (1 + 1 + 1 / Math.log2(3)),
      3,
    );
  });
});

describe('aggregate', () => {
  it('averages per-question metrics and counts questions', () => {
    const per = [
      { recall_any: 1, recall_all: 1, ndcg: 1 },
      { recall_any: 1, recall_all: 0, ndcg: 0.5 },
      { recall_any: 0, recall_all: 0, ndcg: 0 },
    ];
    const a = aggregate(per);
    expect(a.questions).toBe(3);
    expect(a.recall_any).toBeCloseTo(2 / 3, 10);
    expect(a.recall_all).toBeCloseTo(1 / 3, 10);
    expect(a.ndcg).toBeCloseTo(0.5, 10);
  });

  it('empty input yields zeroed metrics, not NaN', () => {
    const a = aggregate([]);
    expect(a.questions).toBe(0);
    expect(a.recall_any).toBe(0);
    expect(a.recall_all).toBe(0);
    expect(a.ndcg).toBe(0);
  });
});
