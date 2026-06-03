# Tool Catalog — all 41 MCP tools

Authoritative count: **41** (`grep -c 'server.tool(' src/server.ts`). README's "37"/"17" are stale.
**Param schemas are authoritative at call time** — the live MCP tool definitions (and `src/schemas/index.ts`) are the source of truth for exact params. This catalog gives the *decision-relevant* params + when-to-use, not the full Zod. Params marked `*` are required.

`HTTP` column: ✅ = dedicated `/api` route reusing the same handler; ≈ = approximated via a different path; blank = MCP-only.

## Contents
1. Write / capture (8)
2. Read / retrieve (8)
3. Knowledge graph (3)
4. Edit / version / history (7)
5. Core memory — pinned (3)
6. Vault — Obsidian round-trip (4)
7. Maintenance / governance / diagnostics (8)

---

## 1. Write / capture

| Tool | When to use | Key params | HTTP |
|---|---|---|---|
| `memory_store` | The default write. One discrete fact, decision, pattern, fix, preference. | content*, scope, namespace, on_conflict(add\|update\|supersede), tags, document_type, agent_id, expires_at, importance_score (0–1, settable; else content-derived) | |
| `memory_ingest` | A **large/full document** (not a single fact). Auto-chunks by content_type, embeds each chunk, stores with provenance + parent_id. | content*, content_type(text\|markdown\|code\|legal\|structured), chunk_size, chunk_overlap | |
| `memory_session_note` | Frictionless running capture during a session ("daily note for agents"). First call creates, later calls append to the **same** memory keyed by `session:<id>`. | session_id*, text*, title | |
| `memory_template` | Before storing a structured note — fetch a scaffold (decision→Context/Decision/Consequences; incident→Symptom/Root Cause/Fix/Prevention; learning, bug-fix, meeting, session). Read-only; fill then `memory_store`. | document_type* | |
| `memory_extract_learnings` | Mine a session transcript for decisions/patterns/fixes/conventions via **heuristics (no LLM)**. Dedups against existing; optionally auto-stores. Catches common phrasing, misses subtle. | transcript*, categories, namespace, auto_store | |
| `memory_extract_entities` | Persist **agent/LLM-extracted** entities + relationships for a memory → enables `memory_graph`. The agent analyzes content and supplies structured data (server runs no LLM). | memory_id*, entities[]*, relationships[] | |
| `memory_import` | Restore/migrate memories from JSON (round-trips with `memory_export`). Batch-embeds. Preserves original timestamps + agent_id. | data[]*, overwrite | |
| `memory_reflect` | `mode:gather` (default) returns reflection-worthy memories + an instruction for the agent to synthesize 1–3 insights; `mode:store` persists a synthesized insight (provenance=reflection) and links it to sources. | mode(gather\|store), insight, source_ids[] | |

## 2. Read / retrieve

| Tool | When to use | Key params | HTTP |
|---|---|---|---|
| `memory_search` | **The default recall.** Hybrid vector+FTS5 (RRF). Opt-in: `use_graph:true` (HippoRAG multi-hop), `rerank` (cross-encoder; **default ON at MCP**, OFF on REST), `as_of` (point-in-time validity), `search_mode`(hybrid\|vector\|keyword), `temporal_decay`. | query*, scope, namespace, limit, detail_level, max_tokens, min_confidence | ✅ `/api/search` (rerank OFF) |
| `memory_query` | Answer a **question** with a tight, token-budgeted subgraph instead of dumping many hits. Seeds from hybrid search, walks the memory graph (hub-avoiding) up to max_hops. Returns a `context` string + nodes. | query*, max_tokens, max_hops, seed_limit | |
| `memory_get` | Fetch one memory by id (+ links/backlinks, optional child chunks). | id*, include_chunks | ✅ `/api/memories/:id` |
| `memory_related` | Find vector-similar memories to a given id — connections keyword search misses. | id*, limit, min_similarity | ✅ `/api/memories/:id/related` |
| `memory_list` | Browse/paginate (no query). Bitemporal-filtered. | scope, namespace, sort_by, sort_order, as_of, limit, offset | ✅ `/api/memories` |
| `memory_query_structured` | **Exact, deterministic** property query (Dataview/Bases-style): filter by scope/namespace/dept/document_type/language/tags(AND)/min_importance/created_at-range, sort, paginate, project fields. Use instead of fuzzy search when criteria are precise. | filter{...}, sort, limit, offset, fields[] | |
| `memory_manifest` | Lightweight content-free index (titles/types/tags/scores) — discover **what exists** before expensive searches. | scope, namespace, limit, offset | ✅ `/api/manifest` |
| `memory_unlinked_mentions` | Surface semantically-related-but-unlinked memories (vector-near + shared entities) — Obsidian's "unlinked mentions", automated. Excludes only `wikilink`/`co_occurrence`/`typed` links (a `manual`/`similar_to` edge still surfaces). Then confirm via `memory_extract_entities`. | id*, limit, min_similarity | |

