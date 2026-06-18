/**
 * detectParaphrases — the dual of detectContradictions.
 *
 * Self-churn root cause (memory be1fc787): the session-review writer re-stores
 * the SAME fact every session with reworded titles. Reworded same-facts embed
 * close but share few keywords, so the overlap heuristic lands them in the
 * superseded/contradicted band (0.65–0.85) and recordConflicts writes a fresh
 * unresolved conflict row each time — flooding the conflict detector.
 *
 * A reworded restatement of the same fact is MUTUAL ENTAILMENT: the old fact
 * entails the new one AND the new entails the old. That is exactly what an NLI
 * model can decide and the keyword heuristic cannot. detectContradictions finds
 * the negation pairs; detectParaphrases finds the equivalence pairs. Requiring
 * BOTH directions (like the contradiction gate's bidirectional mode) keeps a
 * one-way MNLI over-prediction from collapsing a merely-related fact.
 */
import { describe, it, expect } from 'vitest';
import { detectParaphrases, type NliClassifier, type NliLabel } from '../../graph/contradiction.js';

/**
 * Deterministic stub: a pair mutually entails when BOTH texts carry the literal
 * marker `PARA`; exactly-one-`NOT` is a contradiction; everything else neutral.
 * Premise/hypothesis symmetric so both directions agree by construction.
 */
class StubNli implements NliClassifier {
  async classify(premise: string, hypothesis: string): Promise<{ label: NliLabel; score: number }> {
    const bothPara = premise.includes('PARA') && hypothesis.includes('PARA');
    if (bothPara) return { label: 'entailment', score: 0.95 };
    if (premise.includes('NOT') !== hypothesis.includes('NOT')) {
      return { label: 'contradiction', score: 0.95 };
    }
    return { label: 'neutral', score: 0.1 };
  }
}

/** One-way stub: forward entails, reverse neutral — must NOT count as paraphrase. */
class OneWayNli implements NliClassifier {
  async classify(premise: string, _hypothesis: string): Promise<{ label: NliLabel; score: number }> {
    // Entail only when the EXISTING fact is the premise (forward pass).
    return premise.includes('OLD')
      ? { label: 'entailment', score: 0.95 }
      : { label: 'neutral', score: 0.2 };
  }
}

describe('detectParaphrases', () => {
  it('returns a candidate that mutually entails the new content', async () => {
    const hits = await detectParaphrases(new StubNli(), 'PARA the api listens on 3000', [
      { id: 'a', content: 'PARA the api uses port 3000' },
      { id: 'b', content: 'the deploy runs nightly' },
    ]);
    expect(hits.map((h) => h.id)).toEqual(['a']);
    expect(hits[0].score).toBeGreaterThanOrEqual(0.6);
  });

  it('does NOT return a one-way entailment (a merely-related fact)', async () => {
    const hits = await detectParaphrases(new OneWayNli(), 'NEW broader claim', [
      { id: 'old', content: 'OLD narrower claim' },
    ]);
    expect(hits).toEqual([]);
  });

  it('does NOT return a contradiction as a paraphrase', async () => {
    const hits = await detectParaphrases(new StubNli(), 'the api does NOT use 3000', [
      { id: 'a', content: 'the api uses 3000' },
    ]);
    expect(hits).toEqual([]);
  });

  it('respects minScore', async () => {
    const weak: NliClassifier = {
      async classify() {
        return { label: 'entailment', score: 0.5 };
      },
    };
    const hits = await detectParaphrases(weak, 'x', [{ id: 'a', content: 'y' }], { minScore: 0.6 });
    expect(hits).toEqual([]);
  });
});
