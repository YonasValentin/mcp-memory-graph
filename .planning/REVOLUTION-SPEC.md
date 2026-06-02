# MCP Memory Server — Revolution Spec

> The design contract for turning mcp-memory-server into a local-first, agent-native,
> bi-temporal **knowledge-graph memory vault** — better than Obsidian and graphify.
> Date: 2026-05-29. Source research: `.planning/research/00–06`.

## Thesis

A 100%-local, agent-native, **bi-temporal knowledge-graph memory vault** that fuses:
- **graphify** — confidence-tagged graph (`EXTRACTED`/`INFERRED`/`AMBIGUOUS`), git-committable artifact, token-budgeted hub-avoiding traversal, "questions to ask" from ambiguity.
- **Obsidian / basic-memory** — ownership (plain markdown source of truth), `[[wikilinks]]` + backlinks + ghost nodes, graph view, JSON Canvas, Publish.
- **Zep/Graphiti** — bi-temporal validity (valid-time vs tx-time), invalidate-don't-delete, point-in-time queries.
- **mem0 / HippoRAG / MemGPT / GraphRAG / A-MEM** — ADD/UPDATE/DELETE/NOOP write gate, Personalized-PageRank multi-hop, self-editing core-memory tiers, community global-search, memory evolution.

**No-cloud invariant:** the server only does cheap deterministic local work (graph math, local embeddings, NLI on shortlists, decay, clustering). Every genuinely-generative step (summaries, reflection, ambiguous adjudication) is exposed as an **agent-driven MCP tool** — the consuming Claude agent *is* the LLM. No API key ever required for the core path.

**Sharing model = Bruno, not Postman:** files in the repo are the source of truth (markdown vault + committable `graph.json` with a git **union merge driver**); `git pull` shares team memory; SQLite is a rebuildable index. Optional self-hosted remote namespace. Solo and team. MIT.

## Non-negotiable principles

1. **TDD always** — red → green → refactor, one vertical slice at a time, atomic commit per slice, full suite green between slices. (superpowers:test-driven-development)
2. **Local-first, no cloud dependency** in the core path; agent-in-the-loop for generative steps.
3. **Markdown vault = source of truth; SQLite = cache.** Lossless `memory_export` ↔ `memory_import` round-trip is sacred (no lock-in).
4. **Confidence-tagged everything.** Every inferred edge/fact carries `EXTRACTED|INFERRED|AMBIGUOUS` + score.
5. **Invalidate, don't delete.** Bi-temporal supersession; soft-delete/tombstone; export-before-delete.
6. **Match existing codebase patterns exactly** (TS strict, ESM, zod schemas, better-sqlite3 prepared statements, vitest, structured logger, c8 coverage). No new patterns without reason.
7. **Sanitize all stored/LLM-derived strings** before they enter MCP tool output (prompt-injection defense — graphify F-010).
8. **Backward compatible** — existing 452 tests must stay green; migrations are additive + versioned.

## The 8 Pillars (build foundation-first)

### Pillar 1 — Real graph spine (fixes battle-test F1)
- New `memory_links` table: resolved memory↔memory edges `(source_id, target_id, relation, confidence, confidence_score, source_kind, evidence_count, created_at, valid_from, valid_to)`.
- Auto-build edges on store + vault-sync, each tagged:
  - **Wikilink** `[[X]]` resolved to target memory by title/alias → `relation='links_to'`, `EXTRACTED` (1.0). Unresolved → ghost node / knowledge gap.
  - **Entity co-occurrence** — memories sharing an entity → `relation='co_occurs'`, `INFERRED`; entity↔entity `entity_relationships` populated via `findOrCreateRelationship` (wires the dead code found in F1).
  - **Vector "unlinked mentions"** — cosine > τ between memory embeddings → `relation='similar_to'`, `INFERRED` + score (Obsidian unlinked-mentions, automated).
- Backlinks = inverse index (free). Expose on `memory_get`.
- `memory_graph` / `/api/graph` read the persistent edge store (not render-time KNN only); depth param for local graph.
- **Done when:** 5k-memory stress shows non-zero `memory_links` + `entity_relationships`; wikilink round-trip produces edges; graph tool returns real neighbors with confidence tags.

### Pillar 2 — Bi-temporal correctness
- Add `valid_from, valid_to, tx_created, tx_expired` to `memories` and `memory_links`/`entity_relationships`.
- Default retrieval predicate: `valid_to IS NULL AND tx_expired IS NULL`.
- Supersession sets old `valid_to = new.valid_from` (never hard-delete).
- New tool/param: point-in-time query (`as_of` date) → "what was true on date X".

