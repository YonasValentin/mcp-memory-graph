# Changelog

All notable changes to the MCP Memory Graph are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Changed

- Documentation overhaul for readability: README restructured around a
  5-minute quick start with a first store/recall example, a plain-language
  "how to read the benchmarks" primer, stale facts corrected (schema v18,
  49 tool registrations, dependency versions, roadmap now lists only unbuilt
  work), and every user-facing doc (README, BENCHMARKS, MULTI-TENANCY,
  ENTERPRISE-BRAIN, ENV, DATA-HANDLING, RUNBOOK, CONTRIBUTING, SECURITY,
  COMMERCIAL, this changelog) rewritten in plainer language with em dashes
  removed. No commands, numbers, or security caveats changed.
- Repository renamed `YonasValentin/mcp-memory-server` → `YonasValentin/mcp-memory-graph`
  to match the npm package and binary name (old GitHub URLs redirect).
  `package.json` repository/bugs/homepage updated. The MS-01 deploy stack dir
  keeps its legacy path (`/opt/stacks/mcp-memory-server`).

### Fixed

- CLI hint and team-workflow docs referenced a nonexistent `mcp-memory-server`
  binary: corrected to `mcp-memory-graph` (the actual `bin` name).
- Docker build was broken since the better-sqlite3 12.x bump: no usable
  prebuild on `node:20-slim`, so `npm ci` fell back to a source build and
  failed on missing Python. Image now uses `node:22-slim` (the repo's Node
  baseline) with a builder-stage native toolchain (python3/make/g++).

## [2.3.0] - 2026-06-11

Per-key RBAC v1, a fresh-eyes sandbox E2E wave over install/solo/team flows
(three simulated humans following only the README), and a hardening band
adopted from a competitive sweep. All changes backward compatible; schema
v16 → v18 migrations run automatically.

### Added

