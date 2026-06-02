# mcp-memory-server — Codebase Map

> **Audience:** A new senior engineer who needs to understand every corner of this project.
> **Scope:** Definitive reference. Completeness over brevity. All paths absolute under `/Users/yonasvalentin/Projekter/mcp-memory-server`.
> **Version:** `2.0.0` · **Schema:** `v9` · **MCP tools registered:** `41` (verified `grep -c 'server.tool(' src/server.ts` == 41)

---

## 1. Overview

mcp-memory-server is an **enterprise, single-tenant, local-first, bi-temporal knowledge-graph memory server** exposed over the Model Context Protocol (MCP). It gives a coding agent (Claude Code) durable, queryable, cross-session memory without any cloud dependency: embeddings, vector index, full-text index, and knowledge graph all run in-process against one SQLite file.

### The big idea — six interlocking retrieval/storage models

1. **Vector search** — every memory's text is embedded locally (Transformers.js `Xenova/all-MiniLM-L6-v2`, 384-dim) and indexed in a `sqlite-vec` virtual table for semantic KNN.
2. **Hybrid search** — vector KNN + FTS5 lexical search + (optional) HippoRAG Personalized-PageRank graph recall, fused via **Reciprocal Rank Fusion (K=60)**, then importance-boosted, temporally decayed, and optionally cross-encoder reranked.
3. **Knowledge graph** — two layers: an **entity graph** (`entities` / `entity_relationships`, regex+LLM extraction + co-occurrence) and a **memory↔memory graph** (`memory_links`, confidence/provenance tagged). Powers PageRank recall, GraphRAG community detection, and Obsidian-style unlinked-mention discovery.
4. **Obsidian vault mirror ("Bruno model")** — memories serialize to per-memory `.md` files with YAML frontmatter; the SQLite DB is a *throwaable cache* fully reconstructable from the files (`memory rebuild`). Includes JSON Canvas export and a git-union-merge graph sidecar.
5. **Bitemporal memory** — facts are *invalidated, not deleted* (valid-time `valid_from`/`valid_to`, transaction-time `created_at`/`tx_expired`), enabling point-in-time (`as_of`) queries (Zep/Graphiti model).
6. **Self-correcting + agentic memory** — mem0-style write classification (ADD/UPDATE/DELETE/NOOP), NLI contradiction detection, MemGPT-style core memory + tier classification, Ebbinghaus forgetting curve, and a "dream cycle" consolidation pass.

### Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥20, ESM, TypeScript (ES2022, Node16 module resolution, strict) |
| MCP | `@modelcontextprotocol/sdk` (stdio + Streamable-HTTP transports) |
| Storage | `better-sqlite3` (synchronous) + `sqlite-vec` extension + FTS5 |
| Embeddings | `@huggingface/transformers` (Transformers.js), all-MiniLM-L6-v2 384-dim |
| HTTP | Express 5 |
| Validation | Zod 3 |
| Frontend | React 19 + Vite + Tailwind v4 + shadcn/ui + D3 |
| Tests | Vitest (backend `node` project, web `jsdom` project) |
| CI/CD | GitHub Actions (ci, deploy, codeql, audit, sbom); Docker; self-hosted MS-01 deploy |

---

## 2. Architecture at a glance

```
                          ┌──────────────────────── ENTRYPOINTS ────────────────────────┐
                          │                                                              │
       stdio (default) ───┤  src/index.ts (argv router)                                  │
                          │     ├── default → StdioServerTransport → createServer()       │
   memory <subcommand> ───┤     └── serve/http/init/backup/rebuild/migrate/sync/...       │
                          └───────────────────────────┬──────────────────────────────────┘
                                                       │
              ┌────────────────────────────────────────┼────────────────────────────────────────┐
              ▼                                         ▼                                         ▼
   ┌──────────────────────┐         ┌──────────────────────────────┐          ┌──────────────────────────┐
   │ src/server.ts        │         │ src/cli/serve.ts (Express 5) │          │ src/cli/*.ts (CLI cmds)  │
   │ createServer()       │         │ buildApp()                   │          │ init / backup / rebuild  │
   │  41 tools registered │◀────────│  /mcp  /api  /publish        │          │ sync / vault-init / share│
   │  instrument()        │ per-    │  /health /live /ready /metrics│         └────────────┬─────────────┘
   │  withForcedNs / idNs │ session │  auth · CORS · rate-limit     │                       │
   │  formatResult→sanitize         │  static SPA (dist/web)        │                       │
   └──────────┬───────────┘         └───────────────┬──────────────┘                       │
              │                                      │                                      │
              ▼ (tool handlers)                      ▼ (REST handlers reuse same handlers)  │
   ┌─────────────────────────────────────────────────────────────────────────────────────┐│
   │                              src/tools/*  (thin handlers)                             ││
   │  store search get update delete list ingest related versions stats manifest          ││
   │  consolidate reflect extract-* condense restore forget history version-* tiers ...     ││
   └───┬───────────────┬────────────────┬───────────────┬───────────────┬──────────────────┘│
       ▼               ▼                ▼               ▼               ▼                     ▼
 ┌──────────┐  ┌──────────────┐  ┌─────────────┐  ┌──────────┐  ┌─────────────┐  ┌──────────────────┐
 │ src/db   │  │ src/search   │  │ src/graph   │  │src/vault │  │src/embeddings│  │ src/chunking     │
 │ conn.    │  │ hybrid       │  │ pagerank    │  │ writer   │  │ transformers │  │ chunker          │
 │ schema   │◀▶│ scoring      │◀▶│ communities │◀▶│ sync     │◀▶│ cache (LRU)  │◀▶│ strategies       │
 │ migrations│ │ reranker     │  │ entity-store│  │ rebuild  │  │ MockEmbedder │  └──────────────────┘
 │ repository│ │ temporal     │  │ memory-links│  │ canvas   │  └──────────────┘
 │ backup    │  │ structured-q │  │ contradiction│ │ sidecar  │
 └─────┬─────┘  └──────────────┘  │ write-gate  │  └────┬─────┘
       │                          │ graph-export│       │
       ▼                          └─────────────┘       ▼
 ┌─────────────────────────────────────────────┐  ┌──────────────────────────┐
 │  SQLite: memories · memories_vec · memories_fts│ │ Obsidian vault (.md files)│
 │  memory_links · entities · entity_* · core_mem│  │ + .canvas + .memory/graph │
 │  memory_versions · vault_sync_meta · ...      │  │ .json sidecar (git union) │
 └─────────────────────────────────────────────┘  └──────────────────────────┘

   src/lib/ (sanitize · logger · hot-reload · line-diff · path-validation · direct-access)
   src/config/loader.ts · src/publish/wiki.ts · src/hooks/* (4 Claude Code lifecycle hooks)
   web/ (React SPA dashboard → /api)
```

---

## 3. Subsystem reference

### 3.1 Entry & MCP server

**Purpose:** The executable entrypoint and MCP-server construction layer. `src/index.ts` dispatches subcommands or boots stdio MCP by default; `src/server.ts` builds the single `McpServer` and registers all **41** tools.

**Key files:**
| File | Role |
|---|---|
| `src/index.ts` | argv router (`process.argv[2]` switch, lazy `import()` per command); default → stdio MCP |
| `src/server.ts` | `createServer()`, `formatResult`/`formatError` output chokepoint, `instrument()` wrapper, lazy `getDb`/`getEmbedder`/`getNli`, tenancy helpers |
| `src/cli/serve.ts` | HTTP transport (`buildApp`/`runServe`) — see §3.13 |
| `src/lib/direct-access.ts` | `getReadWriteDb`/`getReadOnlyDb`/`getEmbedder` injected deps |

**Public API:**
- `createServer(): McpServer` — `src/server.ts`, name `'mcp-memory-server'`, version from `package.json` via `createRequire`.
- `formatResult(data): {content:[{type:'text',text}]}` — single MCP output chokepoint; runs `sanitizeDeep` then `JSON.stringify`. **Exported** (only test import from server.ts).
- `formatError(message)` → `{content:[...], isError:true}`.
- `instrument(toolName, fn)` — hrtime timer + `metrics.toolCalls`/`toolLatency` + `event:'tool_call'` log + try/catch error envelope.
- `main()` — `src/index.ts:5`, switch over argv, `.catch → exit(1)`.

**Patterns:**
- **Lazy memoized resources:** `getDb()` opens+initializes+migrates once; `getEmbedder()` memoizes the *in-flight Promise* (concurrent first-use builds one model); `getNli()` lazy proxy (cross-encoder loads only on the `memory_store` supersede path).
- **Per-session McpServer on HTTP:** `buildApp` creates a NEW `McpServer` per MCP session, keyed by `mcp-session-id`; evicted on `transport.onclose`/`DELETE /mcp`.
- **Runtime version** from `package.json` so MCP initialize never reports a stale literal.
- **Tenancy:** `withForcedNs()` overrides namespace on read/query tools when `MCP_API_NAMESPACE` set; `idInForcedNs()` guards by-id reads via `SELECT namespace FROM memories WHERE id=?`.
- `memory_search` defaults `rerank:true` **at the MCP layer only** (`server.ts:239 rerank: parsed.rerank ?? true`); `handleSearch`/REST leave it off.

