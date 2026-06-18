# Tool reference (all 51)

One database, one model, $0/token. Every result is sanitized (ANSI/control/Trojan-Source stripped) before it leaves the server. Tools below are grouped by job; key params are noted inline.

## Core CRUD + retrieval

- **`memory_store`** — store one memory; embedding auto-generated. Params: `content` (req), `title` (always pass), `scope`, `namespace`, `on_conflict` (`add`|`supersede`|`skip`), `importance_score`, `document_type`, `tags`, `access_level` (default `internal`), `department`, `source`, `author`, `language`, `metadata`, `expires_at`, `agent_id`.
- **`memory_search`** — hybrid vector+keyword (RRF), rerank ON for MCP. Params: `query` (req), filters (`scope`, `namespace`, `department`, `document_type`, `tags`, `access_level`, `language`), `limit` (10), `offset`, `search_mode` (`hybrid`|`vector`|`keyword`), `use_graph`, `as_of`, `temporal_decay`, `date_from`/`date_to`, `min_confidence`, `detail_level` (`summary`|`full`). Returns `score`, `confidence`, `confidence_level`, `match_type`. Unscoped search HIDES `scope:"user"`.
- **`memory_get`** — fetch one by `id`; `include_chunks:true` for ingested docs.
- **`memory_update`** — change `content` (re-embeds), `title`, `metadata`, `tags`, `expires_at`; prior version saved to history. `changed_by` for audit.
- **`memory_delete`** — HARD delete by `id` or `filter` (`scope`/`namespace`/`department`/`before_date`/`expired_only`). Prefer `memory_forget`.
- **`memory_list`** — browse with filters, `sort_by` (`created_at`|`updated_at`|`title`), `sort_order`, pagination.
- **`memory_ingest`** — chunk + embed a full document; `content_type` (`text`|`markdown`|`code`|`legal`|`structured`), `chunk_size` (512), `chunk_overlap` (50). Use for large docs.
- **`memory_related`** — vector-similar neighbors of a memory `id`; `limit`, `min_similarity`.
- **`memory_versions`** — list version records for a memory `id`.
- **`memory_version_diff`** — line-level diff between two stored versions.
- **`memory_version_restore`** — roll a memory back to a prior version (snapshots current first).
- **`memory_history`** — bi-temporal point-in-time timeline + edit history for one memory.
- **`memory_stats`** — counts, breakdowns by scope/department/type, storage size, expired count.
- **`memory_manifest`** — content-free index (titles, types, tags, scores) to discover what exists cheaply.
- **`memory_query`** — answer a question with a tight, token-budgeted subgraph (not a flat list). `max_hops`.
- **`memory_query_structured`** — exact metadata filter query, no semantic ranking.
- **`memory_export`** — JSON of currently live top-level memories (max 1000; not a full backup; no history/graph/chunks).
- **`memory_import`** — import JSON memory objects; `overwrite` to replace existing IDs.

## Knowledge graph

- **`memory_graph`** — traverse entities + relationships + linked memories, depth 1–3.
- **`memory_extract_entities`** — store LLM-extracted entities and relationships for a memory.
- **`memory_unlinked_mentions`** — entity names mentioned in text with no edge yet (suggested links).
- **`memory_link_check`** — validate a memory's `[[Title]]` wikilinks: reports which resolve to a live memory and which are dangling. Pass `id` for one memory.
- **`memory_communities`** — GraphRAG community detection over the entity graph (corpus-level themes).
- **`memory_consolidate`** — the dream cycle: Score → Expire → Prune → Dedup → **Promote** → Gaps. `dry_run:true` FIRST. `similarity_threshold` (0.85), `prune_expired`, `prune_low_quality`, `max_operations`, scope/namespace limits. The nightly run also auto-promotes the top lessons/incidents into `core_memory` (always-in-context) — config `consolidation.auto_promote_lessons` (default on), `promotion_importance_floor`, `promotion_max_entries`.
- **`memory_extract_learnings`** — heuristically mine a transcript for decisions/patterns/error_fixes/conventions/incidents/lessons; `auto_store` (true).

## Agent-OS + core memory

- **`core_memory_get`** — read the pinned, always-in-context block for a `(scope, namespace)`.
- **`core_memory_append`** — append to that block; refused if it would overflow `char_limit` (forces compaction).
- **`core_memory_replace`** — replace text in the block (update/compact it).
- **`memory_tiers`** — MemGPT-style hot/recall/archival distribution + the hot working set.
- **`memory_reflect`** — gather reflection-worthy memories, or (store mode) persist a synthesized insight linked to sources.
- **`memory_session_note`** — per-session daily note (appends to one memory per `session_id`).
- **`memory_session_state`** — resumable "where was I" state, save and resume (versioned).
- **`memory_expertise`** — per-user expertise profile: observe a topic, or get the profile.
- **`memory_condense`** / **`memory_restore`** — apply agent summaries to shrink old memories (original preserved) / restore to original and re-embed.
- **`memory_template`** — fetch a structured note scaffold per document type.
- **`memory_lesson`** — capture a structured lesson/incident in one call: fills the matching template (incident → Symptom/Root Cause/Fix/Prevention; lesson → What/Why it matters/How to apply) from `fields` and stores it via the normal deduped write path. `document_type` (default `lesson`).

## Vault (Obsidian round-trip)

- **`vault_sync`** — scan a vault, parse frontmatter/wiki-links/tags, embed and store. `vault_path` (req), `force`, `include_patterns`, `exclude_patterns`. Incremental by mtime.
- **`vault_status`** — files synced/pending/changed + last sync time.
- **`vault_search`** — hybrid search scoped to one vault (defaults to the vault folder's namespace; pass `namespace`/`scope` if a fresh sync returns nothing).
- **`memory_export_vault`** — write memories out as `.md` with round-tripping YAML frontmatter (reverse of `vault_sync`).
- **`memory_canvas`** — export the graph as a JSON Canvas 1.0 `.canvas` for Obsidian.

## Governance + trust

- **`memory_forget`** — GDPR-grade: soft tombstone (recoverable, visible via `as_of`) by default; `hard:true` returns a portability export then erases.
- **`memory_verify`** — check the signed provenance envelope (ed25519): per-memory `ok`/`unsigned`/`content_mismatch`/`bad_signature`/`untrusted` + summary. Signing via `MCP_SIGN_MEMORIES`.
- **`memory_questions`** — "questions to ask" digest: ambiguous links, under-documented entities, orphans, stale.
- **`memory_attribution`** — roll up how many valid memories each `agent_id` wrote.
- **`memory_export_dataset`** — export learnings/reflections as JSONL training pairs (`pairs`/`chatml`/`alpaca`).

## Active infrastructure

- **`memory_webhook`** — event bus (gated by `MCP_WEBHOOKS`): register/list/delete SSRF-validated targets, or dispatch the durable HMAC-signed queue. Emits created/updated/superseded/deleted/forgotten events.
- **`memory_insights`** — advisor digest: unresolved conflicts, stale memories, most-contradicted facts, evidence-less decisions.
- **`memory_health`** — store health roll-up: live/retired/stale counts, aging buckets, conflicts, webhook delivery health.
- **`memory_revalidate`** — change propagation: list stale, preview a change's blast radius (dry run), or confirm a memory is current.
