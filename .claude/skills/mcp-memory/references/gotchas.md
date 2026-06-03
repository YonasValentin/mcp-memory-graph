# Gotchas — sharp edges that bite

The non-obvious behaviors. Most cost you an hour if you don't know them. Grouped by who hits them. Items tagged **(verified)** were reproduced hands-on against the real handlers; **(fixed <sha>)** were corrected in the battle-overhaul pass.

## Contents
1. Recall surprises (driver)
2. Write / edit surprises (driver)
3. Vault surprises (driver)
4. Scale & cost (both)
5. Correctness invariants (contributor)

---

## 1. Recall surprises

- **Privacy default hides `scope='user'`.** (verified) An unscoped `memory_search` forces `scope != 'user'`. A "missing" memory is most often a user-scoped one — re-search with explicit `scope:'user'`. (`memory_list`/`memory_export` do NOT filter this way.)
- **Rerank divergence — same query, different order by entry path.** (verified) `memory_search` over MCP defaults `rerank:true` (P@1 ≈ 0.81). REST `/api/search` + direct `handleSearch` leave it **off** (P@1 ≈ 0.56). Empirically rerank adds ~165–260ms and reorders results. Pass `rerank:false` to match REST.
- **`as_of` reconstructs *validity*, not *content*.** (verified) A point-in-time query returns which memories were valid then — but their **current** content. Historical-content reconstruction (R1 residual) is unbuilt.
- **`as_of` reconstructs retired/superseded facts in ALL search modes** (fixed, real-model verified). A point-in-time query returns every fact whose validity window covered the instant — including via `search_mode:'vector'` — because the retired fact's vec row is now retained on invalidation and `superseded_at` is filtered only in current mode. (Earlier the vec row was dropped, so vector-mode as_of silently returned nothing for retired facts.) Current/non-as_of search still excludes them.
- **`memory_search` result shape changes with `detail_level`.** (verified) `summary`/default → flat hit `{ id, title, score, confidence, ... }`; `full` → wrapped `{ memory: { id, content, ... }, score, confidence, match_type, age_days, ... }`. Read id/content via `result.memory?.id ?? result.id` or you silently get `undefined` after asking for `full`.
- **The RRF `score` is not a confidence.** (verified) It's a ~0.02 fusion artifact. Use the `confidence`/`confidence_label` the search attaches, or raw cosine via `memory_related`.
- **`memory_graph.strength` is a display value**, `1-1/(1+evidence_count)` (0.5 at one witness). The real IDF edge weight PageRank ranks on is now surfaced separately as **`idf_strength`** (fixed) — read that to inspect the IDF weight.
- **`memory_search` is not read-only.** (verified) It records access (bumps access_count/importance/stability + logs).

## 2. Write / edit surprises

- **`memory_delete` is a hard delete** — cascades, bypasses the bitemporal model. For anything recoverable or governed, use `memory_forget` (soft tombstone, or hard-with-export-first). (verified: hard-forget exports first, then cascades, with zero FTS/vec residue.)
- **The NLI write-gate is wired in `server.ts`, not in `handleStore`.** (verified) `memory_store` only runs NLI contradiction detection when a classifier is passed — `server.ts` wires the lazy `CrossEncoderNli` for the **MCP path**, so over MCP it runs on every store's near-dup shortlist (a real negation is kept + the old fact invalidated). A **direct handler call or REST helper that doesn't pass `nli` gets NO contradiction detection** — only the Jaccard heuristic, which cannot see negations. (Mirrors the tenancy gotcha in §5.)
- **`supersede` only fires when a close-enough contradicting neighbor is found** (NLI distance ≤ 0.7, top-10). (verified) Otherwise it falls back to ADD and emits `superseded_nothing` — observe that signal.
- **`importance_score` is now settable** on `memory_store`/`memory_update` (fixed) — an explicit 0–1 wins; omitted → derived from content. `min_importance` filters operate on this value.
- **Soft-forget is recoverable via `memory_restore`** (fixed, real-model verified). `memory_forget {hard:false}` stamps `valid_to`; **`memory_restore` now un-tombstones** — it clears `valid_to`/`tx_expired` (via `reinstateMemory`, the inverse of `invalidateMemory`) so the memory re-enters default recall, and mirrors the vault file back from `.memory/deleted/`. The vec row was retained on invalidation, so no re-embed is needed. `memory_restore` applies un-tombstone AND un-condense together when both hold; it does NOT clear `superseded_at` (a fact retired by a contradicting supersession is recovered through its supersession chain, not un-tombstoned). `memory_update` still does NOT clear the stamp.
- **Core memory append refuses on overflow** (`core_memory_full`) — by design. Compact via `core_memory_replace`. Namespace `''` and `undefined` collapse to one row; replace swaps only the **first** occurrence.
- **`memory_session_note` and `core_memory_append` grow unboundedly** — no size cap (verified: 200 appends → 18KB, re-embedded each call).

