# ADR-0003: Conflict detection runs read-only before insert

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

`memory_conflicts.new_memory_id` is a foreign key into `memories.id` with
`ON DELETE CASCADE`, and `PRAGMA foreign_keys = ON`.

Pre-Phase-1, `handleStore` called `checkConflicts(...)` *before*
`insertMemory(...)`. The conflict-resolver inserted into
`memory_conflicts` with the new memory's UUID — which was not yet a row
in `memories`. Every insert violated the FK and threw. The exception was
swallowed by a `try { ... } catch { /* ignore */ }` in `handleStore`,
silently disabling the duplicate-detection feature: every "duplicate" was
stored alongside the original.

The bug was masked by a regression test that only asserted
`result.memory` was defined.

Three remediation options were considered:

1. **Drop the FK** so the orphan rows are accepted. Loses cascade
   integrity and silently hides bugs.
2. **Insert first, conflict-check second.** Requires rolling back the
   insert when the new memory turns out to be a duplicate.
3. **Detect first (read-only), then insert + record atomically.** Splits
   responsibility into `detectConflicts` and `recordConflicts`.

## Decision

**Option 3.** `src/graph/conflict-resolver.ts` exports two functions:

- `detectConflicts(db, embedding, content, excludeId?)` — read-only scan
  against `memories_vec` and the `memories` table. No writes.
- `recordConflicts(db, conflicts, newMemoryId)` — supersedes old rows
  and writes `memory_conflicts` rows. Caller must hold a transaction
  spanning the insert of `newMemoryId`.

`handleStore` (`src/tools/store.ts`) flow:

1. Embed content (async, outside any txn).
2. `detectConflicts(...)` — if a duplicate is found, return
   `stored: false` immediately without inserting.
3. `db.transaction(() => { insertMemory; recordConflicts; extractEntities })`
   — atomic.

Duplicates short-circuit before any write. Superseded and contradicted
results write conflict rows alongside the new memory in the same
transaction.

## Consequences

- **Pros.** The headline feature works. The FK is preserved. Duplicates
  don't waste embedder calls, since the insert is skipped.
- **Cons.** Two passes over the candidate set instead of one. Negligible
  in practice (10 candidates, both passes are O(10)).
- **Test contract.** `src/__tests__/tools/store-conflicts.test.ts`
  asserts that the duplicate path returns `stored: false`, that
  `recordConflicts` writes rows when called with a real
  `newMemoryId`, and that calling `recordConflicts` with a non-existent
  id throws an FK violation (sanity check that the underlying invariant
  is intact).