### Pillar 3 — Retrieval leap
- **HippoRAG Personalized PageRank** over the entity/memory graph as a third ranker fused into existing RRF; node specificity = IDF-analog; ~power-iteration in TS, no native dep.
- **Local cross-encoder reranker** (`Xenova/ms-marco-MiniLM-L-6-v2`) over top-N RRF candidates.
- **Contextual indexing** — deterministic title/section/metadata prefix prepended before embed + FTS (agent-generated blurb optional).
- **graphify-style traversal** — IDF-weighted seed selection (gap cutoff), hub-avoiding BFS/DFS (p99 degree), hard token budget with actionable truncation hint.

### Pillar 4 — Self-correcting write gate
- `memory_store` becomes ADD/UPDATE/DELETE/NOOP gate: retrieve similar → decide (heuristic: cosine thresholds + entity overlap + contradiction signal; agent adjudicates ambiguous).
- **Local NLI contradiction detection** (small MNLI cross-encoder) over the similar-shortlist at write time → bi-temporal invalidation (Pillar 2).
- **Forgetting curve** — per-memory `stability`, retention `e^(−Δt/S)` as ranking multiplier + prune signal; access bumps stability.

### Pillar 5 — Agent-OS memory
- Pinned `core_memory` block per scope/namespace (bounded), self-edited via `core_memory_append`/`core_memory_replace`.
- Hot/recall/archival tiers from `access_count`/`condensation_level`.
- `memory_reflect` tool (agent synthesizes insights from high-importance recent memories → stored with `provenance='reflection'`).
- GraphRAG **communities** (local Leiden/Louvain/label-prop) + `memory_global_search` (community summaries written by agent).

### Pillar 6 — Obsidian-grade vault
- **Bidirectional write-back** — memories ↔ `.md`-with-frontmatter; lossless round-trip; watch for external edits (basic-memory parity+).
- **JSON Canvas export** — `memory_canvas` emits valid `.canvas` (jsoncanvas 1.0) openable in real Obsidian.
- **Memory wiki / Publish** — read-only web view of a chosen namespace/scope: pages, backlinks, graph, search; selective publish by `access_level`; behind existing tunnel/bearer.
- Auto **session notes** + per-`document_type` templates.

### Pillar 7 — Team + solo + interactive init
- **`memory init` terminal wizard** (mattpocock `/setup` style) — interactive prompts with smart defaults, user selects instead of hand-editing config:
  1. Solo vs Team mode.
  2. Default scope (global/project/user/team/department) + namespace for this repo.
  3. Storage: DB location, vault path for `.md` round-trip, whether to commit `graph.json` to git, optional remote share endpoint.
  4. Auto-capture: opt into Claude Code hooks (session capture, learning extraction, auto graph rebuild on commit).
  - Writes `~/.mcp-memory/config.json` (or `--project` → repo-local), prints `git add` hints.
- **Git union merge driver** for `graph.json` (graphify) — conflict-free team sharing via `git pull`.
- **Actor attribution** — `agent_id`/`author` on writes for multi-agent/team provenance.

### Pillar 8 — Trust / enterprise
- Confidence tags surfaced + **"questions to ask" digest** from `AMBIGUOUS` edges + low-cohesion communities + ghost nodes.
- **GDPR-grade**: `access_level`, soft-delete/tombstone, export-before-delete, full audit (`memory_access_log`), point-in-time history.
- **Prompt-injection sanitization** (`sanitize_label`-style) on every stored/derived string entering MCP output.
- **Hot-reload** graph/index by `(mtime_ns, size)` so a background writer/git-hook rebuild is picked up live.
- Async/non-blocking write path; per-actor identity; SBOM/CI already present.

## Architecture notes
- New code mirrors existing module layout: `src/graph/*` (edge building, PPR, communities, NLI), `src/search/*` (rerank, PPR fusion, contextual), `src/temporal/*` (bi-temporal, forgetting), `src/vault/*` (write-back, canvas), `src/cli/init.ts` (wizard — already exists, extend), `src/publish/*` (wiki), `src/tools/*` (new MCP tools).
- All schema changes via additive, versioned migrations in `src/db/migrations.ts`.
- Each new capability gets a focused test file under `src/__tests__/`.

## Definition of "done / revolutionary + enterprise-ready"
- All 8 pillars implemented, each TDD-covered; full suite green; coverage ≥ current.
- 5k–10k-memory stress: non-empty multi-signal graph, sub-10ms hybrid+PPR search, bi-temporal point-in-time correct, write-gate dedups/invalidates, no leak.
- `memory init` wizard onboards solo + team with zero hand-editing.
- Vault `.md` round-trip lossless; JSON Canvas opens in Obsidian; memory wiki serves a namespace.
- Docs (README/RUNBOOK/ADRs) updated; CHANGELOG bumped; clean `npm audit`/`build`/`test`.