## 3. Vault surprises

- **`vault-init` is required for team merge.** (verified) It writes `.gitattributes` binding the union-merge driver (and installs a post-merge hook that auto-runs `rebuild`). `memory_export_vault` alone does not — without it the graph sidecar won't union-merge.
- **Vault `.md` round-trip resets `confidence` / `access` / `stability`.** (verified, fixed-partial) Those three aren't emitted to frontmatter, so they reset to defaults on `vault_sync`. `id`/`scope`/`namespace`/`document_type`/content **and now `importance_score` + `created_at`/`updated_at`** are preserved (the latter three were also being dropped before the overhaul — now recovered from frontmatter). Still **not** a full-fidelity backup — use `memory_export`/`memory_import` (JSON) for that.
- **`vault rebuild` hard-deletes the DB first.** The vault must be the true source of truth; a partial/failed rebuild loses the index.
- **The graph sidecar drifts from live edits.** `.memory/graph.json` is written by `sync`/`vault-init`, **not** by incremental write-through — live edits diverge until the next full `sync`.
- **Two vaults with the same basename collide** (verified) — `vault_search`/`vault_status`/`memory_canvas` derive namespace from `basename(vault_path)`, so counts AND results cross-contaminate.
- **`memory_unlinked_mentions` excludes only `wikilink`/`co_occurrence`/`typed` links** (verified) — a `manual` or auto `similar_to` edge is NOT excluded and still surfaces. Fine for pure Obsidian flows (vault links are `wikilink`).
- **Chunkers are not section/clause-aware.** (verified) `structured` silently uses paragraph chunking; `legal`/`text` pack by sentence/paragraph to ~`chunk_size` and straddle `##` headings. `markdown` is heading-aware but re-splits oversized sections. For clause-level chunks, pre-split and ingest per clause.

## 4. Scale & cost

- **O(n) brute-force KNN, no ANN.** (verified) Search p50 ≈ 1 / 4 / 17 ms at 1K / 10K / 50K rows; p95 stays sub-second to 50K; crosses ~1s only in the low millions. Fine for homelab/single-user; not a 10M-vector store.
- **Store throughput drops with corpus size** (verified: 92 → 69 → 26 rows/sec at 1K → 10K → 50K): every store runs two O(n) KNN scans (conflict + dedup) plus an embed.
- **Rerank adds a ~constant ~200ms** (verified: ~195–208ms avg, flat across 1K–50K; scores a fixed top-50). Skip with `rerank:false` for latency-sensitive bulk reads.
- **`memory_stats.database_size_bytes` = `page_count*page_size`** of the live connection (verified) — works for `:memory:` and WAL, but **includes the sqlite-vec shadow tables**, so a near-empty DB reads ~1.9MB. It is NOT the on-disk file size.
- **`memory_consolidate` `dry_run` UNDER-counts merges.** (verified, known limitation) Apply re-embeds merged content and deletes rows mid-pass, changing which neighbors later probes find, so the real run can merge MORE than the preview shows. Treat `dry_run` as a lower bound, not an exact plan.
- **Embedding model is 384-dim MiniLM, CPU-only.** First tool use downloads ~30MB to the HF cache. Mid-pack accuracy — the moat is $0/token + 0% cloud exposure, not top-of-leaderboard precision.