## 3. Knowledge graph

| Tool | When to use | Key params | HTTP |
|---|---|---|---|
| `memory_graph` | Traverse the **entity** graph: find an entity (by canonical name OR a registered alias — direct name wins), its relationships, linked memories. Multi-hop depth 1–3. Each edge carries `strength` (evidence-count display), `evidence_count`, and `idf_strength` (the real IDF weight PageRank ranks on). | entity, entity_type, depth, include_memories, limit | ≈ `/api/graph` (diff path) |
| `memory_communities` | Corpus-level **"what are the main themes?"** GraphRAG sensemaking — detects entity-cluster communities (weighted label propagation) + returns top entities/memories + an instruction to name themes. | limit, min_size | |
| `memory_canvas` | Export the memory graph as **JSON Canvas 1.0** (`.canvas`) — opens as a spatial board in Obsidian. Nodes = memories on a deterministic grid; edges = `memory_links`. Writes into vault if `vault_path` given. | scope, namespace, limit, vault_path, name | |

## 4. Edit / version / history

| Tool | When to use | Key params | HTTP |
|---|---|---|---|
| `memory_update` | Partial edit; re-embeds on content change; snapshots prior version. | id*, content, title, metadata, tags, expires_at, changed_by | ✅ PATCH `/api/memories/:id` |
| `memory_versions` | List edit history (timestamps + who). | id*, limit | ✅ `/api/memories/:id/versions` |
| `memory_version_diff` | Line-by-line diff between two revisions (`to` defaults to current). Audit what an edit changed. | id*, from*, to | |
| `memory_version_restore` | Roll back to a prior version — itself a **versioned, re-embedded** edit (non-destructive). | id*, version*, changed_by | |
| `memory_history` | Bitemporal timeline for one memory (created/updated/valid_from/valid_to/tx_expired/superseded_at/version) + full version history. | id* | |
| `memory_condense` | Apply agent-written summaries to shrink old memories; **preserves original** for restore. Use after `memory_consolidate` flags candidates. | memories[]*, target_level | |
| `memory_restore` | Bring a memory back: un-tombstone a soft-forgotten memory (clear valid_to/tx_expired → default recall) AND/OR undo a condense (restore original content + re-embed). Both when both apply. | id* | Returns `reinstated`/`uncondensed` flags |

## 5. Core memory — pinned (MemGPT-style)

A small, **bounded, always-relevant** block per `(scope, namespace)` — who the agent is / what matters now.

| Tool | When to use | Key params |
|---|---|---|
| `core_memory_get` | Read the pinned block (returns content, char_limit, used). | scope, namespace |
| `core_memory_append` | Append a line. **Refused (`core_memory_full`)** if over char_limit — compact instead of overflowing. | scope, namespace, text* |
| `core_memory_replace` | Replace first occurrence of old_text → new_text. Errors: `not_found`, `core_memory_full`. Use to update/compact. | scope, namespace, old_text*, new_text* |