**Gotchas:**
- `memory_delete` registers a hand-built shape from `MemoryDeleteSchema.innerType().shape.{id,filter}` because the schema ends in `.refine(...)` (a `ZodEffects` with no `.shape`). This `innerType()` reconstruction is the only one in the file and must be kept in sync with the schema.
- The MCP createServer/dispatch path (instrument, `withForcedNs`/`idInForcedNs`, 41-tool registration, `.shape` advertising) is **entirely untested** — only `formatResult` is ever imported by tests (`src/__tests__/lib/sanitize.test.ts`). A dropped/renamed tool or a broken per-tool tenancy guard would pass CI.
- No end-to-end JSON-RPC test through `/mcp` (initialize→tools/call→result). `@modelcontextprotocol/sdk` ships `InMemoryTransport.createLinkedPair()` + a `Client`, making such a test feasible without stdio/model load (pass `rerank:false` to avoid the 90MB model).
- `index.ts 'migrate'` subcommand deliberately bypasses the v4-floor throw by calling `migrateDatabase` directly.

---

### 3.2 Schemas & types

**Purpose:** Validation contract (Zod) + pure TS domain model.

**Key files:**
| File | Role |
|---|---|
| `src/schemas/index.ts` | 41 Zod tool-input schemas + 9 REST `Api*` coercion schemas + shared field factories |
| `src/types.ts` | `Memory`, `MemoryRow`, options/result interfaces, union string-literals |

**Key schemas (selected):** `MemoryStoreSchema` (`on_conflict` enum add|update|supersede, default add), `MemorySearchSchema` (`query` min(1) + non-blank `.refine`; `as_of` strict `.datetime()`; `temporal_decay` nested with `.positive().finite()` guards; `rerank` optional), `MemoryDeleteSchema` (`.refine` requires id OR filter), `MemoryImportItemSchema` (every optional field `.nullable()`, content `.max(100000)`, batch `.max(500)`).

**Domain types:** `Memory` (API shape), `MemoryRow` (persistence shape — adds `stability`, serialized `tags`/`metadata`, optional `rowid`; `stability` is **persistence-only**, not on `Memory`). Unions: `MemoryScope` (global|project|user|team|department), `AccessLevel`, `SearchMode`, `DecayType` (incl. `forgetting`), `ContentType`, `ProvenanceType`, `DetailLevel`, etc.

**Patterns:** shared field factories (`scopeField`, `tagsField`, …) keep DRY; strict ISO-8601 `as_of` rejects date-only; REST coercion via `intFromString`/`floatFromString`/`csvList`/`optString`/`optBool`; nullable-everywhere import round-trip.

**Gotchas:**
- **DRY leak:** the 5-value scope enum is hand-duplicated in `MemoryQueryStructuredSchema.filter.scope` and every `Api*QuerySchema` instead of `scopeField()`. `types.ts` is a *parallel manually-maintained mirror* — no `z.infer` re-export, so drift between Zod and TS unions is unguarded.
- `rerank` has no Zod default but its `describe()` says "Defaults ON at the MCP server" — the ON default lives in `server.ts`, not the schema.
- REST `ApiStatsQuerySchema.scope` uses `optString()` (any string) vs MCP `MemoryStatsSchema`'s constrained enum.
- Import path caps content at 100k chars / 500 items; live `MemoryStoreSchema`/`MemoryIngestSchema` have **no** content cap.

---

### 3.3 Database layer (`src/db/`)

**Purpose:** SQLite persistence with `sqlite-vec`, full schema + virtual tables, forward-only migrations, bitemporal model, WAL-safe hot backup.

**Key files:**
| File | LOC | Role |
|---|---|---|
| `src/db/connection.ts` | 74 | Singleton connection; loads sqlite-vec; WAL + foreign_keys + busy_timeout(5000); exit handlers. `getDatabase`/`createDatabase`/`closeDatabase` |
| `src/db/schema.ts` | 408 | `CURRENT_SCHEMA_VERSION=9`, all DDL, shared `MEMORY_LINKS_DDL`/`CORE_MEMORY_DDL`, `configuredDimensions()`, `initializeSchema()`, `assertDimensionConsistency()` |
| `src/db/migrations.ts` | 301 | Forward-only v2..v9; `addColumn()` (swallows only "duplicate column name"); `runMigrations()`; `migrateDatabase()` (bypasses v4 floor) |
| `src/db/repository.ts` | 572 | CRUD/query over the three coupled tables; `insertMemory`/`updateMemory`/`deleteMemory`/`deleteMemoriesByFilter`/`invalidateMemory`/`listMemories`/`rowToMemory`/`findNearDuplicates`/`recordAccess`/`updateQualityScores` |
| `src/db/backup.ts` | 27 | `backupDatabase()` — online `db.backup()` WAL-safe snapshot |

**Public API highlights:** `getDatabase(dbPath?)` (path = arg ?? `MCP_MEMORY_DB_PATH` ?? `~/.mcp-memory/memory.db`); `initializeSchema(db)` (fresh→stamp v9+dim; existing→validate v4 floor, stamp 4 if no version row; partial→throw); `runMigrations(db)` (transactional, per-step stamp); `STABILITY_INCREMENT=0.5`.

**Patterns:**
- **Bitemporal model:** valid time (`valid_from`/`valid_to` NULL=valid) vs transaction time (`created_at`/`tx_expired` NULL=not retracted). *Invalidate don't delete* — `invalidateMemory` stamps `valid_to` via `COALESCE` (idempotent). `listMemories` default filters `valid_to IS NULL AND tx_expired IS NULL`, or a 3-clause window for `as_of`.
- **Triple-table coupling** inside `db.transaction()`: every write touches `memories` + `memories_vec` (by rowid) + `memories_fts` (FTS5 external-content `delete` op before reinsert).
- **Shared DDL constants** used verbatim by both fresh-create and migrations (v5/v8) so paths never diverge.
- **Two-tier version stamping:** an existing DB with no version row stamps the *verified floor (4)*, never CURRENT — stamping CURRENT would skip v5–v9 and brick the first write (the CRITICAL bug `migrations.test.ts` guards; caught in `.planning/REVIEW.md`).
- **ISO-8601-with-millis-Z** timestamps (`strftime('%Y-%m-%dT%H:%M:%fZ')`) deliberately NOT `datetime('now')` so they collate lexicographically with `toISOString()` (prevents an older tombstone suppressing a later live edit in git union merge).

**Gotchas:**
- vec0 rows are **NOT** removed on bitemporal invalidation (only hard delete) — `findNearDuplicates` re-checks `valid_to`/`tx_expired` in JS; any new direct `memories_vec` consumer must replicate this filter or surface tombstoned rows.
- `insertMemory` hardcodes `valid_to=NULL, tx_expired=NULL` and relies on column DEFAULTs for `stability`/`provenance`/`superseded_at`/`condensation_level` — a `MemoryRow` with those set won't persist them through insert.
- `getDatabase` caches a process-global singleton; a second call with a different path is ignored. Tests must use `createDatabase`/`createTestDb`.
- `deleteMemory`/`deleteMemoriesByFilter` are **hard** deletes (cascade), bypassing the bitemporal model entirely.

---

### 3.4 Embeddings

**Purpose:** Text → dense vectors via a single `EmbeddingProvider` interface, real Transformers.js provider, and an LRU-cache decorator.

**Key files:** `src/embeddings/provider.ts` (barrel re-export), `src/embeddings/transformers.ts` (real provider, lazy HF import), `src/embeddings/cache.ts` (`CachedEmbeddingProvider`, `MAX_CACHE_SIZE=1024`), `src/testing/mock-embedder.ts` (deterministic test provider).

**Public API:** `interface EmbeddingProvider { dimensions; modelName; initialize(); embed(text); embedBatch(texts); isReady() }`; `TransformersEmbeddingProvider(model?, dims?)` (model `MCP_MEMORY_MODEL` ?? `Xenova/all-MiniLM-L6-v2`, dims `configuredDimensions()`); `CachedEmbeddingProvider(inner)`; `configuredDimensions()` (parses `MCP_MEMORY_DIMENSIONS` default 384, range 1..8192); `assertDimensionConsistency(db, configured)`.

**Patterns:** decorator (cache wraps any provider); DI everywhere (`MockEmbeddingProvider` in tests); LRU via Map re-insertion; lazy+memoized model load; `BATCH_SIZE=32`.

**Gotchas:**
- **Cache key is first 500 chars only** (`text.slice(0,500)`) — two distinct texts sharing a ≥500-char prefix collide and return the WRONG cached embedding (real risk for long ingested chunks). Untested.
- Truncate-only resize: model emitting *fewer* dims than configured returns the short vector unpadded (downstream sqlite-vec mismatch surfaces elsewhere).
- Cached vectors stored by reference, not cloned — mutating a returned `Float32Array` corrupts the cache.
- Two independent embedder singletons (`server.ts` + `direct-access.ts`) plus inline build in `cli/rebuild.ts` — separate caches.
- Real `TransformersEmbeddingProvider.initialize()/embed()` is c8-ignored (CI heavyweight lane only).

---

### 3.5 Search & ranking

**Purpose:** Retrieval core — fuses vector KNN + FTS5 + HippoRAG PPR via RRF, plus importance boost, temporal/forgetting decay, optional cross-encoder rerank, confidence, privacy/bitemporal filtering, structured-query DSL, tier classification.

