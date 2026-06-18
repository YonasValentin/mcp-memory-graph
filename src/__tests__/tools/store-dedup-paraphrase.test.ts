/**
 * #4 self-churn dedup: a reworded restatement of an existing fact must NOOP, not
 * accumulate a fresh memory + conflict row every session (memory be1fc787).
 *
 * The dedup is NLI-gated: it fires ONLY when a classifier judges the new memory
 * a MUTUAL-ENTAILMENT paraphrase of a near neighbour. That keeps it safe against
 * battle-v16 (distinct-but-similar facts must both survive) — those read as
 * `neutral`, not entailment — and it never runs when no classifier is supplied,
 * so the default no-NLI store path is byte-identical.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import type { EmbeddingProvider } from '../../types.js';
import type { NliClassifier, NliLabel } from '../../graph/contradiction.js';

// Everything embeds to the SAME point → every prior fact is a near neighbour
// (distance 0, inside the NLI shortlist). The NLI verdict, not the vector,
// decides paraphrase vs distinct vs contradiction.
const sameVec: EmbeddingProvider = {
  dimensions: 384,
  modelName: 'samevec',
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

// Mutual entailment when BOTH texts carry `PARA`; contradiction on a lone `NOT`;
// otherwise neutral (the battle-v16 "distinct but similar" case).
class StubNli implements NliClassifier {
  async classify(premise: string, hypothesis: string): Promise<{ label: NliLabel; score: number }> {
    if (premise.includes('PARA') && hypothesis.includes('PARA')) {
      return { label: 'entailment', score: 0.95 };
    }
    if (premise.includes('NOT') !== hypothesis.includes('NOT')) {
      return { label: 'contradiction', score: 0.95 };
    }
    return { label: 'neutral', score: 0.1 };
  }
}

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function memCount(): number {
  return (db.prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c;
}
function conflictCount(): number {
  return (db.prepare('SELECT COUNT(*) c FROM memory_conflicts').get() as { c: number }).c;
}
function accessCount(id: string): number {
  return (
    db.prepare<[string], { access_count: number }>('SELECT access_count FROM memories WHERE id = ?').get(id)
      ?.access_count ?? 0
  );
}

describe('handleStore — NLI paraphrase dedup (#4)', () => {
  it('a reworded restatement NOOPs: no new row, no conflict row, existing reinforced', async () => {
    const nli = new StubNli();
    const first = await handleStore(db, sameVec, { content: 'PARA alpha beta gamma' }, nli);
    expect(first.stored).toBe(true);
    expect(memCount()).toBe(1);

    const before = { mems: memCount(), conflicts: conflictCount(), access: accessCount(first.memory.id) };
    const second = await handleStore(db, sameVec, { content: 'PARA delta epsilon zeta' }, nli);

    expect(second.stored).toBe(false);
    expect(second.operation).toBe('NOOP');
    expect(second.memory.id).toBe(first.memory.id); // points at the kept fact
    expect(memCount()).toBe(before.mems); // no new memory
    expect(conflictCount()).toBe(before.conflicts); // no churn into memory_conflicts
    expect(accessCount(first.memory.id)).toBeGreaterThan(before.access); // reinforced
  });

  it('distinct-but-similar facts BOTH survive even with NLI present (battle-v16 guard)', async () => {
    const nli = new StubNli();
    const old = await handleStore(db, sameVec, { content: 'alpha beta gamma delta zulu' }, nli);
    const n = await handleStore(db, sameVec, { content: 'alpha beta gamma delta yankee' }, nli);

    // No PARA marker → neutral → NOT a paraphrase → still ADD; both kept.
    expect(n.operation).toBe('ADD');
    expect(n.stored).toBe(true);
    expect(memCount()).toBe(2);
    const oldRow = db
      .prepare<[string], { valid_to: string | null }>('SELECT valid_to FROM memories WHERE id = ?')
      .get(old.memory.id);
    expect(oldRow?.valid_to ?? null).toBeNull(); // prior fact still live
  });
});
