/**
 * battle-v7 L1 — a fact retired by the NLI/delete write-gate must have
 * valid_to EXACTLY equal to the superseding fact's valid_from, so there is no
 * transient window where both are simultaneously valid under an as_of query.
 *
 * THE BUG (LOW, correctness): handleStore's persist() retired the old fact with
 * invalidateMemory(db, id) — no explicit validTo — so old.valid_to was stamped
 * with strftime('now') at retire time, which is later than the new row's
 * valid_from (= row.created_at captured earlier in the call). For ~20-65ms an
 * as_of query at an instant inside that gap saw BOTH facts as valid (double
 * truth). The heuristic superseded-band path already closes this by stamping
 * valid_to = new.valid_from (recordConflicts); the NLI/delete path didn't.
 *
 * THE FIX: pass the new row's valid_from (row.created_at) as the explicit
 * validTo, matching the heuristic path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import type { NliClassifier } from '../../graph/contradiction.js';
import type { EmbeddingProvider } from '../../types.js';

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
class SymmetricNli implements NliClassifier {
  async classify(premise: string, hypothesis: string) {
    return premise.includes('NOT') !== hypothesis.includes('NOT')
      ? { label: 'contradiction' as const, score: 0.95 }
      : { label: 'neutral' as const, score: 0.1 };
  }
}

let db: Database.Database;
const embedder = new ProximityEmbedder();
const nli = new SymmetricNli();
beforeEach(() => {
  db = createTestDb();
});

function col(id: string, c: 'valid_to' | 'valid_from'): string | null {
  return (
    db.prepare<[string], Record<string, string | null>>(`SELECT ${c} FROM memories WHERE id = ?`).get(id)?.[c] ??
    null
  );
}

describe('handleStore — L1: NLI retire leaves no as_of double-truth window', () => {
  it('the retired fact valid_to exactly equals the superseding fact valid_from', async () => {
    const e = await handleStore(db, embedder, { content: 'PREMISE the service listens on port 3000' }, nli);
    const n = await handleStore(
      db,
      embedder,
      { content: 'HYPOTHESIS the service does NOT listen on port 3000', on_conflict: 'supersede' },
      nli,
    );

    const oldValidTo = col(e.memory.id, 'valid_to');
    const newValidFrom = col(n.memory.id, 'valid_from');
    expect(oldValidTo).not.toBeNull();
    // Closed/half-open boundary: old.valid_to === new.valid_from → no instant T
    // satisfies (old.valid_from <= T < old.valid_to) AND (new.valid_from <= T).
    expect(oldValidTo).toBe(newValidFrom);
  });
});
