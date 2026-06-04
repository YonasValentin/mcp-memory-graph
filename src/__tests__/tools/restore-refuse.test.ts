/**
 * M2.8: memory_restore must REFUSE to reinstate an NLI-contradiction-retired
 * fact.
 *
 * handleRestore un-tombstones a soft-forgotten memory. But the NLI write-gate
 * retires a CONTRADICTED fact the SAME way (invalidateMemory → stamps valid_to,
 * leaves superseded_at NULL) and records a `memory_conflicts` row of type
 * 'contradicted'. Naively un-tombstoning that fact reinstates a stale fact next
 * to its correction. Decision = REFUSE: restore must distinguish the two and
 * refuse to reinstate a contradiction-retired fact, while STILL restoring a
 * genuinely soft-forgotten memory and STILL un-condensing.
 *
 * The reliable discriminator is the NLI write-gate's exact DB footprint: a
 * tombstoned row (valid_to set) with superseded_at NULL AND an unresolved
 * `memory_conflicts` row where old_memory_id = id AND conflict_type =
 * 'contradicted'. A soft FORGET stamps valid_to but records NO such conflict
 * row, so it is never mistaken for a contradiction.
 *
 * The mock embedder makes distinct texts near-orthogonal (L2 ≈ 1.4 even for
 * near-identical text), so a real reversal never reaches the NLI shortlist in
 * tests. We therefore reproduce the write-gate's exact persisted state
 * (invalidateMemory + a recordConflicts 'contradicted' row) rather than driving
 * the CrossEncoder model, which would download weights. The resulting rows are
 * byte-identical to what handleStore's NLI gate writes.
 *
 * Uses createTestDb + MockEmbeddingProvider + handleStore so runs stay isolated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleForget } from '../../tools/forget.js';
import { handleRestore, handleCondense } from '../../tools/condense.js';
import { invalidateMemory, getMemoryById } from '../../db/repository.js';
import { recordConflicts } from '../../graph/conflict-resolver.js';

const embedder = new MockEmbeddingProvider();
let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

/**
 * Retire `oldId` exactly as the NLI write-gate (store.ts) does for a CONTRADICTION:
 * stamp valid_to via invalidateMemory (superseded_at stays NULL) AND record a
 * `memory_conflicts` row of type 'contradicted' pointing old → new. This is the
 * byte-identical persisted state the real gate produces.
 */
function nliContradictionRetire(oldId: string, newId: string): void {
  invalidateMemory(db, oldId);
  recordConflicts(
    db,
    [
      {
        type: 'contradicted',
        existing_memory_id: oldId,
        overlap_score: 0.9,
        description: 'NLI contradiction (score: 0.900)',
      },
    ],
    newId,
  );
}

describe('handleRestore — refuses an NLI-contradiction-retired fact (M2.8)', () => {
  it('REFUSES to reinstate a fact retired by an NLI contradiction', async () => {
    const a = await handleStore(db, embedder, {
      content: 'The deploy target is the staging server',
      title: 'Deploy',
    });
    const aPrime = await handleStore(db, embedder, {
      content: 'The deploy target is production, not staging',
      title: 'Deploy (corrected)',
    });

    // The write-gate would retire A as a contradiction when A' supersedes it.
    nliContradictionRetire(a.memory.id, aPrime.memory.id);

    // Precondition: A is tombstoned (valid_to set) with superseded_at still NULL.
    const before = getMemoryById(db, a.memory.id)!;
    expect(before.valid_to).not.toBeNull();
    expect(before.superseded_at).toBeNull();

    const result = await handleRestore(db, embedder, { id: a.memory.id });

    expect(result.restored).toBe(false);
    expect(result.reason).toBe('contradiction-retired');
    expect(result.reinstated).toBeFalsy();

    // A stays tombstoned — the stale fact was NOT reinstated next to its fix.
    const after = getMemoryById(db, a.memory.id)!;
    expect(after.valid_to).not.toBeNull();
  });

  it('STILL restores a genuinely soft-forgotten memory (no contradiction row)', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'reinstate this fact into default recall please',
      title: 'Recoverable',
    });
    const id = stored.memory.id;

    handleForget(db, { id }); // soft tombstone — no memory_conflicts row
    expect(getMemoryById(db, id)!.valid_to).not.toBeNull();

    const result = await handleRestore(db, embedder, { id });

    expect(result.restored).toBe(true);
    expect(result.reinstated).toBe(true);
    expect(result.reason).toBeUndefined();

    const row = getMemoryById(db, id)!;
    expect(row.valid_to).toBeNull();
    expect(row.tx_expired).toBeNull();
  });

  it('STILL un-condenses a condensed memory (restores original full content)', async () => {
    const stored = await handleStore(db, embedder, {
      content: 'A long original fact with much more detail than its short summary',
      title: 'Verbose',
    });
    const id = stored.memory.id;

    const condensed = await handleCondense(db, embedder, {
      memories: [{ id, summary: 'short summary' }],
      target_level: 'summary',
    });
    expect(condensed.condensed).toBe(1);
    expect(getMemoryById(db, id)!.content).toBe('short summary');

    const result = await handleRestore(db, embedder, { id });

    expect(result.restored).toBe(true);
    expect(result.uncondensed).toBe(true);
    expect(result.reason).toBeUndefined();

    const row = getMemoryById(db, id)!;
    expect(row.content).toBe('A long original fact with much more detail than its short summary');
    expect(row.condensation_level).toBe('full');
  });

  it('does NOT refuse a soft-forgotten memory whose contradiction was already resolved', async () => {
    // A contradiction row that has been resolved (resolved_at set) is historical
    // audit, not an active retirement — restore should not refuse on it.
    const a = await handleStore(db, embedder, {
      content: 'The cache TTL is 60 seconds',
      title: 'Cache',
    });
    const aPrime = await handleStore(db, embedder, {
      content: 'The cache TTL is 300 seconds, not 60',
      title: 'Cache (corrected)',
    });
    nliContradictionRetire(a.memory.id, aPrime.memory.id);
    db.prepare(
      "UPDATE memory_conflicts SET resolved_at = '2026-01-01T00:00:00.000Z' WHERE old_memory_id = ?",
    ).run(a.memory.id);

    const result = await handleRestore(db, embedder, { id: a.memory.id });

    expect(result.restored).toBe(true);
    expect(result.reinstated).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
