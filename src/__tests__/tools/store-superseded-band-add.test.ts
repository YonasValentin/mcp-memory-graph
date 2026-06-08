/**
 * battle-v16 SUPERSEDE-BAND (HIGH, single-user DEFAULT data loss).
 *
 * detectConflicts emits a `superseded` ConflictResult for an overlap in
 * (0.75, 0.85]. decideWriteOperation('add') — the DEFAULT policy — correctly
 * returns op=ADD (keep both). But recordConflicts independently stamped
 * superseded_at + valid_to on the OLD fact for ANY `superseded` conflict,
 * retiring it even though the caller only asked to ADD. The op is reported ADD,
 * so the lost write is SILENT.
 *
 * Real-world trigger: two related-but-distinct facts that share ~80% of their
 * significant words ("Deploy uses Docker on staging" / "...on production").
 *
 * The retire on the on_conflict='supersede' path is owned by handleStore's
 * explicit invalidateMemory(deleteTargetId); recordConflicts' stamp must NOT
 * fire on the default add path. It must still RECORD the conflict (auditable).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { handleStore } from '../../tools/store.js';
import type { EmbeddingProvider } from '../../types.js';

// Identical vector for everything -> vectorSim ~= 1; overlap is then driven by
// the keyword (Jaccard) half, landing the pair inside the superseded band.
const sameVecEmbedder: EmbeddingProvider = {
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

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});

function bitemporal(id: string): { valid_to: string | null; superseded_at: string | null } {
  return db
    .prepare<[string], { valid_to: string | null; superseded_at: string | null }>(
      'SELECT valid_to, superseded_at FROM memories WHERE id = ?',
    )
    .get(id) as { valid_to: string | null; superseded_at: string | null };
}
function conflictRows(): number {
  return (db.prepare('SELECT COUNT(*) c FROM memory_conflicts').get() as { c: number }).c;
}

describe('store superseded-band on the DEFAULT add path (no NLI)', () => {
  it('a near-but-distinct fact does NOT silently retire the prior fact', async () => {
    // overlap: shared significant words alpha/beta/gamma/delta (4), old extra
    // zulu, new extra yankee => jaccard 4/6=0.667; overlapScore 0.5+0.5*0.667
    // = 0.833 -> superseded band (0.75, 0.85].
    const old = await handleStore(db, sameVecEmbedder, { content: 'alpha beta gamma delta zulu' });
    expect(bitemporal(old.memory.id).valid_to).toBeNull();

    const n = await handleStore(db, sameVecEmbedder, { content: 'alpha beta gamma delta yankee' });

    // Default on_conflict='add' -> op ADD, both kept.
    expect(n.operation).toBe('ADD');
    expect(n.stored).toBe(true);
    // The prior fact is STILL LIVE — no silent retire.
    expect(bitemporal(old.memory.id).valid_to).toBeNull();
    expect(bitemporal(old.memory.id).superseded_at).toBeNull();
    // ...but the conflict is still RECORDED (auditable, not silent).
    expect(conflictRows()).toBeGreaterThanOrEqual(1);
  });

  it('on_conflict=supersede STILL retires the prior fact (regression guard)', async () => {
    const old = await handleStore(db, sameVecEmbedder, { content: 'alpha beta gamma delta zulu' });
    const n = await handleStore(db, sameVecEmbedder, {
      content: 'alpha beta gamma delta yankee',
      on_conflict: 'supersede',
    });
    expect(n.operation).toBe('DELETE');
    // The explicit supersede policy retires the old fact, as before.
    const b = bitemporal(old.memory.id);
    expect(b.valid_to).not.toBeNull();
    expect(b.superseded_at).not.toBeNull();
  });
});