**Key files:**
| File | Role |
|---|---|
| `src/search/hybrid.ts` | `hybridSearch` orchestrator; `sanitizeFtsQuery`; `toSummary`/`toIdOnly` |
| `src/search/scoring.ts` | `cosineSimFromL2`/`l2FromCosineSim`; `computeConfidence`/`confidenceLabel` |
| `src/search/reranker.ts` | `Reranker` interface + `CrossEncoderReranker` (ms-marco, single-logit, lazy); `extractRelevanceScore` |
| `src/search/temporal.ts` | `computeRetention` (Ebbinghaus); `applyTemporalDecay` |
| `src/search/contextual.ts` | `buildContextPrefix`/`contextualizeForEmbedding` (embed-time only) |
| `src/search/tiers.ts` | `classifyTier` (hot/recall/archival); thresholds |
| `src/search/structured-query.ts` | `runStructuredQuery` (injection-safe DSL) |
| `src/search/content-signals.ts` | `computeContentSignal`; `maturityTier` |
| `src/graph/pagerank.ts` | `rankMemoriesByPPR` (third RRF ranker) |
| `src/tools/search.ts` | `handleSearch` wrapper |

**Flow:** Up to 3 candidate sources — Vector (`embedding MATCH ? AND k = ?`, oversample `min(limit*3,300)`), Keyword (`memories_fts MATCH ? ORDER BY rank`), Graph (opt-in PPR). Union rowids → one filtered fetch from `memories` (scope/privacy/bitemporal/expiry/supersede) → **RRF (K=60)** → importance boost `(1 + importance*0.5)` → optional decay → optional rerank of top-N → confidence → `min_confidence` filter → pagination.

**Patterns:** RRF blends incommensurable scores; exact cosine recovery `cos = 1 - d²/2`; cross-encoder reads **raw single logit** (NOT softmaxed — softmax over 1 element collapses to 1.0); rerank is best-effort with try/catch fallback; structured-query bound + sort-allowlisted; PPR determinism (ORDER BY id, specificity damping).

**Gotchas:**
- **Privacy default:** unscoped query forcibly adds `scope != 'user'` (`hybrid.ts:176-184`) — user memories surface only with explicit `scope='user'`. **No test covers this filter.**
- `memory_search` defaults rerank TRUE at MCP but OFF for `handleSearch`/REST → same query, different ordering by entry path.
- Vector & FTS failures **silently swallowed** (c8-ignored empty catch) — broken vec/FTS degrades to the other source with no error.
- Three different age notions: `applyTemporalDecay` uses `created_at`, `freshness_warning`/`age_days` use `updated_at`, `classifyTier` uses `last_accessed_at ?? created_at`.
- structured-query, tiers, and PPR each re-implement the retired-row predicate; can drift from `hybrid.ts` (which also checks `expires_at`).
- **`as_of` does not reconstruct point-in-time CONTENT** (only validity) — returns current content for historical instants. Deferred follow-up.

---

### 3.6 Knowledge graph (`src/graph/`)

**Purpose:** Turn flat memories into a queryable graph — entity graph + memory-link graph + HippoRAG PPR + GraphRAG communities + similarity/unlinked-mention edges + NLI contradiction + git-shareable export/merge. All graph math is pure, deterministic, dependency-free.

**Key files (selected):**
| File | Role |
|---|---|
| `src/graph/entity-extractor.ts` | `extractEntitiesRegex` (pure regex, per-rule confidence) |
| `src/graph/entity-store.ts` | `normalizeName`, `findOrCreateEntity` (type-upgrade), `linkEntityToMemory`, `storeExtractedEntities`, co-occurrence builders |
| `src/graph/communities.ts` | `detectCommunities` (weighted label propagation), summarizers, `chunkIds`/`SQLITE_MAX_VARIABLES=32766` |
| `src/graph/pagerank.ts` | `personalizedPageRank` (damping 0.5, specificity/IDF), `rankMemoriesByPPR`, `sumMemoryScores` |
| `src/graph/similarity-edges.ts` | `buildSimilarityEdges` (similar_to, INFERRED ≤0.8 / AMBIGUOUS ≤1.0) |
| `src/graph/contradiction.ts` | NLI: `NliClassifier`, `labelFromLogits`, lazy `CrossEncoderNli`, `detectContradictions` |
| `src/graph/conflict-resolver.ts` | `detectConflicts` (read-only banding), `recordConflicts` (stamps superseded_at/valid_to) |
| `src/graph/write-gate.ts` | `decideWriteOperation` (pure ADD/UPDATE/DELETE/NOOP) |
| `src/graph/memory-links.ts` | `createMemoryLink`, `getOutgoingLinks`/`getBacklinks`/`getLinksAmong` (chunked) |
| `src/graph/unlinked-mentions.ts` | `findUnlinkedMentions` |
| `src/graph/graph-query.ts` | `queryGraph` (graphify-style hub-avoiding token-budgeted BFS) |
| `src/graph/graph-export.ts` | `exportGraph`, `mergeGraphs` (order-independent union), `mergeGraphFiles` |

**Patterns:** determinism everywhere (fixed iteration/summation order); community detection = **weighted label propagation** (not Louvain); PPR `score = (1-d)·teleport + d·Wᵀ·score` with d=0.5 + specificity `1/(1+mention_count)`; confidence/provenance edge model EXTRACTED > INFERRED > AMBIGUOUS; upsert-with-`evidence_count`; bound-param safety via `chunkIds`; pure-core/IO-shell split with injectable `NliClassifier`; order-independent merge so `merge(a,b)==merge(b,a)`.

**Gotchas:**
- `entity_relationships.strength` (REAL DEFAULT 0.5) is **dead weight** — never written; PageRank/communities weight by `evidence_count`; `handleGraph` derives `strength=1-1/(1+evidence_count)`.
- `entity_aliases` table is defined in `schema.ts` + `migrations.ts` but **only** written by `handleExtractEntities` (the sole consumer; otherwise unread). Alias *resolution* is unimplemented.
- `normalizeName` strips all non-`[a-z0-9-]` → `'Node.js'`, `'nodejs'`, `'node js'` all collapse to `nodejs` and merge into one entity.
- **Two divergent conflict detectors:** `conflict-resolver.detectConflicts` (always-on, vector+Jaccard banding, cannot detect negations) vs `contradiction.ts` NLI (opt-in: only fires with `on_conflict='supersede'` AND an injected classifier). Default store mislabels "API uses 3000" vs "API does NOT use 3000" as near-duplicates.
- The two graphs are bridged only by `buildMemoryCooccurrenceLinks` (co_occurs) at write time; PageRank/communities traverse only `entity_relationships`, while queryGraph/export traverse only `memory_links`.
- Real `CrossEncoderNli` inference is c8-ignored/untested.
- **`extract-entities.ts` has no dedicated test** — only incidental coverage; its return-shape contract, transactional rollback, alias-write (`aliases_added`), and the created-vs-updated counting edge case (pre-check keys on `(normalized_name,type)` but `findOrCreateEntity` keys on `normalized_name` alone) are unverified.

---

### 3.7 Obsidian vault (`src/vault/`)

**Purpose:** The "Bruno model" — memories live as plain-text `.md` files in git; SQLite is a throwaway cache. Lossless bidirectional round-trip; JSON Canvas; `.memory/graph.json` sidecar (git union merge); git scaffolding. Path confinement against traversal + TOCTOU symlink escapes is central.

**Key files (selected):** `writer.ts` (`confineToVault`, `memoryToMarkdown`, `safeVaultFilename`, `exportMemoriesToVault`), `parser.ts` (`splitFrontmatter`, proto-pollution sanitized), `memory-file.ts` (`parseMemoryFile` — inverse of `memoryToMarkdown`), `scanner.ts` (`scanVault`, picomatch, skips dotfiles+symlinks), `sync.ts` (`syncVault` incremental), `write-through.ts` (`mirrorMemoryWrite`/`mirrorMemoryRemove`, config/env-gated, fail-soft), `canvas.ts` (JSON Canvas 1.0), `sidecar.ts` (`.memory/graph.json`), `rebuild.ts` (`rebuildFromVault`), `git-init.ts`.

**Patterns:** Bruno model (per-file 3-way git merge native; only sidecar needs union driver); single confinement source (`confineToVault` = lexical `..` kill + realpath of deepest existing ancestor for TOCTOU); lossless round-trip (deterministic key order, lowercased tags); fail-soft write-through; frontmatter-identity reconciliation (delete-then-insert on known id); contextual-indexing parity (sync/rebuild embed identically to `handleStore`, store content RAW); proto-pollution hardening; full-UUID filename suffix.

