# Pillar Task Backlog — subagent-driven execution

Branch: `feat/revolution-pillars` (off `main` which holds Pillar 1).
Each task = one vertical TDD slice (RED→GREEN→REFACTOR), atomic commit, full suite green.
Per task: implementer subagent → spec review → code-quality review → mark done.

Status legend: [ ] todo · [~] in progress · [x] done

## Pillar 1 — Real graph spine ✅ (done on main, slices 1–6)

## Pillar 2 — Bi-temporal correctness
- [ ] T1 — Migration v6: add `valid_from`, `valid_to`, `tx_expired` to `memories` and `memory_links` (created_at = tx_created). Schema fresh-block + migration + bump CURRENT_SCHEMA_VERSION=6. Store sets valid_from=created_at, valid_to/tx_expired NULL. Do NOT add to V4_MEMORY_COLUMNS.
- [ ] T2 — Default retrieval filters to currently-valid (`valid_to IS NULL AND tx_expired IS NULL`) in hybrid search + list; add `as_of` point-in-time param.
- [ ] T3 — `invalidateMemory(id, at)` sets valid_to (no hard delete); wire conflict 'superseded' path; old still queryable via as_of.

## Pillar 3 — Retrieval leap
- [ ] T4 — HippoRAG Personalized PageRank module (power iteration over entity↔memory graph) + node specificity (IDF-analog). Pure, unit-tested.
- [ ] T5 — Fuse PPR as a third ranker into hybrid RRF (behind a flag/weight); multi-hop recall test.
- [ ] T6 — Local cross-encoder reranker stage (Xenova/ms-marco-MiniLM) over top-N; pluggable reranker interface + deterministic stub for tests.
- [ ] T7 — Contextual indexing: deterministic title/section/metadata prefix prepended before embed + FTS.
- [ ] T8 — `memory_query` tool: IDF-weighted seed selection (gap cutoff), hub-avoiding BFS/DFS over memory_links, hard token budget + truncation hint.

## Pillar 4 — Self-correcting writes
- [ ] T9 — ADD/UPDATE/DELETE/NOOP heuristic write-gate in store (cosine + entity overlap + contradiction signal); reports the op.
- [ ] T10 — Local NLI contradiction detection over similar-shortlist → bi-temporal invalidation (deterministic stub classifier for tests).
- [ ] T11 — Forgetting-curve stability model: per-memory `stability`, retention e^(−Δt/S) as ranking multiplier + prune signal; access bumps stability.

## Pillar 5 — Agent-OS memory
- [ ] T12 — `core_memory` block (table + tools core_memory_get/append/replace), bounded per scope/namespace.
- [ ] T13 — Hot/recall/archival tier views from access_count/condensation_level.
- [ ] T14 — `memory_reflect` tool: returns high-importance recent memories for the agent to synthesize; stores insight with provenance='reflection'.
- [ ] T15 — GraphRAG communities (local Leiden/Louvain/label-propagation) + community store; `memory_global_search` over community summaries.

## Pillar 6 — Obsidian-grade vault
- [ ] T16 — Bidirectional vault write-back: memory → `.md`+frontmatter; lossless export↔import round-trip.
- [ ] T17 — `memory_canvas` tool: emit valid JSON Canvas 1.0 `.canvas` from a query/namespace.
- [ ] T18 — Memory wiki / Publish: read-only web routes for a namespace (pages, backlinks, graph, search), selective by access_level.
- [ ] T19 — Auto session-notes + per-document_type templates on store.

## Pillar 7 — Team + solo + interactive init
- [ ] T20 — Interactive `memory init` wizard (solo/team, scope, storage, vault path, commit-graph?, auto-capture) → config.json; non-interactive/answers-injection mode for tests.
- [ ] T21 — Git union merge driver for the committable graph artifact + `memory export-graph` to a committable file.
- [ ] T22 — Actor attribution: `agent_id`/`author` on writes; expose in provenance.

## Pillar 8 — Trust / enterprise
- [ ] T23 — "Questions to ask" digest tool from AMBIGUOUS edges + ghost-node gaps + low-cohesion communities.
- [ ] T24 — GDPR: soft-delete/tombstone + export-before-delete guard + point-in-time history surface.
- [ ] T25 — Prompt-injection sanitization on all stored/LLM-derived strings entering MCP tool output.
- [ ] T26 — Hot-reload graph/index by (mtime_ns,size) so background writers are picked up live.

## Finalization
- [ ] F1 — Register all new MCP tools in server.ts (rolling, per task) + update OpenAPI.
- [ ] F2 — Docs: README, RUNBOOK, ADRs, CHANGELOG bump.
- [ ] F3 — Final integration code review + full stress re-run + finishing-a-development-branch.
