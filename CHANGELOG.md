# Changelog

All notable changes to the MCP Memory Server are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [2.0.0] - 2026-05-29

The "revolution" release: 8 pillars expand the server from 17 to 37 MCP tools.
Database schema migrated to **v9** via additive migrations. All new behaviors
are **additive and opt-in** — existing tools, defaults, and stored data are
preserved (e.g. search stays hybrid-by-default; graph/rerank/point-in-time
features only activate when their flags are passed; `memory_forget` is additive
to `memory_delete`).

### Added

**Pillar 1 — Bi-temporal memory**

- Valid-time (`valid_from`/`valid_to`) alongside transaction-time; updates *invalidate-don't-delete* so history is never lost
- `as_of: <timestamp>` point-in-time recall on search and reads
- `memory_history` tool: full bi-temporal timeline + edit versions for one memory

**Pillar 2 — Knowledge graph**

- Confidence-tagged `memory_links` (wikilink / co-occurrence / similarity edges) and entity co-occurrence
- `memory_graph` multi-hop entity traversal (depth 1–3) and `memory_extract_entities`
- HippoRAG Personalized-PageRank multi-hop retrieval via `use_graph: true` on search
- `memory_query`: token-budgeted, hub-avoiding subgraph traversal that answers a question without flooding context
- `memory_communities`: GraphRAG community detection (weighted label propagation) for corpus-level themes

**Pillar 3 — Retrieval**

- Cross-encoder reranking via `rerank: true` on search
- Contextual indexing

**Pillar 4 — Self-correcting writes**

- ADD / UPDATE / DELETE / NOOP write gate (`on_conflict`)
- NLI cross-encoder contradiction detection
- Forgetting-curve `stability` signal

**Pillar 5 — Agent-OS memory**

- Pinned, bounded core-memory block: `core_memory_get` / `core_memory_append` / `core_memory_replace`
- `memory_tiers`: MemGPT-style hot / recall / archival distribution + hot working set
- `memory_reflect`: Generative-Agents-style reflection (gather material / store insight)

**Pillar 6 — Obsidian-grade vault**

- `memory_export_vault`: bidirectional `.md` write-back with lossless YAML frontmatter (reverse of `vault_sync`)
- `memory_canvas`: JSON Canvas 1.0 `.canvas` export
- Read-only memory wiki / Publish routes (`/publish/:namespace`), hard-scoped to published access levels
- `memory_session_note` (per-session daily note) and `memory_template` (structured note scaffolds)

**Pillar 7 — Team & solo sharing**

- Interactive `memory init` wizard (with `--yes` for all-defaults)
- Committable graph artifact: `export-graph` CLI → deterministic `memory-graph.json`
- `git-setup` CLI: installs `.gitattributes` + `memory-union` git merge driver (`merge-graphs`) for conflict-free sharing
- `memory_attribution`: per-`agent_id` rollup (default agent via `MCP_AGENT_ID`)

**Pillar 8 — Trust & governance**

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
