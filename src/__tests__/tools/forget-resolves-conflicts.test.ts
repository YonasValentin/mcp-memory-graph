/**
 * Soft-forgetting a memory must RESOLVE the open conflicts it is party to.
 *
 * Pre-fix: only the store supersede branch called markConflictsResolved. An
 * `add`-path contradicted/duplicate conflict (both parties still valid) sits in
 * memory_conflicts with resolved_at = NULL. countUnresolvedConflicts drops it
 * once a party is retired (its JOIN requires both memories valid), but the ROW
 * keeps resolved_at = NULL forever — so any reader using the naive
 * `WHERE resolved_at IS NULL` predicate (the shape the count itself used before
 * v14) over-counts, and the audit trail (resolved_by) is missing.
 *
 * Post-fix: handleForget (soft) stamps resolved_at/resolved_by = 'forget' on
 * every still-open conflict touching the forgotten memory.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../testing/test-db.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { handleForget } from '../../tools/forget.js';
import { recordConflicts } from '../../graph/conflict-resolver.js';
import { countUnresolvedConflicts } from '../../db/predicates.js';

let db: Database.Database;
const embedder = new MockEmbeddingProvider();

beforeEach(() => {
  db = createTestDb();
});

function resolvedAtFor(memoryId: string): string | null {
  return (
    db
      .prepare<[string, string], { resolved_at: string | null }>(
        'SELECT resolved_at FROM memory_conflicts WHERE old_memory_id = ? OR new_memory_id = ?',
      )
      .get(memoryId, memoryId)?.resolved_at ?? null
  );
}

describe('handleForget resolves open conflicts', () => {
  it('soft-forget stamps resolved_at on the open conflict and drops it from the unresolved count', async () => {
    const existing = await handleStore(db, embedder, {
      content: 'The staging deploy runs every night at 02:00 UTC.',
    });
    const writer = await handleStore(db, embedder, {
      content: 'Customer onboarding emails are sent from the marketing service.',
    });

    // An add-path contradiction between two still-valid facts: recorded, not
    // retired (retireSuperseded=false), so it counts as unresolved.
    recordConflicts(
      db,
      [
        {
          type: 'contradicted',
          existing_memory_id: existing.memory.id,
          overlap_score: 0.9,
          description: 'staging schedule contradicts onboarding claim',
        },
      ],
      writer.memory.id,
      false,
    );

    expect(resolvedAtFor(existing.memory.id)).toBeNull();
    expect(countUnresolvedConflicts(db)).toBe(1);

    handleForget(db, { id: existing.memory.id });

    expect(resolvedAtFor(existing.memory.id)).not.toBeNull();
    expect(countUnresolvedConflicts(db)).toBe(0);
  });
});
