# ADR-0001: SQLite + sqlite-vec for storage

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

The server needs hybrid (vector + keyword) retrieval over per-user memory
content. Single-user deployments dominate (Claude Code on a laptop, or one
Docker container behind Cloudflare Access on a homelab). Multi-tenant SaaS
is explicitly out of scope.

Candidates considered:

- **PostgreSQL + pgvector.** Mature, proven at scale. Operationally heavy
  for a single-user box: a separate process, network port, backups, and
  upgrade story.
- **DuckDB.** Excellent analytics. Vector extension less mature than
  sqlite-vec; not great at write-heavy workloads.
- **Qdrant / Weaviate / Chroma.** Network DBs; same operational tax as
  Postgres without the SQL benefits.
- **SQLite + sqlite-vec.** Single file, in-process, no network. Mature
  FTS5 for keyword search. Vector index via the actively maintained
  `sqlite-vec` extension (Alex Garcia).

## Decision

We use SQLite (via `better-sqlite3`) with two virtual tables on the same
file: `memories_fts` (FTS5) and `memories_vec` (sqlite-vec).
Reciprocal-rank fusion combines results in `src/search/hybrid.ts`. The
embedding dimension is parameterized via `MCP_MEMORY_DIMENSIONS` and
persisted in `schema_meta.embedding_dim` for cross-open consistency.

## Consequences

- **Pros.** Zero ops; backup is `cp memory.db`; tests run against
  in-memory DBs at full fidelity; better-sqlite3 sync API simplifies
  transactional code.
- **Cons.** Single-writer; multi-process replicas are not supported. We
  accept this — operators who outgrow a single box must migrate to
  Postgres + pgvector; this is documented in the runbook.
- **Risk.** sqlite-vec is pre-1.0. Mitigated by pinning the version and
  by isolating vec-specific SQL in `src/search/hybrid.ts` and
  `src/db/repository.ts:findNearDuplicates` so a future swap is
  contained.