## 5. Correctness invariants (contributor — keep these true)

- **Timestamp collation = data loss if violated.** Any code path writing OR lexically range-comparing a timestamp (`updated_at`, `valid_to`, **`expires_at`**, `condensed_at`, `superseded_at`) MUST use ISO-Z via the `NOW_ISO_SQL` constant (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`), **never** `datetime('now')` (space-separated, sorts before `'T'`). The overhaul routed the five `expires_at` comparison sites + the condensed/superseded writes through `NOW_ISO_SQL` (fixed) — before that, same-day-expired rows LEAKED into search and escaped prune. *Residual:* rows written with space-format before the fix stay vulnerable until re-edited; no normalizing migration exists.
- **`memory_list` applies NO `expires_at` filter** (verified) — only `valid_to`/`tx_expired`. Expired (but still-valid) rows appear in `memory_list` by design; `memory_search`/`memory_stats` do filter expiry (correctly, post-fix).
- **vec0 rows are RETAINED on bitemporal invalidation** (so `as_of` vector reconstruction works — §1). `invalidateMemory` only stamps `valid_to`; only a HARD delete (`deleteMemory`/`memory_forget hard`) drops the vec row; `consolidate` prunes retired vecs in bulk. Therefore every direct `memories_vec` (`embedding MATCH`) consumer MUST filter retired rows by `valid_to`/`tx_expired`/`superseded_at`. Current consumers do: hybrid current mode (WHERE), `handleRelated`, `detectConflicts`, `findNearDuplicates`. A new raw `MATCH` consumer that forgets to will surface tombstoned rows.
- **`entity_aliases` resolution now reaches the entity-seed paths** (fixed). `memory_extract_entities` stores aliases; resolution is centralized in `entity-store.ts` (`resolveToCanonicalName` single-name, `entityIdsByNameOrAlias` batch — the one source, used everywhere). **`memory_graph`** resolves an alias → its entity (direct entity-name match wins), and **`memory_search {use_graph:true}` + Personalized PageRank** now seed the canonical entity from an alias too (`linkQueryEntities` goes through `entityIdsByNameOrAlias`) — a query naming only `PG`/`k8s` seeds `PostgreSQL`/`Kubernetes`. **Residual:** `memory_query` content-seeds (its seed `hybridSearch` runs with `use_graph` off by the original design), so it does NOT alias-expand unless that flag is enabled; plain `memory_search` (no `use_graph`) and FTS/vector matching are still literal. Merging entities by the SAME spelling (`normalizeName` collapses `Node.js`/`nodejs`/`node js` → one) remains the most universal path.
- **Tenancy is enforced at `server.ts`, not in handlers.** (verified) Calling a handler directly bypasses `withForcedNs`/`idInForcedNs`; REST re-applies `forcedApiNamespace`. A scoping fix must land in **both** paths. (Foreign-namespace by-id reads return 404/not-found — existence non-confirmation, by design.)
- **`getReadOnlyDb` asserts-don't-migrate** (verified) — it now throws on a below-CURRENT DB rather than silently migrating. "Read-only" CLI commands no longer ALTER schema on first call.
- **Frontmatter proto-pollution sanitization is TOP-LEVEL only.** (verified) `__proto__`/`constructor`/`prototype` are stripped at the top level; a nested `meta.__proto__` survives in the parsed object (safe today — nothing deep-merges it). Don't deep-merge arbitrary nested frontmatter into shared objects without re-sanitizing.
- **`logger` redaction is shallow** (top-level keys only) — secrets nested in objects, or keys like `bearer`/`pwd`/`access_token`, pass through. Never log a token-bearing object.
- **No `.max()` on the search `query`** (verified) — a 100k-char query is accepted and embedded. Not exploitable (parameterized + bearer-authed), but rely on `MCP_BODY_LIMIT`/Cloudflare for size control on the REST surface.
- **Reuse `src/db/predicates.ts`** for any new live-row aggregate (`liveConditions`/`NOW_ISO_SQL`) — `export`/`stats`/`manifest` divergences and the expires_at leak both came from re-implementing the predicate.