> Namespace `''` is the sentinel; `undefined` and `''` collapse to the same row. Replace swaps only the **first** occurrence.

## 6. Vault — Obsidian round-trip ("Bruno model")

| Tool | When to use | Key params |
|---|---|---|
| `vault_sync` | Pull an Obsidian vault **INTO** memory: scans `.md`, extracts frontmatter/tags/wikilinks, embeds, stores. Incremental by mtime. Reconciles by frontmatter `id`. | vault_path*, chunk_size, force, include/exclude_patterns |
| `vault_status` | Sync status counts (total/synced/pending/changed, last sync, memory count). | vault_path* |
| `vault_search` | Hybrid search scoped to a vault's namespace. | vault_path*, query* |
| `memory_export_vault` | Write memories **OUT** to the vault as `.md` + YAML frontmatter (reverse of vault_sync). Files parse back losslessly *on identity/content* — but **signal columns reset** on re-import (see gotchas). | vault_path*, scope, namespace |

> For a **team** vault you also need `memory vault-init` (CLI) — it writes `.gitattributes` binding the union-merge driver. `memory_export_vault` alone does NOT. See workflows.md.

## 7. Maintenance / governance / diagnostics

| Tool | When to use | Key params | HTTP |
|---|---|---|---|
| `memory_consolidate` | The **"dream cycle"**: merge near-dupes, prune expired/low-quality, update quality scores, surface knowledge gaps. `dry_run:true` to preview. Runs nightly via cron if `memory init` set it up. | similarity_threshold, prune_expired, dry_run, max_operations, forgetting_floor | |
| `memory_forget` | **GDPR forget** (additive vs delete). `hard:false` (default) soft-tombstones (excluded from default recall, still `as_of`-queryable, recoverable). `hard:true` returns a portability export **first**, then permanently erases (cascades, irreversible). | id*, hard | |
| `memory_delete` | **Hard** delete by id or filter — bypasses the bitemporal model entirely. Prefer `memory_forget` for governance. | id \| filter{scope,namespace,department,before_date,expired_only} | ✅ DELETE `/api/memories/:id` (id only) |
| `memory_stats` | Totals + breakdowns by scope/dept/type + storage size + expired count. | scope, namespace, department | ✅ `/api/stats` |
| `memory_tiers` | MemGPT hot/recall/archival distribution + the hot working set (derived from access recency × frequency). Read-only. | scope, namespace | |
| `memory_attribution` | Multi-agent/team rollup: how many memories each `agent_id` wrote (vs `author` = human/source). Unattributed bucketed separately. | scope, namespace | |
| `memory_questions` | "Questions to ask" digest — what to verify/learn next: AMBIGUOUS links to confirm (verify), under-documented hot entities (gap), disconnected/stale memories (orphan). | scope, namespace, limit | |
| `memory_export` | Export ≤ a page of memories as JSON for backup/migration (live + top-level only; paginated). Round-trips with `memory_import`. | scope, namespace, department, limit, offset | |

---

## Quick picker (which tool when)

- **Save a fact** → `memory_store`. **Save a big doc** → `memory_ingest`. **Running session log** → `memory_session_note`.
- **Recall by meaning** → `memory_search`. **Answer a question compactly** → `memory_query`. **Exact filter** → `memory_query_structured`. **What exists?** → `memory_manifest`.
- **By id** → `memory_get`. **Similar to this** → `memory_related`. **Latent connections** → `memory_unlinked_mentions`.
- **Themes / big picture** → `memory_communities`. **Entity traversal** → `memory_graph`.
- **Edit** → `memory_update`. **Diff/rollback** → `memory_version_diff` / `memory_version_restore`. **Timeline** → `memory_history`.
- **Pinned working context** → `core_memory_*`.
- **Obsidian** → `vault_sync` (in) / `memory_export_vault` (out) / `memory_canvas` (board).
- **Tidy up** → `memory_consolidate`. **Erase (GDPR)** → `memory_forget`. **What to learn next** → `memory_questions`.
