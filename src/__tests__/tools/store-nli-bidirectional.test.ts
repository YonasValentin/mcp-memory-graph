/**
 * battle-v7 H6 — the NLI write-gate must require BIDIRECTIONAL contradiction
 * before retiring a fact.
 *
 * THE BUG (HIGH, data-loss): the gate ran the cross-encoder in ONE direction
 * (premise = existing fact, hypothesis = new fact). When two mutually-COMPATIBLE
 * facts on the same sub-topic both land inside the 0.7 L2 shortlist, the MNLI
 * model can over-predict "contradiction" in that single direction, so storing a
 * second true fact about the same subsystem SILENTLY RETIRES the first — and
 * memory_restore refuses to undo an NLI-contradiction retire. A real user loses
 * a valid memory.
 *
 * THE FIX: a genuine contradiction is symmetric — "X is on 3000" vs "X is NOT on
 * 3000" reads as a contradiction whichever is the premise. A spurious one-way
 * over-prediction usually does not survive the reverse pass. detectContradictions
 * gains a `bidirectional` mode (handleStore enables it): retire only when BOTH
 * directions agree it's a contradiction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import type { NliClassifier } from '../../graph/contradiction.js';
import type { EmbeddingProvider } from '../../types.js';

/** Places PREMISE/HYPOTHESIS 0.45 L2 apart (inside the 0.7 NLI shortlist). */
class ProximityEmbedder implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly modelName = 'proximity-test';
  async initialize(): Promise<void> {}
  isReady(): boolean {
    return true;
  }
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    if (text.includes('PREMISE')) v[0] = 1;
    else if (text.includes('HYPOTHESIS')) {
      v[0] = 0.89875;
      v[1] = 0.43846;
    } else v[2] = 1;
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/**
 * One-directional false positive: flags 'contradiction' ONLY when the PREMISE
 * carries the marker — i.e. it fires for classify(old, new) but NOT for the
 * reverse classify(new, old). This is exactly the spurious single-direction
 * over-prediction the bidirectional guard must reject.
 */
class OneWayNli implements NliClassifier {
  async classify(premise: string, _hypothesis: string) {
    return premise.includes('ONEWAY')
      ? { label: 'contradiction' as const, score: 0.95 }
      : { label: 'neutral' as const, score: 0.1 };
  }
}

/** Symmetric (genuine) contradiction: fires when exactly one side is negated. */
class SymmetricNli implements NliClassifier {
  async classify(premise: string, hypothesis: string) {
    return premise.includes('NOT') !== hypothesis.includes('NOT')
      ? { label: 'contradiction' as const, score: 0.95 }
      : { label: 'neutral' as const, score: 0.1 };
  }
}

let db: Database.Database;
const embedder = new ProximityEmbedder();
beforeEach(() => {
  db = createTestDb();
});
function validToOf(id: string): string | null {
  return (
    db.prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?').get(id)
      ?.valid_to ?? null
  );
}

describe('handleStore — H6: bidirectional NLI guard prevents false-positive retire', () => {
  it('a ONE-directional contradiction does NOT retire the existing (compatible) fact', async () => {
    const existing = await handleStore(db, embedder, { content: 'PREMISE the cache uses ONEWAY redis with a 60s TTL' }, new OneWayNli());
    expect(validToOf(existing.memory.id)).toBeNull();

    const second = await handleStore(db, embedder, { content: 'HYPOTHESIS the cache also stores session tokens' }, new OneWayNli());
    expect(second.stored).toBe(true);

    // The compatible fact must survive — a single-direction over-prediction is not
    // enough to retire it.
    expect(validToOf(existing.memory.id)).toBeNull();
    expect(second.operation).toBe('ADD');
  });

  it('a genuine (bidirectional) contradiction still retires the old fact', async () => {
    const existing = await handleStore(db, embedder, { content: 'PREMISE the service listens on port 3000' }, new SymmetricNli());
    const correction = await handleStore(db, embedder, { content: 'HYPOTHESIS the service does NOT listen on port 3000' }, new SymmetricNli());

    expect(correction.stored).toBe(true);
    expect(correction.operation).toBe('DELETE');
    expect(validToOf(existing.memory.id)).not.toBeNull();
  });
});