**Gotchas:**
- **Two divergent import paths:** `vault_sync` (`parseVaultFile→buildMemoryRow`) hardcodes `access_level='internal'`, `importance_score=0.5`, `confidence_score=0.6` and **ignores** frontmatter access_level/importance/provenance/expires_at/agent_id — NOT field-lossless. The write-through/rebuild path (`parseMemoryFile→rowFromParsed`) is the lossless one.
- Agent-extracted entities and typed links are **not regenerable from content** — `rebuild.ts` only regenerates regex entities + similarity edges and relies on the sidecar; the sidecar is written by `memory sync`/`vault-init` but **NOT by incremental write-through**, so live edits drift from `graph.json` until the next full sync.
- `vault_status` compares `meta.mtime_ms !== Math.floor(file.mtimeMs)` while `syncVault` compares without floor → latent "changed immediately after sync" inconsistency.
- Chunked-file sync mints child chunk ids NOT mirrored by write-through (only `parent_id IS NULL`), and rebuild doesn't reproduce chunk rows → search ranking differs between synced vs rebuilt vault.
- Wikilink resolution only matches `namespace=vaultName` + same `vault_path` metadata → cross-vault links silently become gaps.
- CLI commands (`vault-init`/`rebuild`/`sync`) are c8-ignored; git merge-driver wiring untested.

---

### 3.8 Chunking (`src/chunking/`)

**Purpose:** Split large documents into overlapping embeddable chunks for `memory_ingest` and large vault notes.

**Key files:** `chunker.ts` (`chunkContent` orchestrator), `strategies.ts` (`ChunkingStrategy` interface, 4 strategies, `getStrategy()` dispatcher, `locateSegments`).

**Public API:** `chunkContent(content, options): ChunkResult[]` — selects strategy by `content_type`, applies overlap (prepends last `overlap` chars of previous original chunk), drops <20-char chunks, renumbers. `getStrategy(contentType)` → markdown→Markdown, code→Code, legal→Sentence, text|structured|default→Paragraph.

**Patterns:** Strategy + factory; greedy merge/packing; offset-preserving segmentation; regex-driven boundaries; heading-preserving markdown sub-splitting; fallback chaining.

**Gotchas:**
- `'structured'` content_type has **no** dedicated strategy → silently uses ParagraphStrategy (poor for JSON/CSV).
- Field-name mismatch: `ChunkingOptions.overlap` vs schema/caller field `chunk_overlap` (each caller must map).
- Offsets become inaccurate after overlap prepending (content longer than `end_offset-start_offset` for index>0).
- Overlap can exceed chunk size (schema caps overlap 500, chunk_size min 100) → `slice(-overlap)` duplicates the entire previous chunk. No guard.
- `CodeStrategy` regex is JS/TS-centric (Python/Go/Rust hit zero boundaries → paragraph fallback). `splitOnBlankLines` no-boundary path is c8-ignored.
- Vault sync hardcodes `content_type='markdown'` regardless of actual file type.

---

### 3.9 MCP tools — core CRUD & retrieval (`src/tools/`)

Thin `handleX(db, [embedder], input)` handlers; Zod parsing in `server.ts`; delegate to `db/repository.ts`, `graph/*`, `search/hybrid.ts`, `vault/write-through.ts`.

**Public API:** `handleStore` (StoreResult with `operation`/`operation_reason`/`superseded_nothing`), `handleUpdate`, `handleDelete`, `handleGet`, `handleList`, `handleQuery`, `handleSearch`, `handleHistory`, `handleVersions`, `handleVersionDiff`/`handleVersionRestore`, `handleStats`, `handleManifest`, `handleRelated`.

**Patterns:** read-then-async-embed-then-transactional-write (no `await` inside any better-sqlite3 sync transaction); mem0-style classification (default `on_conflict='add'` is byte-identical to pre-feature ADD/NOOP); **G3-F1 atomic supersede** (retire deferred into the same transaction as insert+recordConflicts); **G3-F3 containment-aware merge** (`mergeUpdateContent`); `memory_version_restore` implemented as forward `handleUpdate` (re-versioned); detect/record split fixes the original FK-violation bug.

**Gotchas:**
- **Tenancy is enforced at `server.ts`, not in handlers** — calling handlers directly (tests/REST helpers) bypasses it; REST re-applies `forcedApiNamespace()`.
- `memory_delete` is **hard** delete (vs bitemporal soft-retire of supersede and `memory_forget`).
- `handleUpdate` re-embeds **RAW** `input.content` *without* `contextualizeForEmbedding`, unlike store/ingest/vault → updated memory's vector lives in a slightly different space.
- `handleStats` counts **ALL** rows incl. invalidated/superseded (no `valid_to`/`tx_expired`/`superseded_at` filter — verified at `src/tools/stats.ts`), diverging from list/search. On-disk size via `fs.statSync(MCP_MEMORY_DB_PATH ?? ~/.mcp-memory/memory.db)` → silently 0 for `:memory:`. **The invalidated-row inclusion and size-0 fallback are unasserted.** Note: `manifest.ts` *also* lacks validity filtering (it only filters `parent_id IS NULL`), so it diverges the same way — list filters bitemporal only; search is strictest (also `superseded_at` + `expires_at`).
- Entity extraction, similarity edges, conflict detect, vault write-through are all fail-soft — a store can "succeed" with missing entities/edges/mirror; only `insertMemory`+`recordConflicts` failures roll back.

---

### 3.10 MCP tools — cognition & memory ops (`src/tools/`)

Agent-facing cognition: maintenance (consolidate/forget/condense), self-organization (reflect/extract-learnings/extract-entities), working/core memory, ingestion, diagnostics (questions/attribution/templates/tiers). **No LLM in the server** — agent-driven tools push synthesis to the calling agent.

**Public API (selected):** `handleConsolidate` (ConsolidationReport), `handleReflect` (gather|store), `handleExtractLearnings` + pure `extractFromTranscript`/`preprocessTranscript`/`isQualityContent`, `handleExtractEntities`, `handleQuestions`, `handleCondense`/`handleRestore`, `handleIngest`, `handleAttribution`, `handleSessionNote`, `handleCoreMemoryGet/Append/Replace`, `getTemplate`/`handleTemplate` (pure, no DB), `handleMemoryTiers`, `handleForget`.

