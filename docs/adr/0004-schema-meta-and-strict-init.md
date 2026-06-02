# ADR-0004: Strict schema init with versioned `schema_meta`

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

The previous `initializeSchema(db)` did three things in one call:

1. `CREATE TABLE IF NOT EXISTS memories (...full v4 columns...)`.
2. `CREATE INDEX IF NOT EXISTS` on columns that didn't exist on legacy
   v1 tables (`access_count`, `importance_score`, `superseded_at`, …).
3. `INSERT INTO schema_meta (key, value) VALUES ('schema_version', '4')`
   — unconditionally when no row existed.

Two failure modes:

- **Legacy DB with the old v1 columns:** the IF-NOT-EXISTS table create
  was a no-op, so the v3/v4 columns were never added. The subsequent
  index creation threw `no such column: <foo>`. Migrations weren't
  reached because the exec aborted mid-way.
- **Synthetic v1 DB cleared past the table create:** the
  `schema_version=4` stamp went in even though migrations 2/3/4 had
  never run. Subsequent calls to `runMigrations` saw `version=4` and
  skipped, leaving the DB in a permanently broken state.

## Decision

`initializeSchema` is strictly two-mode (`src/db/schema.ts`):

- **Empty DB.** `memories` doesn't exist → execute the full v4 schema
  (memories, indices, FTS5, vec0, all aux tables) and stamp
  `schema_version=4` plus `embedding_dim=<configured>`.
- **Existing DB.** `memories` exists → validate the column list against
  `V4_MEMORY_COLUMNS`. Any missing column throws a clear error:

  > Database appears to be from a previous schema version: `memories`
  > table is missing columns [...]. Run `node dist/index.js migrate` to
  > upgrade, or back up and recreate.

`schema_meta` is created unconditionally first, so even partial DBs end
up with a place to record version. Embedding dimension is also persisted
on first init and validated on every subsequent open via
`assertDimensionConsistency`.

## Consequences

- **Pros.** Partial schemas can no longer be silently re-stamped. The
  embedding dimension is locked to whatever produced the existing
  vectors, preventing silent vector drops in `memories_vec`.
- **Cons.** Operators upgrading from a pre-`schema_meta` build see a
  hard error rather than an automatic migration. Acceptable: in
  practice nobody is on a pre-v3 schema today, and the runbook
  documents the recovery path (export → recreate → import).
- **Future work.** A dedicated `migrate` subcommand could take the
  legacy DB, run a backfill, and stamp the right starting version. Out
  of scope for this ADR; tracked separately.

## Test contract

`src/__tests__/db/migrations.test.ts` covers:
- Fresh DB creates v4 + stamps both keys.
- Idempotent re-call.
- Synthetic v1 DB throws with the actionable error message and does
  NOT silently set `schema_version=4`.
- Re-opening with a different `MCP_MEMORY_DIMENSIONS` throws.