- **Per-key RBAC v1 (schema v16).** One running server can now serve many
  tenants: N API keys, each pinned to a *set* of namespaces and an
  access-level ceiling (`public < internal < confidential < restricted`).
  "Sales can't see HR" without one process per tenant. The
  `src/lib/tenancy.ts` enforcement boundary is unchanged: the namespace it
  forces is now per-request (minted from the calling key) instead of
  per-process.
  - New `api_keys` table (tokens stored as sha256; the raw `mcpm_…` token is
    shown exactly once at create).
  - **`memory keys` CLI**: `create` (prints the token once with a store-now
    warning), `list` (aligned table, never any token/hash material), `revoke`
    (by id; never restamps an existing revocation).
  - Auth resolution: the **legacy single token `MCP_AUTH_TOKEN` still works and
    is checked first**; a key-only deployment (no `MCP_AUTH_TOKEN`) is fully
    authenticated. A newly created/revoked key takes effect on the next
    request (key liveness is consulted per call: no cache, no restart).
  - Namespace semantics: a multi-namespace key picks its effective namespace
    per call (unset → the key's first namespace); a foreign namespace is denied
    `403 NAMESPACE_NOT_PERMITTED`, never silently redirected. Over-ceiling /
    foreign by-id reads return not-found (no existence oracle).
  - **MCP session binding:** a session is owned by the authenticating key;
    replaying another principal's `mcp-session-id` is `403`
    `SESSION_PRINCIPAL_MISMATCH`.
  - §6 access-level ceilings are enforced across BOTH egress chokepoints:
    every MCP read tool (by-id, positional, aggregate counts) and the REST
    surface (`/api/search`, `/api/stats`, `/api/insights`, …): converged
    after 12 adversarial battle waves, pinned by four structural tripwire
    tests. v2 boundary: graph/community entity NAMES aggregate within a
    namespace (member memory ids are ceiling-filtered).
    Separate-DB-per-tenant remains the strongest boundary.
  - See `docs/MULTI-TENANCY.md` → "Per-key RBAC (schema v16)".
- **Embedder-identity guard.** The database records which embedding model
  built it (`schema_meta.embedding_model`); opening with a different
  `MCP_MEMORY_MODEL` fails loudly with recovery options instead of silently
  degrading every search (same dimension ≠ same vector space). Legacy DBs
  adopt the configured model on first open; `memory rebuild` re-stamps.
- **Query sanitizer.** `memory_search`/`/api/search` strip system-prompt
  contamination from overlong queries (>512 code points: last question block →
  tail sentences → final 400 cp). Bench/eval questions are below the gate by
  construction; `MCP_QUERY_SANITIZER=off` restores raw. Logs keep the
  original query.
- **Org-ontology graph types** for the enterprise-brain pattern
  (`docs/ENTERPRISE-BRAIN.md`): entity kinds `team`/`department`/`sop`/`agent`
  and relationship kinds `manages`/`reports_to`/`member_of`/`works_on`/
  `owns`/`follows` in `memory_extract_entities` + `memory_graph` filters.
- **Backup retention cap**: `MCP_MEMORY_MAX_BACKUPS` (default 10, 0 = keep
  all) prunes old `<db>.backup-<ISO>` snapshots after `memory backup`.
- **npm provenance releases**: tag-triggered workflow publishes with
  `--provenance` via npm Trusted Publishing (OIDC).
- **Per-question benchmark artifacts**: all four public-benchmark runners
  accept `--out <path>` and write the report plus per-question rows
  (committed under `benchmarks/results/`) so published claims are
  independently checkable.

### Fixed

- **Project-scope config was never read** (`init --scope project` wrote
  `<project>/.mcp-memory/config.json`, the runtime only checked the env pin
  and the home config): resolution is now env → `<cwd>/.mcp-memory/config.json`
  → home; relative paths in a project config anchor at the project; the
  generated `.mcp.json` pins `MCP_MEMORY_CONFIG_PATH`. The project-local-DB
  promise now holds, and config `defaults.scope`/`defaults.namespace`
  (`"auto"` = directory name) actually reach `memory_store` for omitted args.
- **Markdown ingest glued headings to their body** (`## Duplicate
  detectionEvery invoice…`): the chunker's overlap join dropped the
  inter-chunk separator; restored when whitespace, byte-identical at
  overlap 0.
- **Git-vault collaborator on-ramp:** post-merge/post-checkout hooks now pass
  `--vault "$(git rev-parse --show-toplevel)"` explicitly (no more silently
  stale DBs when the pulling shell lacks vault config) and leave a stderr
  breadcrumb on failure; `vault-init` sets `pull.rebase=false` (divergent
  pulls fatal'd on modern git; rebase pulls skip the hook) and no longer
  rewrites the committed `graph.json` sidecar on re-run.
- **Rebuild integrity refusal** runs before the embedder loads and before the
  old index is unlinked: a tampered-vault refusal no longer SIGABRTs through
  ONNX static destructors nor costs the existing index; the error now states
  the documented recovery (delete `.memory/manifest.json`, re-run).
- **Key-only deployments logged "server is unauthenticated"** while enforcing
  auth: startup now logs `auth_mode: bearer|api-keys|none` and warns only on
  `none`.
- **REST PATCH version snapshots** attribute `changed_by` to the api-key
  principal (was always `web-dashboard`).
- `init --scope project` writes a `.gitignore` guard for `.mcp-memory/`
  (project-local DB + machine-specific config must not be committed).
- Vault frontmatter rounds `importance_score` to 4 decimals (no more
  `0.8400000000000001` diff noise in git-reviewed vaults).

## [2.2.0] - 2026-06-11

Public benchmarks + a fresh adversarial E2E pass over the fix wave itself
(solo, team-shared-SQLite, team-git-vault: real stdio MCP, real models).
All changes backward compatible.

### Added

- **LOCOMO retrieval benchmark harness** (`npm run bench:locomo`): runs the
  full LOCOMO multi-session benchmark against the production store/search
  handlers with the real local embedder; reports session- AND turn-level
  recall@k from the same run
- CI now tests on **Windows and macOS** (Node 22) in addition to Linux
  (Node 20 + 22), plus a prod-only-deps install smoke job

### Fixed

- **Shutdown: `docker stop` no longer looks like a crash.** With any ONNX
  model loaded, `process.exit()` aborted in onnxruntime's static destructors
  (`libc++abi … mutex lock failed` → SIGABRT, deterministic under SIGTERM).
  The SIGINT/SIGTERM handlers now close the databases (WAL checkpoint) and
  die by re-raised default-disposition signal: POSIX-correct termination,
  zero aborts across 75 PoC kills, DB integrity intact
- **`--help` no longer executes commands.** Every CLI command ran on
  `--help`: `init --help` wrote settings/config/launchd files and
  `rebuild --help` would have deleted the database. A central gate now
  prints usage for all 13 commands before any command module loads
- **A cold NLI model download can't fail a write.** `memory_store` errored
  outright while the 284MB NLI model was mid-download on first run; the
  contradiction pass is optional enrichment and now degrades gracefully
  (logged, per-call semantics of `MCP_NLI_DISABLED=1`), and failed loads
  still retry
- **`memory rebuild` survives duplicate frontmatter ids** instead of
  crashing on `UNIQUE constraint failed`: same first-claim-wins guard
  `vault_sync` already had; duplicates are skipped, warned, and counted in
  the CLI summary
- **`metadata._vault` (server-internal sync bookkeeping, including an
  absolute per-developer path) no longer appears in any tool output**;
  stripped once at the row-mapping chokepoint rather than per tool. User
  metadata keys, including `links`, `file_path`, `vault_path`,
  `frontmatter`: pass through untouched in plain usage
- The vault metadata-collision fix (user keys colliding with bookkeeping
  names) re-verified under adversarial attack: forged/malformed `_vault`
  in a shared vault cannot inject wikilinks or paths across developers;
  legacy flat residue self-heals without accretion
- ReDoS linearity guards in the test suite self-calibrate (ratio vs a
  small input) instead of asserting absolute wall-clock: no more flakes
  on slow shared CI runners

## [2.1.0] - 2026-06-10

Hardening release: five adversarial production-readiness battles (v9→v16,
schema v12→v15), three init/vault footgun fixes, and a fresh three-scenario
end-to-end pass (solo, team-shared-SQLite, team-git-vault) over real stdio MCP.
All changes additive; migrations automatic.

### Fixed

**Team git vault (found by 2-dev E2E simulation)**

- **Vault frontmatter no longer accretes**: `vault_sync` used to stuff the
  entire previous frontmatter plus each developer's *absolute* vault path into
  `metadata`, and exports wrote it all back: geometric file growth, YAML merge
  conflicts in files nobody edited, and quarantine data loss. Imports and
  exports now strip the reserved bookkeeping keys both ways; poisoned vaults
  self-heal on the next export
- `vault_sync` now quarantines files containing git conflict markers (counted
  in the new `conflicted` result field) instead of indexing `<<<<<<< HEAD` as
  memory content: same guard `rebuild` already had
- The two vault import paths (`vault_sync` vs `rebuild`) now produce
  byte-identical content (trailing-newline parity)
- `rebuild` CLI prints quarantined files; the post-merge hook logs to
  `.memory/last-rebuild.log` (gitignored) instead of discarding output

**Concurrency**

- Lazy model init (embedder, NLI, reranker) is now promise-deduped: N
  concurrent cold-start calls share one model load instead of launching N
  parallel ~250MB loads: fixes intermittent cold-start store failures and a
  native abort at shutdown under parallel first writes; failed loads retry

**Visibility**

- `memory_get` now returns `valid_from` / `valid_to` / `superseded_at`, so a
  retired memory is distinguishable from a live one
- `memory_version_restore` failures now carry a `reason`
  (`"Version 99 not found; available: 1..2"`) instead of a bare
  `{"restored": false}`

### Added

- **Dashboard "Archive Terminal" identity**: designed typography (Instrument
  Serif / Instrument Sans / IBM Plex Mono, bundled locally: no CDN), two
  committed themes (manila-paper light, phosphor-on-ink dark), dot-grid
  texture, indexed sidebar nav, archive-palette knowledge graph
- `/api/search` gains `detail=ids_only|summary|full` (default `summary`
  preserves the existing contract): fixes the dashboard Search page, which
  crashed on every query because the UI rendered the full nested result
  shape the route never returned
- **LongMemEval-S public benchmark harness** (`npm run bench:longmemeval`):
  runs the ICLR 2025 long-term-memory benchmark's retrieval stage against the
  real production store/search handlers, fully local. Measured (stock
  embedder, zero benchmark-specific tuning, all 500 questions):
  **Recall@5 = 95.2% hybrid / 97.8% with the local reranker**
  (MemPalace-comparable aggregation); official-style recall_all@5 = 92.8%,
  NDCG@5 = 0.930. Methodology + both aggregations in `docs/BENCHMARKS.md`
- `MCP_NLI_DISABLED=1` escape hatch: turns the self-correcting NLI write-gate
  off for corpora of templated near-twin notes, where MNLI can read shared
  boilerplate as a bidirectional contradiction and auto-retire a teammate's
  valid note (every auto-retire remains audited + recoverable)
- `vault_search` accepts explicit `scope` / `namespace` overrides (default
  remains the vault folder name)
- `memory init --scope project` keeps everything project-local: project
  `db_path` default, no machine-global consolidation schedule
- `package.json` `repository` / `bugs` / `homepage` metadata

### Changed

- Schema v15: tenancy-scoped `search_log`; v14: structural `(scope, namespace)`
  on the five knowledge-graph tables: shared-DB multi-tenant isolation is
  enforced by schema, not per-reader filters (see `docs/MULTI-TENANCY.md`)
- Docs: team-vault onboarding (per-clone `vault-init`), stale-manifest
  recovery, hand-edit ordering, vault round-trip fidelity (only
  `confidence_score` and `stability` reset), `detail_level: "full"` for numeric
  `confidence`, same-namespace trust model

## [2.0.0] - 2026-05-29

The "revolution" release: 8 pillars expand the server from 17 to 37 MCP tools.
Database schema migrated to **v9** via additive migrations. All new behaviors
are **additive and opt-in**: existing tools, defaults, and stored data are
preserved (e.g. search stays hybrid-by-default; graph/rerank/point-in-time
features only activate when their flags are passed; `memory_forget` is additive
to `memory_delete`).

### Added

**Pillar 1: Bi-temporal memory**

- Valid-time (`valid_from`/`valid_to`) alongside transaction-time; updates *invalidate-don't-delete* so history is never lost
- `as_of: <timestamp>` point-in-time recall on search and reads
- `memory_history` tool: full bi-temporal timeline + edit versions for one memory

**Pillar 2: Knowledge graph**

- Confidence-tagged `memory_links` (wikilink / co-occurrence / similarity edges) and entity co-occurrence
- `memory_graph` multi-hop entity traversal (depth 1–3) and `memory_extract_entities`
- HippoRAG Personalized-PageRank multi-hop retrieval via `use_graph: true` on search
- `memory_query`: token-budgeted, hub-avoiding subgraph traversal that answers a question without flooding context
- `memory_communities`: GraphRAG community detection (weighted label propagation) for corpus-level themes

**Pillar 3: Retrieval**

- Cross-encoder reranking via `rerank: true` on search
- Contextual indexing

**Pillar 4: Self-correcting writes**

- ADD / UPDATE / DELETE / NOOP write gate (`on_conflict`)
- NLI cross-encoder contradiction detection
- Forgetting-curve `stability` signal

**Pillar 5: Agent-OS memory**

- Pinned, bounded core-memory block: `core_memory_get` / `core_memory_append` / `core_memory_replace`
- `memory_tiers`: MemGPT-style hot / recall / archival distribution + hot working set
- `memory_reflect`: Generative-Agents-style reflection (gather material / store insight)

**Pillar 6: Obsidian-grade vault**

- `memory_export_vault`: bidirectional `.md` write-back with lossless YAML frontmatter (reverse of `vault_sync`)
- `memory_canvas`: JSON Canvas 1.0 `.canvas` export
- Read-only memory wiki / Publish routes (`/publish/:namespace`), hard-scoped to published access levels
- `memory_session_note` (per-session daily note) and `memory_template` (structured note scaffolds)

**Pillar 7: Team & solo sharing**

- Interactive `memory init` wizard (with `--yes` for all-defaults)
- Committable graph artifact: `export-graph` CLI → deterministic `memory-graph.json`
- `git-setup` CLI: installs `.gitattributes` + `memory-union` git merge driver (`merge-graphs`) for conflict-free sharing
- `memory_attribution`: per-`agent_id` rollup (default agent via `MCP_AGENT_ID`)

**Pillar 8: Trust & governance**

- `memory_questions`: "questions to ask" digest (ambiguous links, under-documented entities, orphans)
- `memory_forget`: GDPR soft-delete (recoverable, queryable via `as_of`) or hard erase-after-export; additive to `memory_delete`
- `memory_manifest`, `memory_condense` / `memory_restore`
- Output sanitization chokepoint (ANSI/VT escapes, control chars, zero-width / BiDi Trojan-Source) on every tool result
- Config hot-reload
- Security headers (HSTS, CSP) with `MCP_HSTS_*` / `MCP_CSP_*` controls

### Changed

- Database schema migrated to **v9** (additive migrations only; existing data preserved)
- `bin` / package bumped to 2.0.0

## [1.0.0] - 2026-03-27

### Added

- 17 MCP tools: 12 core memory tools, 3 Obsidian vault tools, 2 self-improvement tools
- Hybrid search combining vector similarity (sqlite-vec) with keyword matching (FTS5) via Reciprocal Rank Fusion
- Local embeddings with Transformers.js (all-MiniLM-L6-v2, 384 dimensions, no cloud API)
- SQLite storage with WAL mode, foreign keys, and three-table sync (memories + FTS5 + vec0)
- Smart document chunking with content-type strategies (text, markdown, code, legal)
- Multi-scope isolation (global, project, user, team, department)
- Version history with full audit trail
- Temporal decay scoring (exponential and linear)
- Confidence scoring with human-readable levels (high/medium/low)
- Access tracking and quality scoring based on usage patterns
- Dream cycle consolidation: deduplication, pruning, scoring, gap detection
- Obsidian vault integration with incremental sync, frontmatter parsing, and wiki-link extraction
- `init` command with `--scope user` (global) and `--scope project` (per-project) installation
- Agent-type Stop hook for session-end learning (uses Claude's judgment instead of regex)
- CLAUDE.md generation during init with memory server usage instructions
- `.mcp.json` creation for project-scoped MCP server discovery
- Nightly consolidation schedule via launchd (macOS) or cron (Linux)
- 70 tests covering repository operations, confidence scoring, and extraction pipeline

### Fixed

- Vault sync delete-before-parse race condition that caused data loss on parse failure
- Duplicate `rowToMemory` in hybrid search (now imports canonical version from repository)
- `findNearDuplicates` wrapped in transaction to prevent race conditions
- Hybrid search oversample capped at 300 to prevent resource exhaustion
- All 17 tool handlers enforce Zod schema validation (defense-in-depth)
- Import size limits (500 items, 100KB per content)
- Consolidation embedding budget and 5-minute time cap
- Hook stdin timeouts (5s), JSON parse safety, spawn error handling
- Path validation utility with symlink rejection for vault scanner
- Search log rotation (>10MB triggers rotation)
- Database cleanup on transport close
- Background extraction process timeout (5 minutes)
- Uninstall correctly handles agent-type hooks (previously crashed on missing `command` field)
- Uninstall cleans up `.mcp.json`, project-scope settings, and CLAUDE.md sections
- Config defaults in init aligned with schema defaults in loader

### Removed

- Regex-based auto-extraction disabled by default (produced 97% noise)
- `memory-session-end.ts` hook script (replaced by agent Stop hook)
- `extract-from-transcript.ts` CLI script (only called by disabled hooks)