**Patterns:** no-LLM-in-server; vector-space consistency (re-embed contextualized text); cosine→L2 via `l2FromCosineSim`; capture-then-erase ordering for GDPR hard forget; manual index hygiene (FK cascade doesn't touch vec/fts → forget walks `parent_id` CTE); compose-don't-duplicate (session-note/reflect/extract-learnings call `handleStore`/`handleUpdate`); bounded core memory; opt-in default-off forgetting.

**Gotchas:**
- **`extract-learnings.ts` dedup threshold inconsistency (VERIFIED).** `src/tools/extract-learnings.ts` uses `DEDUP_DISTANCE_THRESHOLD = (1-0.85)*2 = 0.30` (the OLD linear approximation), while `src/tools/consolidate.ts` uses `l2FromCosineSim(0.85) ≈ 0.548`. The extract path dedups only cosine ≥ 0.955; consolidate dedups cosine ≥ 0.85 — a ~0.25 L2 delta. The hook-driven auto-capture (PreCompact→extract-from-transcript→handleExtractLearnings) therefore **under-dedups/under-corroborates** vs `memory_consolidate`. Untested; `store.ts` also uses a raw `0.7` literal. **Fix:** `DEDUP_DISTANCE_THRESHOLD = l2FromCosineSim(0.85)`.
- `consolidate` heavily try/catch'd + c8-ignored — stage failures swallowed into `report.errors`; callers must inspect it. Implicit ceilings: `maxEmbeddings = max_operations*2`, hard 5-min `timeBudgetMs`.
- `reflect` store-mode duplicate guard (G3-F4): on default `on_conflict='add'` a near-dup makes `handleStore` NOOP returning an existing memory; reflect must bail rather than corrupt provenance.
- `core_memory` namespace uses `''` sentinel; `undefined` and `''` collapse to the same row. Replace swaps only the FIRST occurrence.
- `session-note` append grows one memory unboundedly (no size cap).
- `ingest` hardcodes `access_level='public'`, `language='en'`.

---

### 3.11 MCP tools — graph & vault facing (`src/tools/`)

Thin handlers over `src/graph/` and `src/vault/`: `handleGraph`, `handleCommunities`, `handleCanvas`, `handleUnlinkedMentions`, `handleExport`, `handleExportVault`, `handleImport`, `handleVaultSearch`, `handleVaultStatus`, `handleVaultSync`.

**Patterns:** thin-handler passthrough; server-does-math/agent-does-LLM (`handleCommunities` returns clusters + `instruction`); determinism in graph/canvas output; chunked IN-clauses; lossless export↔import & export_vault↔sync round-trips.

**Gotchas:**
- **Inconsistent bitemporal filtering:** `export.ts` (`memory_export`) selects `SELECT * FROM memories <where> ORDER BY created_at DESC LIMIT 1000` with **no** `valid_to`/`tx_expired`/`parent_id` filter → backups include soft-deleted memories AND chunk children, unlike `canvas.ts`/`writer.ts`.
- `include_embeddings` is accepted by `MemoryExportSchema`/`handleExport` but **completely unused** (documentation lie).
- `memory_export` hard cap 1000 rows, no pagination → silent truncation past 1000.
- `vault_search`/`vault_status` derive namespace from `basename(vault_path)` → two vaults with the same dir base name collide.
- `handleImport` overwrite only updates content/title/tags/metadata/expires_at — scope/namespace/document_type NOT updated; batch embedder failure returns `errors = input.data.length`.

---

### 3.12 CLI commands (`src/cli/*.ts`)

**Purpose:** Binary entrypoint — install/uninstall lifecycle, HTTP server, maintenance (consolidate/backup/rebuild/migrate), git/vault sharing, plus standalone hook-spawned scripts.

**Key files:** `index.ts` (router), `init.ts` + `init-wizard.ts`, `serve.ts` (§3.13), `share.ts`, `uninstall.ts`, `consolidate.ts`, `backup.ts`, `rebuild.ts`, `sync.ts`, `vault-init.ts`, `extract-from-transcript.ts`, `review-and-store.ts`, `cleanup-extracted.ts`.

**Public API (selected):** `runInit()`, `runWizard(prompter)`, `buildConfig(answers, existing)`, `buildApp(deps)`/`runServe()`, `timingSafeStrEqual`, `buildMergeDriverCommand(distEntry)`, `resolveTranscriptPath(rawPath)`.

**Patterns:** lazy dynamic import per command; pure wizard core (`runWizard`/`buildConfig`) vs c8-ignored TTY IO; non-TTY stdin buffering; constant-time bearer compare; security-by-default serve; idempotent installers; upgrade-aware hook merge (strips legacy agent-type hooks); detached hook scripts with 5-min timeout + exit-0.

**Gotchas:**
- `extract-from-transcript.ts`/`review-and-store.ts`/`cleanup-extracted.ts` are **NOT** in the `index.ts` router — spawned by path.
- `cleanup-extracted.ts` runs side effects at module top-level → cannot be imported for testing.
- `review-and-store.ts` depends on a `claude` binary (`CLAUDE_BIN`) and the MCP server registered as `memory-server` (tool `mcp__memory-server__memory_store`); the hook matcher hardcodes `mcp__memory-server__memory_search` — a different server name breaks both.
- `rebuild.ts` hard-deletes the DB+WAL+SHM before rebuilding; if the vault is empty/rebuild fails partway, you lose the index (the Bruno guarantee assumes vault is source of truth).
- launchd plist is macOS-only; Linux only prints a cron hint.
- **`getReadOnlyDb` is a naming lie (VERIFIED):** `src/lib/direct-access.ts:18-23` is byte-identical to `getReadWriteDb` — it calls `getDatabase()` → `initializeSchema(db)` → `runMigrations(db)`, so the "read-only" accessor opens a **writable** cached connection and **mutates schema** (ALTER/CREATE/UPDATE + version bump) on first call against a below-current DB. Read-only-labeled commands (`backup`, `sync`, `share/export-graph`, `vault-init`) inherit this write side-effect. Only an identity/alias test exists (`coverage-fill.test.ts:156`); the migration-on-read side-effect against an existing older DB is untested.

---

### 3.13 REST API & HTTP serve

**Purpose:** Single Express 5 app serving `/api` (dashboard), `/mcp` (JSON-RPC), `/publish` (public wiki), `/health|/live|/ready`, `/metrics`. Owns all HTTP security.

**Key files:** `src/cli/serve.ts` (`buildApp`/`runServe`), `src/api/routes.ts` (REST + publish routes, `HttpError`, `asyncHandler`, graph cache), `src/api/rate-limit.ts` (token-bucket, `clientKey`), `src/api/metrics.ts` (zero-dep Prometheus), `src/api/security-headers.ts`, `src/publish/wiki.ts`.

**Middleware order:** requestId → security-headers → localhost Host validation (DNS-rebind) → `express.json(limit)` → CORS → (`/api`,`/mcp`) rate-limit → (`/api`,`/mcp`) bearer (when token set) → (`/publish`) stricter publish limiter.

**REST endpoints (8 corpus + publish):** `GET /api/stats|/api/search|/api/memories|/api/memories/:id|.../versions|.../related`, `PATCH`+`DELETE /api/memories/:id`, `GET /api/manifest`, `GET /api/graph` (custom: `handleList`+`getLinksAmong`, cached). Public: `GET /publish/:namespace|/graph|/search|/page/:id`.

**Patterns:** single `buildApp` factory (prod + every integration test, real HTTP on ephemeral port); `asyncHandler` doubles as metrics+log instrumentation; defense-in-depth tenancy (force ns + `assertNamespaceAllowed`→404 not 403); publish search calls `hybridSearch` directly (side-effect-free), caps query 512 chars, oversamples 100→intersect→slice 20; constant-time bearer; rate limiter keys on socket peer (never X-Forwarded-For); fail-closed auth startup; HTML-escaped wiki + data-layer access gating.

**Gotchas:**
- **`graphCache` cross-pollination (VERIFIED).** `src/api/routes.ts:297` keys the cache as `${q.limit}|${q.min_importance ?? 0}` with **no** forced-namespace component, yet `routes.ts:319` scopes the underlying `handleList` by `forcedApiNamespace()`. The module-level `graphCache` (TTL 60s) is busted only by file-signature (`maybeBustGraphCache`), never by namespace. Safe today only because `MCP_API_NAMESPACE` is process-wide/static; a single process varying the namespace within the TTL window leaks one namespace's graph to another. Untested. **Fix:** prepend `forcedApiNamespace() ?? ''` to the cache key.
- `/health`,`/live`,`/ready`,`/metrics` are NOT under the rate-limit/bearer prefixes; `/metrics` needs its **own** constant-time bearer guard. If metrics enabled with no token, `/metrics` is unauthenticated.
- Rate-limit buckets key on socket peer → behind a TCP-terminating proxy all clients share one bucket unless `MCP_TRUSTED_IP_HEADER` is set (which clients can spoof if the proxy doesn't strip it).
- Limiter is single-process only (in-memory Map).
- CSP allows `'unsafe-inline'` for style-src (Tailwind v4).
- Static SPA catch-all uses Express 5 `'{*path}'` with a manual exclusion list — adding a new top-level route requires updating it.

---

### 3.14 Claude Code hooks (`src/hooks/`)

Four opt-in lifecycle hooks (standalone node processes reading JSON on stdin, 5s timeout, swallow all errors, exit 0): `memory-session-start.ts` (auto-recall status line, read-only DB), `memory-stop.ts` (detached-spawns `review-and-store.js`), `memory-pre-compact.ts` (gated `extract_on_compact`, spawns `extract-from-transcript.js`), `memory-post-search.ts` (search telemetry JSONL).

**Public API:** `resolveTranscriptPath(rawPath)` (confines to `~/.claude/projects` or `MCP_MEMORY_TRANSCRIPT_BASE`), `sanitizePath`, `resolveNamespace`, `handleExtractLearnings`.

**Patterns:** defensive 5s-timeout contract; embedder-free SessionStart; detached fire-and-forget background jobs; Stop-hook recursion guard (`MCP_MEMORY_REVIEW_IN_PROGRESS`); path confinement (B8 fix); config-driven toggles; two auto-capture strategies (regex PreCompact opt-in vs LLM Stop default-on).

**Gotchas:**
- **Search-log writer/reader field mismatch (VERIFIED BUG).** `src/hooks/memory-post-search.ts:62` writes the key `results_count`, but `src/tools/consolidate.ts:83` reads `entry.results === 0`. In production `entry.results` is always `undefined`, `undefined === 0` is false → **no knowledge gap is ever detected from real hook output**. The only test (`consolidate-coverage.test.ts`) hand-writes a synthetic `{results:0}` payload matching the *reader*, masking the bug; the real writer→reader contract is never exercised end-to-end (`memory-post-search.ts` is coverage-excluded). `report.knowledge_gaps` is therefore always `[]` in production. **Fix:** align reader to `results_count` (safer — no log migration) or rename the writer key.
- `review_on_stop` is read by `memory-stop.ts` but absent from `ServerConfigSchema` (raw JSON.parse only); `extract_on_session_end` exists in schema/README but **no hook reads it** (dead key); `capture.auto_capture` is the user-facing toggle but **no hook reads it** (per-hook `hooks.*` flags gate behavior).
- Tool-name skew: README says `memory_search`/`memory_stats`; `init.ts` registers `mcp__memory-server__memory_search`. Depends on the `.mcp.json` key being exactly `memory-server`.
- `review-and-store.ts` keeps only the LAST 200KB of transcript.

---

### 3.15 Lib utils, config, publish (`src/lib/`, `src/config/`, `src/publish/`)

Cross-cutting: `path-validation.ts` (`sanitizePath`), `sanitize.ts` (`sanitizeText`/`sanitizeDeep` — output chokepoint), `hot-reload.ts` (`fileSignature`/`ReloadGate`/`maybeBustGraphCache`), `line-diff.ts` (LCS), `logger.ts` (structured JSON, secret redaction), `direct-access.ts` (DB/embedder accessors), `config/loader.ts` (Zod config singleton, `resolveNamespace`/`getWatchedPaths`), `publish/wiki.ts` (access-gated wiki HTML/JSON).

**Patterns:** single output chokepoint (`sanitizeDeep` only called by `formatResult`); ReDoS-safe sanitize regex; access control as a *data-layer* invariant (`publishedWhere`); defense-in-depth XSS; publish search hardening; config process-singleton; semantic-alias `getReadOnlyDb`/`getReadWriteDb`.

**Gotchas:**
- `sanitizePath` uses `startsWith(base + sep)` but does **not** resolve symlinks (no realpath) — a symlink inside `allowedBase` pointing out is not caught here (vault/write-through uses realpath separately).
- `logger` redaction is **shallow** (top-level keys only) — secrets nested in object values, or keys like `bearer`/`pwd`/`access_token`, pass through cleartext. `levelFromEnv()` re-reads env on **every** emit.
- `getConfig()` is a process singleton — config changes require a restart. `db/connection.ts` reads `MCP_MEMORY_DB_PATH` env, **NOT** config `storage.db_path` → that config key is effectively dead unless wired.
- `sanitizeDeep` MAX_DEPTH=64 silently stops recursing past depth 64.

---

### 3.16 Web frontend (dashboard SPA, `web/`)

React 19 + Vite + Tailwind v4 + shadcn/ui + D3. Thin read/light-write client over `/api`.

**Pages:** Dashboard (stats), Search (server search + Fuse.js autocomplete), Browse (paginated/sortable table), MemoryDetail (Content/Versions/Related/Metadata tabs + edit/delete), KnowledgeGraph (D3 force graph). **API client:** `web/src/api/client.ts` (typed fetch, `ApiError`, bearer token in `localStorage['mcp.token']`).

**Patterns:** route-level code splitting; URL as source of truth (Search/Browse); latest-request/stale-response guards (WEB-2/WEB-3); React+D3 strictly separated; centralized typed API client; next-themes + OKLCH tokens.

**Gotchas:**
- **No login UI** — token set only via `localStorage.setItem('mcp.token', …)` in console or `VITE_MCP_TOKEN` at build (the 401 toast literally instructs this).
- `MemoryDetail.tsx` lacks the stale-guard + `toastError` used elsewhere → failed fetch silently shows "Memory not found".
- Delete uses native `window.confirm()` (inconsistent with Edit's Dialog).
- Dashboard "Total Memories" card shows `total_documents` (not `total_memories`).
- Search loads up to 500 memories on every mount to build the Fuse index (unbounded cost).
- Edit dialog only sends title+content (tags/metadata/expires_at supported by PATCH but not editable).
- `vite.config.ts` proxies to `:3100`; production deployment uses `:3200` (per CLAUDE.md).
- Almost no tests (only `ErrorBoundary` + api `client`).

---

## 4. Complete MCP tool catalog (41 tools)

All registered in `src/server.ts:createServer` via `server.tool(name, description, Schema.shape, instrument(name, handler))`. Source-comment numbering reaches 38 integers + 3 lettered (`10b memory_tiers`, `15b memory_export_vault`, `15c memory_canvas`) = **41**. HTTP column: ✅ = dedicated `/api` route reusing the same handler; ≈ = approximated via a different code path.

| # | Tool | Handler | Purpose | Key params | HTTP |
|---|---|---|---|---|---|
| 1 | `memory_store` | `tools/store.ts` | Store memory + embed; mem0 write classification + opt-in NLI supersede | content*, scope, on_conflict(add\|update\|supersede), tags, agent_id, expires_at | MCP-only |
| 2 | `memory_search` | `tools/search.ts` | Hybrid vector+keyword(+graph) search, RRF, decay, opt rerank | query*, search_mode, limit, temporal_decay, as_of, use_graph, rerank, detail_level, max_tokens | ✅ GET /api/search (rerank off) |
| 3 | `memory_get` | `tools/get.ts` | Get by id + links/backlinks (+chunks) | id*, include_chunks | ✅ GET /api/memories/:id |
| 4 | `memory_update` | `tools/update.ts` | Partial update; re-embed on content change; versioned | id*, content, title, metadata, tags, expires_at, changed_by | ✅ PATCH /api/memories/:id |
| 5 | `memory_delete` | `tools/delete.ts` | **Hard** delete by id or filter | id \| filter{scope,namespace,department,before_date,expired_only} | ✅ DELETE /api/memories/:id (id-only) |
| 6 | `memory_list` | `tools/list.ts` | Paginated/sorted browse; bitemporal | scope, sort_by, sort_order, as_of, limit, offset | ✅ GET /api/memories |
| 7 | `memory_ingest` | `tools/ingest.ts` | Chunk+embed+store a document | content*, content_type, chunk_size, chunk_overlap | MCP-only |
| 8 | `memory_related` | `tools/related.ts` | Vector-similar memories to an id | id*, limit, min_similarity | ✅ GET /api/memories/:id/related |
| 9 | `memory_versions` | `tools/versions.ts` | Version edit history | id*, limit | ✅ GET /api/memories/:id/versions |
| 10 | `memory_stats` | `tools/stats.ts` | Totals + breakdowns + storage + expired | scope, namespace, department | ✅ GET /api/stats |
| 10b | `memory_tiers` | `tools/tiers.ts` | MemGPT hot/recall/archival distribution | scope, namespace | MCP-only |
| 12 | `memory_export` | `tools/export.ts` | Export ≤1000 memories as JSON | scope, namespace, department, include_embeddings(unused) | MCP-only |
| 13 | `memory_import` | `tools/import.ts` | Import JSON memories (batch-embed) | data[]*, overwrite | MCP-only |
| 14 | `vault_sync` | `tools/vault-sync.ts` | Sync Obsidian vault INTO memory | vault_path*, chunk_size, force, include/exclude_patterns | MCP-only |
| 15 | `vault_status` | `tools/vault-status.ts` | Vault sync status counts | vault_path* | MCP-only |
| 16 | `vault_search` | `tools/vault-search.ts` | Hybrid search scoped to vault namespace | vault_path*, query* | MCP-only |
| 15b | `memory_export_vault` | `tools/export-vault.ts` | Write memories OUT to vault `.md` | vault_path*, scope, namespace | MCP-only |
| 15c | `memory_canvas` | `tools/canvas.ts` | Export graph as JSON Canvas 1.0 | scope, namespace, limit, vault_path, name | MCP-only |
| 19 | `memory_consolidate` | `tools/consolidate.ts` | Dream cycle: merge dupes, prune, score | similarity_threshold, prune_expired, dry_run, max_operations, forgetting_floor | MCP-only |
| 20 | `memory_extract_learnings` | `tools/extract-learnings.ts` | Extract decisions/fixes/patterns from transcript | transcript*, categories, auto_store | MCP-only |
| 18 | `memory_manifest` | `tools/manifest.ts` | Lightweight index by importance | scope, namespace, limit, offset | ✅ GET /api/manifest |
| 22 | `memory_graph` | `tools/graph.ts` | Entity-graph traversal (depth 1-3) | entity, entity_type, depth, include_memories, limit | ≈ GET /api/graph (diff path) |
| 23 | `memory_extract_entities` | `tools/extract-entities.ts` | Persist LLM entities/aliases/relationships | memory_id*, entities[]*, relationships[] | MCP-only |
| 24 | `memory_condense` | `tools/condense.ts` | Apply agent summaries (preserve original) | memories[]*, target_level | MCP-only |
| 25 | `memory_restore` | `tools/condense.ts` | Restore condensed memory | id* | MCP-only |
| 26 | `memory_query` | `tools/query.ts` | Token-budgeted graph-walk RAG | query*, max_tokens, max_hops, seed_limit | MCP-only |
| 27 | `core_memory_get` | `tools/core-memory.ts` | Read pinned core block | scope, namespace | MCP-only |
| 28 | `core_memory_append` | `tools/core-memory.ts` | Append to core block (char_limit) | scope, namespace, text* | MCP-only |
| 29 | `core_memory_replace` | `tools/core-memory.ts` | Replace first occurrence in core block | scope, namespace, old_text*, new_text* | MCP-only |
| 30 | `memory_reflect` | `tools/reflect.ts` | Gather material or store synthesized insight | mode(gather\|store), insight, source_ids[] | MCP-only |
| 31 | `memory_communities` | `tools/communities.ts` | GraphRAG community detection + instruction | limit, min_size | MCP-only |
| 32 | `memory_template` | `tools/templates.ts` | Markdown scaffold per document_type (no DB) | document_type* | MCP-only |
| 33 | `memory_session_note` | `tools/session-note.ts` | Per-session daily note (create/append) | session_id*, text*, title | MCP-only |
| 34 | `memory_attribution` | `tools/attribution.ts` | Rollup by agent_id/author | scope, namespace | MCP-only |
| 35 | `memory_questions` | `tools/questions.ts` | Questions digest (verify/gap/orphan) | scope, namespace, limit | MCP-only |
| 36 | `memory_forget` | `tools/forget.ts` | GDPR soft tombstone or hard erase (+export) | id*, hard | MCP-only |
| 37 | `memory_history` | `tools/history.ts` | Bitemporal timeline + version history | id* | MCP-only |
| — | `memory_unlinked_mentions` | `tools/unlinked-mentions.ts` | Related-but-unlinked memories | id*, limit, min_similarity | MCP-only |
| — | `memory_query_structured` | `search/structured-query.ts` | Deterministic property query (Dataview-style) | filter{...}, sort, limit, offset, fields[] | MCP-only |
| — | `memory_version_diff` | `tools/version-history.ts` | Line diff between two revisions | id*, from*, to | MCP-only |
| 38 | `memory_version_restore` | `tools/version-history.ts` | Restore prior version as new versioned edit | id*, version*, changed_by | MCP-only |

> **Catalog corrections vs prior survey drafts:** the authoritative count is **41**, not 38/37 — the lower figures came from counting integer section comments (max 38) and missing the 3 lettered sub-entries. The live `mcp__mcp-memory__*` deferred-tool snapshot is also stale (missing the 4 newest tools: unlinked_mentions, query_structured, version_diff, version_restore). Trust `server.ts`.

**Extra HTTP-only surface (no MCP equivalent):** the unauthenticated `/publish` wiki — `GET /publish/:namespace` (HTML), `/graph` (JSON), `/search?q=` (JSON, side-effect-free), `/page/:id` (HTML). Access gated by `MCP_PUBLISH_ACCESS_LEVELS` (default `public`), not bearer auth.

**Cross-cutting:** all MCP output → `formatResult`→`sanitizeDeep`; `memory_search` rerank ON at MCP / OFF for `handleSearch`+REST; `MCP_API_NAMESPACE` forces ns on read/query tools (`withForcedNs` + `idInForcedNs` by-id guards); NLI (`getNli`) loads only on `memory_store on_conflict=supersede`.

---

## 5. Data & storage model

**One SQLite file** (`MCP_MEMORY_DB_PATH` ?? `~/.mcp-memory/memory.db`), WAL mode, `sqlite-vec` loaded, schema **v9**.

### Relational tables

| Table | Purpose | Key columns |
|---|---|---|
| `schema_meta` | k/v store | `schema_version`, `embedding_dim` |
| `memories` | central store | `id` PK, scope, namespace, title, content, document_type, source, author, department, `tags`(JSON), access_level, language, `metadata`(JSON), `parent_id`→memories CASCADE, chunk_index, version, created_at, updated_at, expires_at, access_count, last_accessed_at, importance_score, confidence_score, superseded_at, condensation_level, condensed_at, provenance, provenance_detail, **valid_from, valid_to, tx_expired** (v6), **stability** (v7), **agent_id** (v9). 12 indexes. |
| `memory_versions` | pre-edit snapshots | `${id}_v${version}`, memory_id CASCADE, content, title, metadata, version, changed_by, changed_at |
| `memory_links` | memory↔memory edges (bitemporal) | source/target_memory_id CASCADE, relation, confidence(EXTRACTED\|INFERRED\|AMBIGUOUS), confidence_score, source_kind(wikilink\|co_occurrence\|similarity\|typed), evidence_count, valid_from/to, tx_expired; UNIQUE(source,target,relation) |
| `core_memory` | MemGPT pinned block | PK(scope, namespace `''` sentinel), content, char_limit(2000), updated_at |
| `entities` | KG nodes | id, name, normalized_name, type, mention_count |
| `entity_aliases` | aliases (written only by extract_entities) | entity_id CASCADE, alias, normalized_alias, source; UNIQUE(normalized_alias) |
| `entity_relationships` | KG edges | source/target_entity_id, type, `strength`(dead, default 0.5), evidence_count; UNIQUE(source,target,type) |
| `memory_entities` | memory↔entity junction | PK(memory_id, entity_id), role, extracted_by, confidence |
| `memory_conflicts` | supersession provenance | old/new_memory_id, conflict_type, resolved_at/by |
| `memory_originals` | condense backup | memory_id PK, original_content/title |
| `memory_access_log` | usage telemetry (rotated >90d) | memory_id, access_type, query_text, result_rank, score, accessed_at |
| `ingest_source_tracking` | ingest dedup | source_path UNIQUE, source_hash, memory_id, status |
| `vault_sync_meta` | vault incremental ledger | PK(vault_path, file_path), mtime_ms, memory_id, synced_at |

### Virtual tables

- **`memories_vec`** — `vec0`: `embedding float[DIM]` (DIM from `MCP_MEMORY_DIMENSIONS`, default 384) + aux scope/namespace, keyed by `memories.rowid`. KNN via `embedding MATCH ? AND k = ?`. **vec rows persist through bitemporal invalidation** (removed only on hard delete).
- **`memories_fts`** — FTS5 external-content (`content=memories`, `content_rowid=rowid`) over title/content/tags/author/department.

### Bitemporal model

Valid time = when a fact is true (`valid_from` = `created_at` on insert; `valid_to` NULL = still valid). Transaction time = `created_at`/`tx_expired` (NULL = not retracted). *Invalidate don't delete.* Default queries filter `valid_to IS NULL AND tx_expired IS NULL`; `as_of` switches to the 3-clause point-in-time window. Quality/forgetting columns: `stability` (+0.5 per access), `importance_score` (+0.03/access, capped 1.0).

### The vault mirror

Per-memory live file `<namespace>/<title-slug>-<full-uuid>.md` with deterministic YAML frontmatter + raw body; tombstones `.memory/deleted/<id>.md`; graph sidecar `.memory/graph.json` (git union merge); `<name>.canvas`; `.gitignore`/`.gitattributes`. The SQLite DB is gitignored and rebuildable via `memory rebuild`.

---

## 6. Request lifecycles

### Store flow (`memory_store`)

1. **Dispatch:** stdio/HTTP MCP routes `tools/call` → `instrument('memory_store', fn)` (hrtime timer, metrics, log, try/catch).
2. **Validate:** `MemoryStoreSchema.parse(input)` (defaults scope/access_level/language, `on_conflict` default `add`).
3. **Embed:** `contextualizeForEmbedding(content, {title,document_type,namespace})` → `embedder.embed` (cache→transformers). **Raw content stored; prefix embed-time only.**
4. **Conflict scan (read-only):** `detectConflicts` — vec KNN k=10, break at distance>0.4, score `0.5·cos + 0.5·jaccard`, band duplicate/superseded/contradicted. Fail-soft.
5. **Classify:** `decideWriteOperation(conflicts, on_conflict)` → ADD/UPDATE/DELETE/NOOP.
6. **NLI (async, optional):** if classifier injected AND `on_conflict='supersede'` → `findNearDuplicates(db, emb, 0.7, 10)` then `detectContradictions`. Runs **before** the sync transaction.
7. **Short-circuits:** NOOP → return existing; UPDATE → containment-aware merge + re-embed + `updateMemory`.
8. **Transaction (sync, atomic):** `db.transaction(persist)` = `invalidateMemory` (deferred retire) + `insertMemory` (memories+vec+fts) + `recordConflicts` (rethrows to roll back) + entity extraction (fail-soft).
9. **Post-commit side effects:** `buildSimilarityEdges` (outside txn) + `mirrorMemoryWrite` (vault, fail-soft).
10. **Return** `StoreResult` → `formatResult`→`sanitizeDeep`→MCP text.

### Search flow (`memory_search`)

1. **Dispatch + validate:** `MemorySearchSchema.parse` → `withForcedNs(parsed)` → `handleSearch(db, embedder, {...parsed, rerank: parsed.rerank ?? true})`.
2. **Gather candidates:** Vector (`embedder.embed(query)` → vec KNN, oversample `min(limit*3,300)`), Keyword (`sanitizeFtsQuery` → FTS5), Graph (opt-in PPR). Vector/FTS failures swallowed.
3. **Fetch + filter:** one `SELECT * FROM memories WHERE rowid IN (...)` + scope/privacy (`scope != 'user'` default) + bitemporal + expiry + `superseded_at IS NULL`.
4. **Fuse:** RRF (K=60) over the 3 ranked lists → importance boost `(1 + importance·0.5)` → optional temporal decay → optional rerank top-N (best-effort) → `computeConfidence` → `min_confidence` → paginate.
5. **Record access (WRITE):** `recordAccess` — sync txn bumping access_count/importance/stability + `memory_access_log`. **Search is not read-only.**
6. **Project + budget + return:** detail_level projection, `max_tokens` budgeting (~3.4 chars/token) → `formatResult`→`sanitizeDeep`.

**Lifecycle invariants:** only embed/NLI/rerank are async; all DB access is synchronous (no `await` inside any transaction); embeddings LRU-cached (1024, 500-char key); embedder/reranker/NLI are lazy singletons.

---

## 7. REST API & deployment

### Routes & auth
- **Routes:** §3.13. `/api/*` (bearer + rate-limited when token set), `/mcp` (per-session Streamable transport, bearer + rate-limited), `/publish/*` (unauthenticated, stricter limiter, access-gated by data layer), `/health|/live|/ready`, `/metrics` (own bearer guard).
- **Auth:** shared bearer (`MCP_AUTH_TOKEN`), constant-time `timingSafeStrEqual`. Fail-closed: refuses to start on non-loopback bind without a token unless `MCP_AUTH_OPTIONAL=1`. ADR-0002 (no per-user authz, Cloudflare Access as the boundary).
- **Rate limiting:** dependency-free token bucket keyed on socket peer; `MCP_RATELIMIT_CAPACITY`(30)/`_REFILL_PER_SEC`(6); stricter publish bucket (15/2).

### Docker / CI/CD
- **Docker:** `docker-compose.yml` maps host `3200`→container `3100`, `MCP_BIND=0.0.0.0`, `MCP_AUTH_TOKEN` from host env, DB `/data/memory.db`, config `/data/config.json`, `HF_HOME=/cache`, `MALLOC_ARENA_MAX=2`. Dockerfile: `NODE_ENV=production`, unprivileged `node` user, read-only rootfs, `cap_drop ALL`.
- **CI/CD (`.github/workflows/`):** `ci.yml` (Node 20/22 typecheck+build+vitest + prod-deps boot smoke + web lint/test/build), `deploy.yml` (push→main, self-hosted MS-01 runner, rsync→`docker compose up -d --build`→`/health` poll), `codeql.yml` (weekly, opt-in via `ENABLE_CODEQL`), `audit.yml` (daily `npm audit`), `sbom.yml` (CycloneDX on tags).

### Config & env surface
- **Config file** (`MCP_MEMORY_CONFIG_PATH` ?? `~/.mcp-memory/config.json`, Zod-validated singleton): `defaults`, `projects[]`, `consolidation`, `hooks`, `extraction`, `storage`, `sharing`, `vault`, `capture`.
- **~40 env vars** (all read at process start — restart to change): networking (`MCP_PORT`/`MCP_BIND`), auth (`MCP_AUTH_TOKEN`/`MCP_AUTH_OPTIONAL`/`MCP_RATELIMIT_DISABLED`), tenancy/privacy (`MCP_API_NAMESPACE`, `MCP_PUBLISH_ACCESS_LEVELS`, `MCP_TRUSTED_IP_HEADER`), paths (`MCP_MEMORY_DB_PATH`, `MCP_MEMORY_TRANSCRIPT_BASE`, `MCP_VAULT_PATH`, `MCP_VAULT_WRITE_THROUGH`), embeddings (`MCP_MEMORY_MODEL`, `MCP_MEMORY_DIMENSIONS`, `MCP_MEMORY_NLI_MODEL`, `MCP_MEMORY_RERANKER_MODEL`, `HF_HOME`), observability (`MCP_METRICS_ENABLED`, `MCP_LOG_LEVEL`), CSP/HSTS overrides.
- **Undocumented env vars (read by code, absent from ENV.md):** `MCP_API_NAMESPACE`, `MCP_TRUSTED_IP_HEADER`, `MCP_VAULT_PATH`, `MCP_VAULT_WRITE_THROUGH`, `MCP_PUBLISH_RATELIMIT_CAPACITY/_REFILL_PER_SEC`.
- **Doc/code mismatch:** ENV.md says "production omits detail"; code only surfaces error `detail` when `NODE_ENV==='development'` (suppressed by default).
- **Dead config key:** `storage.db_path` — `db/connection.ts` reads `MCP_MEMORY_DB_PATH` env, not the config key.

---

## 8. Web frontend

See §3.16. Pages: Dashboard, Search, Browse, MemoryDetail, KnowledgeGraph. The SPA always hits relative `/api/*`; dev Vite proxies to `:3100`, prod is served by `serve.ts` from `dist/web` with an SPA history fallback. State is per-page `useState` + URL searchParams (no React Query/Zustand). What it surfaces: stats cards + breakdowns; hybrid/Fuse search; paginated/sortable table; single-memory tabs with version history + related; D3 force-directed knowledge graph (min-importance slider, scope-colored nodes, dblclick→detail). Notable gaps: no login UI (token via console/localStorage), Edit dialog only sends title+content, near-zero test coverage.

---

## 9. Testing

**Two Vitest projects:** backend (`vitest.config.ts`, node env, `src/**/*.test.ts`, thresholds **lines/statements 100, functions 99, branches 90**) and web (`web/vitest.config.ts`, jsdom, only 2 test files). **~103 test files, ~921 cases.**

**Shared harnesses:** `createTestDb()` (`src/testing/test-db.ts` — fresh `:memory:` SQLite, full schema + migrations re-run from version 0 to exercise migration paths) and `MockEmbeddingProvider` (`src/testing/mock-embedder.ts` — deterministic 384-dim hashed unit vectors, no model download). API tests boot the real Express app via `buildApp` on an ephemeral port and fire raw `node:http` requests (zero extra deps). Rerankers/NLI use injected stubs; CLI wizard uses a scripted `Prompter`; hooks use tmpdir fixtures.

**Layout (strongest → thinnest):** tools (27 files/161 cases), graph (16/112), api (13/93), search (12/88), vault (12/70), db (6/59), lib (4/30), cli (3/18), schemas (1/12), chunking (1/8), hooks (1/7), embeddings (1/3), root integration (4: battle-test, developer-simulation, coverage-fill, coverage-final), web (2).

**Strengths:** deterministic by design (no real model/DB); strict enforced thresholds with a documented exclude list; deep hardening/regression coverage (TOCTOU, atomicity, proto-pollution, path-traversal, REST tenancy, scope-privacy, supersede signals, bitemporal). Every test file opens with a JSDoc tying it to a phase/pillar/bug-ID.

**Verified coverage gaps:**
- **MCP dispatch path entirely untested** — `createServer`, `instrument`, MCP-layer `withForcedNs`/`idInForcedNs`, 41-tool registration, `.shape` advertising, `memory_delete innerType()` reconstruction. Only `formatResult` is imported. (REST `forcedApiNamespace` IS tested in `remote-namespace.test.ts`.)
- **Search-log writer→reader contract untested** — the real `memory-post-search.ts` writer is never driven; the consolidate test uses a reader-shaped fixture that masks the `results_count`/`results` mismatch.
- **`getReadOnlyDb` migration side-effect untested** — only an identity/alias test exists.
- **`graphCache` namespace isolation untested** — no test sets `MCP_API_NAMESPACE` on `/api/graph`.
- **`extract-entities.ts` has no dedicated test** — only incidental; alias write, rollback, created-vs-updated counting unverified.
- **`memory_export` bitemporal/parent_id gap, `include_embeddings` no-op, `handleStats` invalidated-row inclusion + size-0 fallback** unasserted.
- Thin: `config/loader` (incidental only), `publish/wiki` (HTTP-level only), `embeddings` (24-line guard), hooks (only `resolveTranscriptPath`), `lib/logger` + `lib/direct-access` (none), chunking strategies internals (smoke only), web frontend (2 files).
- **Doc drift:** `CONTRIBUTING.md` cites coverage thresholds 75/75/70; actual `vitest.config.ts` enforces 100/100/99/90.
- **Version skew:** web pins Vitest `^4.1.5`, backend `^3.0.0`.

---

## 10. Gotchas, tech debt & open follow-ups

### Confirmed bugs (verified against source)
1. **Search-log analytics is dead in production.** `memory-post-search.ts:62` writes `results_count`; `consolidate.ts:83` reads `entry.results === 0` → `report.knowledge_gaps` is always `[]`. Masked by a reader-shaped test fixture. Fix: align reader to `results_count`.
2. **`extract-learnings` dedup threshold inconsistency.** `extract-learnings.ts` uses obsolete `(1-0.85)*2 = 0.30`; `consolidate.ts` uses `l2FromCosineSim(0.85) ≈ 0.548`. Auto-capture under-dedups/under-corroborates. Fix: use `l2FromCosineSim(0.85)`.
3. **`getReadOnlyDb` is a misnamed alias** — opens a writable cached connection and runs `initializeSchema`+`runMigrations`, so "read-only" CLI commands (backup/sync/share/vault-init) can ALTER/CREATE/UPDATE schema + bump version on first call.

### Tenancy / privacy / security
4. `graphCache` key omits the forced namespace → latent cross-namespace leak under varying `MCP_API_NAMESPACE` within the 60s TTL.
5. Privacy default (`scope != 'user'` in `hybrid.ts`) is untested; easy to miss when debugging missing memories.
6. Tenancy logic duplicated (MCP `withForcedNs`/`idInForcedNs` vs REST `forcedApiNamespace`/`assertNamespaceAllowed`) — a scoping bug must be fixed in two places.
7. `logger` redaction is shallow (top-level keys only; misses nested + `bearer`/`pwd`/`access_token`).
8. `sanitizePath` doesn't resolve symlinks (relies on vault/write-through's separate realpath).
9. Live bearer token (`XcqgDKon9aOH4i/...`) sits in plaintext in the operator's global CLAUDE.md.

### Correctness / consistency divergences
10. `memory_export` exports invalidated + chunk rows (no validity filter); `include_embeddings` is a no-op; 1000-row silent truncation.
11. `handleStats` and `handleManifest` count invalidated/superseded rows; `handleUpdate` re-embeds non-contextualized content; `as_of` doesn't reconstruct historical content.
12. Two conflict detectors (always-on Jaccard vs opt-in NLI) → default store mislabels negations as near-dupes.
13. vec0 rows survive bitemporal invalidation → every direct `memories_vec` consumer must re-filter.
14. Embedding cache 500-char-prefix collision; truncate-only resize.
15. `normalizeName` lossily merges dotted names; `entity_aliases` resolution unimplemented; `entity_relationships.strength` is dead.
16. Vault: `vault_sync` import path is not field-lossless (vs write-through/rebuild path); chunked-file write-through/rebuild divergence; sidecar drifts from live edits until full sync; `vault_status`/`syncVault` mtime-floor mismatch.
17. Chunking: `'structured'` has no strategy; overlap can exceed chunk size; offsets inaccurate after overlap.

### Untested surfaces (see §9) and known deferred follow-ups (per MEMORY.md)
18. MCP dispatch path, search-log contract, `getReadOnlyDb` side-effect, `graphCache` namespace isolation, `extract-entities` handler, `export`/`stats` divergences.
19. **Deferred audit items:** `init --project` content, `as_of` content reconstruction, supersede-neighbor handling, vault markdown round-trip completeness, `CONTRIBUTING.md` coverage-threshold doc drift, web Vitest version skew.