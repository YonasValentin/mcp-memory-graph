# Architecture (contributor reference)

This is the navigable map. The **exhaustive** reference is `/.planning/CODEBASE-MAP.md` in the repo (642 lines, every subsystem + every gotcha) — read it for depth; read this to orient.

## Contents
1. The six interlocking models
2. Layers & key files
3. Data model (SQLite schema v9)
4. Request lifecycles (store / search)
5. Single-source modules

---

## 1. The six interlocking models

1. **Vector search** — local embeddings (Transformers.js `Xenova/all-MiniLM-L6-v2`, 384-dim) in a `sqlite-vec` virtual table; semantic KNN.
2. **Hybrid search** — vector KNN + FTS5 lexical + (opt-in) HippoRAG Personalized-PageRank, fused by **Reciprocal Rank Fusion (K=60)**, then importance-boosted, temporally decayed, optionally cross-encoder reranked.
3. **Knowledge graph** — entity graph (`entities`/`entity_relationships`) + memory↔memory graph (`memory_links`, IDF-weighted, confidence/provenance-tagged). Powers PageRank recall, GraphRAG communities, unlinked-mention discovery.
4. **Obsidian vault mirror ("Bruno model")** — memories serialize to per-memory `.md` files with YAML frontmatter; the DB is a throwaway cache rebuildable from the files. + JSON Canvas + a git-union-merge `.memory/graph.json` sidecar.
5. **Bi-temporal memory** — facts are *invalidated, not deleted* (valid-time `valid_from`/`valid_to`, transaction-time `created_at`/`tx_expired`), enabling `as_of` point-in-time queries.
6. **Self-correcting + agentic memory** — mem0-style write classification (ADD/UPDATE/DELETE/NOOP), local NLI contradiction detection, MemGPT core memory + tiers, Ebbinghaus forgetting curve, "dream cycle" consolidation. **No LLM runs in the server** — agent-driven tools push synthesis to the caller.

## 2. Layers & key files

```
src/index.ts        argv router → stdio MCP (default) or subcommand
src/server.ts       createServer(): registers all 41 tools; formatResult→sanitizeDeep chokepoint;
                    instrument() wrapper; lazy getDb/getEmbedder/getNli; tenancy (withForcedNs/idInForcedNs)
src/cli/serve.ts    Express 5 app: /mcp /api /publish /health /metrics; all HTTP security
src/tools/*         thin handleX(db,[embedder],input) handlers — Zod parse in server.ts, delegate down
src/db/*            connection · schema (v9) · migrations (forward-only v2..v9) · repository (CRUD) · backup
src/embeddings/*    EmbeddingProvider iface · Transformers.js provider · LRU cache · MockEmbedder (tests)
src/search/*        hybrid orchestrator · scoring (cosine↔L2, confidence) · reranker · temporal · tiers · structured-query
src/graph/*         entity extract/store · pagerank · communities · similarity-edges · contradiction(NLI) ·
                    conflict-resolver · write-gate · memory-links · graph-export(union merge)
src/vault/*         writer · parser · scanner · sync · write-through · canvas · sidecar · rebuild · git-init
src/chunking/*      chunker + 4 strategies (markdown/code/sentence/paragraph)
src/hooks/*         4 Claude Code lifecycle hooks (standalone node, 5s, fail-soft)
src/lib/*           sanitize · logger · path-validation · tenancy · direct-access · hot-reload · line-diff
web/                React 19 + Vite + Tailwind v4 + shadcn + D3 dashboard → /api
```

**Patterns to respect:** lazy memoized resources (`getDb`/`getEmbedder`/`getNli`); per-session `McpServer` on HTTP; all DB access synchronous (no `await` inside any `better-sqlite3` transaction — embed/NLI/rerank happen *before* the txn); single output chokepoint (`sanitizeDeep` only via `formatResult`); determinism in all graph math (fixed iteration/sum order).

## 3. Data model (SQLite schema v9)

**One SQLite file** (`MCP_MEMORY_DB_PATH` ?? `~/.mcp-memory/memory.db`), WAL, `sqlite-vec` loaded.

Core relational tables: `memories` (central; bitemporal cols `valid_from`/`valid_to`/`tx_expired` v6, `stability` v7, `agent_id` v9; 12 indexes), `memory_versions` (pre-edit snapshots), `memory_links` (memory↔memory edges, bitemporal, UNIQUE(source,target,relation)), `core_memory` (PK scope+namespace, `''` sentinel), `entities` / `entity_aliases` / `entity_relationships` / `memory_entities`, `memory_conflicts`, `memory_originals` (condense backup), `memory_access_log`, `ingest_source_tracking`, `vault_sync_meta`, `schema_meta` (k/v: `schema_version`, `embedding_dim`).

Virtual tables: **`memories_vec`** (`vec0`, `embedding float[DIM]`, keyed by `memories.rowid`; `invalidateMemory` drops the vec row on the store-supersede and `memory_forget` paths, but `recordConflicts`' heuristic supersede stamps `valid_to` **without** dropping it — so tombstoned-with-vec rows still occur and any raw `MATCH` consumer must re-filter), **`memories_fts`** (FTS5 external-content over title/content/tags/author/department).

**Triple-table coupling:** every write touches `memories` + `memories_vec` (by rowid) + `memories_fts` inside one `db.transaction()`.

**Migrations:** forward-only, transactional, per-step stamp. An existing DB with no version row stamps the **verified floor (4)**, never CURRENT (stamping CURRENT would skip v5–v9 and brick first write). Shared DDL constants used verbatim by both fresh-create and migration paths.

## 4. Request lifecycles

**Store (`memory_store`):** validate → `contextualizeForEmbedding` then embed (raw content stored, prefix embed-time only) → read-only `detectConflicts` (vec KNN, Jaccard banding, fail-soft) → `decideWriteOperation` (ADD/UPDATE/DELETE/NOOP) → optional **NLI** on near-dup shortlist (async, before txn) → short-circuit NOOP/UPDATE → **atomic txn** `invalidateMemory` + `insertMemory`(memories+vec+fts) + `recordConflicts`(rethrows→rollback) + entity extract (fail-soft) → post-commit `buildSimilarityEdges` + vault `mirrorMemoryWrite` (fail-soft) → `formatResult`.

**Search (`memory_search`):** validate → `withForcedNs` → gather ≤3 candidate sources (vector KNN oversample `min(limit*3,300)`; FTS5; opt-in PPR — vector/FTS failures swallowed) → one filtered fetch (scope/privacy `scope!='user'`/bitemporal/expiry/superseded) → **RRF K=60** → importance boost `(1+importance*0.5)` → optional decay → optional rerank top-N → `computeConfidence` → `min_confidence` → paginate → **`recordAccess`** (sync txn — search is not read-only) → detail_level projection + `max_tokens` budget → `formatResult`.

## 5. Single-source modules (use these, don't re-implement)

- `src/db/predicates.ts` — `liveConditions`/`scopeConditions` (the live-row predicate; retired the export/stats/manifest divergences).
- `src/constants/thresholds.ts` — dedup thresholds (`l2FromCosineSim(0.85)`); retired the extract-vs-consolidate drift.
- `src/lib/tenancy.ts` — `scopeToNamespace`/`scopeFilterToNamespace`/`idIsInForcedNamespace`; one source for MCP + REST forced-namespace.
- `src/constants/enums.ts` — tuples→`z.enum`, types via `(typeof X)[number]`; kills the hand-maintained scope-enum duplication.
- Single `getEmbedder` (promise-memoized) — avoid spawning a second embedder singleton/cache.
