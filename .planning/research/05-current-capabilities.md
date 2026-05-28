# Current Capabilities Audit — mcp-memory-server

Source: `/Users/yonasvalentin/Projekter/mcp-memory-server` (v1.0.0, TypeScript, 452 tests).
Method: read of `src/**` and `web/src/**` (not the README's claims). Where the README and the
code disagree, the code wins and the discrepancy is flagged.

This document is the "what already exists" inventory so downstream synthesis does not re-propose
things that are already built, and an honest "where it is shallow" list so we know what is real
work vs marketing.

---

## 0. Headline corrections to the README

- **Tool count is wrong.** README says "17 MCP tools." `src/server.ts` registers **22 tools**.
  The 5 not in the README's headline are: `memory_manifest`, `memory_graph`,
  `memory_extract_entities`, `memory_condense`, `memory_restore`. (`memory_consolidate` and
  `memory_extract_learnings` are counted in the README's "12 core" loosely.)
- **Schema is v4, not v3.** README says "schema version 3"; `CURRENT_SCHEMA_VERSION = 4`
  (`src/db/schema.ts:7`). v4 added superseded/condensation/provenance columns + the entire
  entity-graph table set + conflict + originals tables.
- **The web "Knowledge Graph" is NOT the entity graph.** This is the single most important finding.
  The dashboard graph and `/api/graph` build edges from **vector similarity between memories**, not
  from the `entities`/`entity_relationships` tables. The real graph layer is invisible in the UI.

---

## 1. MCP Tools (`src/tools/*.ts`, registered in `src/server.ts`)

22 tools. Each handler is pure (db + embedder injected) and is reused by both the MCP layer and the
REST API — no logic duplication.

| # | Tool | Handler | What it actually does |
|---|------|---------|-----------------------|
| 1 | `memory_store` | `store.ts` | Embeds content, runs a **read-only conflict scan** (`detectConflicts`), short-circuits to return the existing row on exact duplicate, else inserts (memories+FTS+vec atomically), records conflicts, runs **regex entity extraction**. importance seeded by `computeContentSignal`. |
| 2 | `memory_search` | `search.ts` → `search/hybrid.ts` | Hybrid RRF search (see §2). |
| 3 | `memory_get` | `get.ts` | Fetch by id; optional child chunks. |
| 4 | `memory_update` | `update.ts` | Re-embeds if content changes; writes a `memory_versions` row. TOCTOU-guarded (test `update-toctou`). |
| 5 | `memory_delete` | `delete.ts` | Delete by id or filter; cascades via FK. |
| 6 | `memory_list` | `list.ts` | Paginated/sorted browse. |
| 7 | `memory_ingest` | `ingest.ts` | Chunk (text/markdown/code/legal/structured) → embed → parent+children rows. **No entity extraction on chunks.** |
| 8 | `memory_related` | `related.ts` | Re-embeds the target's content, vec-KNN, excludes self + own chunks, records a `related` access. |
| 9 | `memory_versions` | `versions.ts` | Read version history. |
| 10 | `memory_stats` | `stats.ts` | Counts/breakdowns/size. |
| 11 | `memory_export` | `export.ts` | JSON export, max 1000, optional embeddings. |
| 12 | `memory_import` | `import.ts` | Embed + store array. |
| 13 | `vault_sync` | `vault-sync.ts` → `vault/sync.ts` | Obsidian sync (see §3). |
| 14 | `vault_status` | `vault-status.ts` | Synced/pending/changed/deleted counts via mtime compare. |
| 15 | `vault_search` | `vault-search.ts` | Hybrid search scoped to a vault namespace. |
| 16 | `memory_consolidate` | `consolidate.ts` | 6-stage "dream cycle" (see §6). |
| 17 | `memory_extract_learnings` | `extract-learnings.ts` | **Regex** learning miner (see §6). |
| 18 | `memory_manifest` | `manifest.ts` | Lightweight title/type/tag/score index (no content) — designed as a cheap "what exists" probe before search. Genuinely useful, under-advertised. |
| 19 | `memory_graph` | `graph.ts` | Entity-graph query: neighbors at depth 1, or **recursive-CTE multi-hop (depth ≤3)**, or browse-all-by-type. Returns entities + their relationships + linked memories. **Only consumer of the entity tables.** |
| 20 | `memory_extract_entities` | `extract-entities.ts` | **The only path that ever writes `entity_relationships` edges.** Caller (LLM) must supply structured entities + relationships; stores with `extracted_by='llm'`, confidence 0.9, plus aliases. |
| 21 | `memory_condense` | `condense.ts` | Apply agent-supplied summary/one-liner, preserve original in `memory_originals`, re-embed. |
| 22 | `memory_restore` | `condense.ts` | Undo condensation from `memory_originals`, re-embed original. |

---

## 2. Search stack (`src/search/*`) — solid, the strongest layer

**`hybrid.ts`** (real RRF, not a fake):
- Oversamples `min(limit*3, 300)` from both vec (`memories_vec MATCH … k=`) and FTS5 (`MATCH … ORDER BY rank`).
- FTS query is sanitized (`sanitizeFtsQuery`): strips smart quotes, zero-width chars, emoji, and FTS
  operator chars, then quotes each token — defends against the common "user pasted a query and FTS5
  threw a syntax error" failure. There is a dedicated test (`fts-sanitizer.test.ts`).
- Both arms degrade gracefully (try/catch → continue with the other arm).
- **RRF** with K=60: `score += 1/(K+rank)` summed over both rankings. Standard, correct.
- **Importance boost**: `rrf * (1 + importance_score*0.5)` — re-ranks toward high-importance memories
  without drowning relevance. This is a real, sensible touch.
- Metadata filters applied as a SQL WHERE on the candidate set (scope/namespace/department/type/
  access_level/language/tags-LIKE/date range), plus hard exclusion of expired and `superseded_at IS NULL`.
- Pagination + `min_confidence` filter + `truncated` flag.

**`scoring.ts`**: confidence blends vector-sim (`1 - dist/2`), keyword-sim (`1 - |rank|/25`), and a
position factor; averages whichever signals are present. Labels high≥0.7 / medium≥0.4 / low.

**`temporal.ts`**: exponential or linear decay with an **access-count boost** (frequently accessed
memories resist decay: half-life scaled by `1 + min(access,50)*0.02`). Nice detail.

**`content-signals.ts`**: tiny regex heuristic that seeds importance at store time — boosts on
rule/decision/error/code-block language, penalizes draft/short content. Also exposes a
`maturityTier()` (draft/validated/core) that **is defined but not surfaced anywhere** (no tool, no
UI reads it).

**Freshness warnings**: results carry `age_days` + a human freshness warning at >30/>90 days. Good
for an LLM consumer.

Honest read: this is a legitimately good local hybrid-search engine. Little to add here except
maybe per-field FTS weighting and tunable RRF/importance constants.

---

## 3. Vault integration (`src/vault/parser.ts`, `scanner.ts`, `sync.ts`) — shallow Obsidian awareness

**What it does well:**
- `parser.ts` parses YAML frontmatter (CRLF-aware), extracts `[[wiki-links]]` (handles
  `#heading` and `|alias` forms), inline `#tags`, merges frontmatter+inline tags, derives a title
  (frontmatter `title` → first alias → prettified filename).
- `scanner.ts` recursive `.md` walk, skips dotfiles/dirs, **refuses symlinks** (security), respects
  picomatch include/exclude globs, deterministic sort.
- `sync.ts` incremental by mtime, batched embeds (50/batch), large files chunked markdown-aware,
  parse-before-delete ordering (a crash mid-sync can't lose the old memory), handles add/update/delete,
  reports per-file errors.

**Where it is genuinely shallow / one-directional — this is the gap list:**
1. **Read-only. No write-back.** Memories are never written back as `.md`. README roadmap admits
   "bidirectional export" is unbuilt. So it's an import pipe, not a true two-way "vault".
2. **No file watcher.** Confirmed: zero `chokidar`/`fs.watch` in `src`. Sync is manual or
   nightly-cron only. "Auto-sync on change" is roadmap, not real.
3. **Wiki-links / backlinks are dead metadata.** `[[links]]` are stored as a raw string array in
   `metadata.links` (`sync.ts:291`) and **never resolved to memory IDs, never turned into
   entity_relationships, never used for backlink discovery or multi-hop traversal.** The single most
   Obsidian-native signal (the link graph) is captured and then ignored. README confirms "backlink
   graph" is roadmap.
4. **No entity extraction on vault content.** `vault/sync.ts` calls `insertMemory` directly, NOT
   `handleStore`, so the regex entity-extractor never runs on vault notes and conflict detection
   never runs either. Vault notes are invisible to the knowledge graph.
5. **Flat metadata mapping.** Everything lands as `scope='project'`, `document_type='note'`,
   `access_level='internal'`. Only `author`/`department`/`language` are read from frontmatter;
   arbitrary Obsidian properties survive only inside `metadata.frontmatter` (not queryable).
6. **No vault content-type detection.** Always chunked as `markdown`; no per-folder document_type or tag rules.

Verdict: "Obsidian-aware" is generous. It is "markdown-folder-aware with frontmatter + tag parsing."
It reads the link syntax but does nothing graph-like with it.

---

## 4. Graph layer (`src/graph/*`) — nodes exist, automatic edges effectively don't

**`entity-extractor.ts` — regex, not LLM, and narrow:**
- Pure regex over content. Extracts: scoped packages (`@scope/name`), a **hardcoded 19-tool
  allowlist** (`react, expo, jest, docker, prisma, postgres, redis, webpack, vite, eslint, prettier,
  supabase, firebase, sentry, tailwind, nextjs, nestjs, express`), pattern-suffix identifiers
  (`*Service`, `*Repository`, …), generic PascalCase (confidence 0.5), and file paths by extension (0.4).
- No `person`/`organization`/`project` detection at all in regex — those types exist only if an LLM
  feeds them via `memory_extract_entities`. So the auto-extractor mostly emits low-confidence
  engineering jargon and will completely miss any non-engineering domain (legal/HR/finance entities),
  despite the README's cross-department pitch.
- No NER, no embeddings, no coreference. Pure surface matching.

**`entity-store.ts`:**
- `findOrCreateEntity` normalizes to `[a-z0-9-]` and dedups on normalized name; has a sensible
  "upgrade generic→specific type when LLM provides a better type" rule. Bumps `mention_count`.
- `storeExtractedEntities` only ever creates `memory_entities` links with `role='mention'`.
- **`findOrCreateRelationship` is defined here but is NEVER called by the regex path.** Grep confirms
  the only caller is `memory_extract_entities` (the LLM tool).

**The core graph limitation (verified by grep):**
- The automatic store path creates entity **nodes** but **zero edges**. Edges (`entity_relationships`)
  only ever come from an LLM explicitly calling `memory_extract_entities` with a `relationships` array.
- Therefore, unless an agent is deliberately driving `memory_extract_entities`, the graph is a bag of
  disconnected nodes. `memory_graph` traversal will return mostly singletons.
- `entity_relationships.strength` is in the schema and read by `memory_graph`, but **nothing ever sets
  it** beyond the default 0.5 — `findOrCreateRelationship` bumps `evidence_count` but never recomputes
  `strength`. So edge weight is a constant.

**`conflict-resolver.ts` — actually decent:**
- `detectConflicts` does vec-KNN (k=10, distance<0.4), then a blended score
  `0.5*vectorSim + 0.5*jaccard(significant words)` → buckets duplicate(>0.85)/superseded(>0.75)/
  contradicted(>0.65). Read-only; persistence (`recordConflicts`) marks `superseded_at` and writes
  `memory_conflicts`. Wired into `memory_store`. This is a real, working "memory hygiene" feature and
  is more sophisticated than the graph itself.
- Caveat: the superseded/contradicted branches are `c8 ignore`d because the mock embedder can't hit
  those score windows — real-world behavior of those buckets is under-validated.

---

## 5. Embeddings (`src/embeddings/*`) — fine, minimal

- `transformers.ts`: Transformers.js feature-extraction pipeline, lazy-init, `Xenova/all-MiniLM-L6-v2`
  default (384d, env-overridable), fp32/CPU, mean-pool + normalize, truncates to configured dims,
  batch size 32. Single provider — no OpenAI/Ollama (roadmap).
- `cache.ts`: `CachedEmbeddingProvider` is an **in-process LRU** keyed on `text.slice(0,500)`,
  capacity 1024, with batch-aware partial-hit handling. Note: cache key is the 500-char prefix, so
  two long texts sharing a prefix collide (minor correctness risk, fine in practice).
- `provider.ts`: just a type re-export. No on-disk embedding cache — model weights are cached by HF,
  but computed vectors are not persisted across process restarts (only stored in `memories_vec`).

---

## 6. Self-improvement: consolidate + extract-learnings + Stop hook

**`consolidate.ts` ("dream cycle") — 6 stages, with real safety rails:**
0. **Importance decay** (`importance *= 0.995^days_since_access`, floor 0.01) — README's 5-stage
   diagram omits this stage 0.
1. Recompute quality scores (`updateQualityScores`, formula in `repository.ts` matches the README:
   `0.3*current + 0.4*normalized_access + 0.3*recency`).
2. Expire (delete past `expires_at`).
3. Prune low-quality (only if it has a near-duplicate; guarded by importance<min ∧ confidence<0.3 ∧
   access=0 ∧ age>30d).
4. Dedup/merge near-duplicates (vec-based, content-merge, re-embed).
5. Knowledge gaps from `search-log.jsonl` (queries with ≥2 zero-result hits).
- Has an **operation budget + embedding budget + 5-min time budget** — won't run away. Rotates
  access-log >90d. This is well-engineered.

**`extract-learnings.ts` — regex, explicitly NOT an LLM:**
- Preprocesses transcript (strips code fences, tables, diffs, JSON, paths), then 5 regex patterns
  (decision/error_fix/pattern/convention), quality-gates each candidate (`isQualityContent`),
  dedups by vec similarity, optionally auto-stores with low confidence and a `corroboration_count`
  that increments on repeat sightings. Capped at 20.
- This is the "heuristic" path. The **LLM path is the Stop hook**, which is a different mechanism:

**Stop hook (`hooks/memory-stop.ts` + `cli/review-and-store.ts`):**
- Stop hook is a thin spawner: re-entry-guarded, path-sanitized transcript, spawns a **detached**
  `review-and-store.js` and exits ~immediately.
- `review-and-store.ts` shells out to `claude -p --allowedTools mcp__memory-server__memory_store`
  with a curation prompt (max 5 entries, project scope). So the "LLM judgment" extraction is real but
  **external** — it depends on the Claude Code CLI being installed/authenticated on the same machine.
  No in-process LLM. There is one happy-path test (`memory-stop-path.test.ts`).

---

## 7. DB schema (`src/db/schema.ts`, `migrations.ts`) — well-structured, three-table sync real

- **Three-table atomic sync** is genuine: `repository.insertMemory` wraps memories + `memories_vec`
  (vec0, parameterized dim) + `memories_fts` (FTS5 external-content) in one transaction.
- Dimension consistency is enforced on open (`assertDimensionConsistency`) — guards the silent
  "wrong-dim inserts get dropped" sqlite-vec footgun. Good.
- Migrations v2→v3→v4 are forward-only, idempotent, wrapped in a transaction, stamped in `schema_meta`.
  **No down-migrations.** `initializeSchema` refuses partial/legacy DBs with a clear "run migrate" error.
- Full table set: `memories`, `memories_fts`, `memories_vec`, `memory_versions`, `vault_sync_meta`,
  `memory_access_log`, `ingest_source_tracking`, `entities`, `entity_aliases`,
  `entity_relationships`, `memory_entities`, `memory_conflicts`, `memory_originals`. Sensible indexes
  throughout.

---

## 8. Web dashboard (`web/src/pages/*`) — clean, but the graph is mislabeled

- React 19 + Vite + Tailwind v4 + shadcn/ui. Pages: `Dashboard`, `Search` (Fuse.js client-side fuzzy
  suggest), `Browse` (sortable/paginated table), `MemoryDetail` (content + metadata + versions +
  related + inline edit/delete), `KnowledgeGraph`.
- **`KnowledgeGraph.tsx` renders a D3 force graph whose nodes are memories and whose edges are
  vector-similarity links** (built server-side in `/api/graph` by calling `handleRelated` per node,
  min_similarity 0.3, top-5). It is sized by importance, colored by scope, has zoom/pan/drag/tooltip/
  dblclick-to-open, and an importance slider. It is a nice **memory-similarity** visualization — but
  it does NOT touch `entities`/`entity_relationships`. **The entity knowledge graph has no UI.**
- `/api/graph` is O(N) embeds + O(N) vec queries per request; mitigated by a 60s in-process TTL cache.
  Still won't scale to large stores and re-embeds content it already has vectors for (could read
  `memories_vec` directly instead of re-embedding).

---

## 9. API + hooks + infra (brief)

- **REST API** (`api/routes.ts`): 8 routes (stats/search/memories/:id/versions/related/PATCH/DELETE/
  graph/manifest) — README says 9, manifest makes it 9 if counted. Zod-validated, Prometheus metrics
  (`api/metrics.ts`), structured logging, request IDs, security headers + rate limiting present.
- **Hooks**: SessionStart (status), PostToolUse (search hit/miss → `search-log.jsonl`), PreCompact
  (regex extraction, off by default), Stop (LLM review, above).
- **CLI**: `init` (launchd/cron + settings + `.mcp.json`), `uninstall`, `consolidate`,
  `cleanup-extracted`, `serve`, `extract-from-transcript`.

---

## 10. The honest gap list (what's missing for it to feel like a real "memory layer" / "vault")

Ranked by how much they undercut the product's own pitch:

1. **The knowledge graph is barely a graph.** Auto-extraction makes nodes, never edges. Edges require
   an LLM to call `memory_extract_entities` by hand. Edge `strength` is a constant. There is no
   automatic relationship inference (co-occurrence, "uses", "depends_on") from content. → The most
   impactful single improvement is **auto-deriving edges**: from entity co-occurrence within a memory,
   from vault wiki-links, and/or from a cheap LLM/heuristic pass.
2. **Two disconnected "graphs."** The UI graph (memory-similarity) and the data-model graph
   (entity-relationship) share nothing. There is no page that shows entities at all. → Surface the
   real entity graph in the dashboard, or unify the two.
3. **Vault link graph is captured and discarded.** Resolving `[[wiki-links]]` to memory IDs would
   instantly give a real, dense, accurate edge set for free — and it's already parsed.
4. **Regex entity extraction is engineering-only and low-recall.** Hardcoded 19-tool list, no
   person/org/project, no NER. Contradicts the cross-department (legal/HR/finance) marketing.
5. **Vault is one-directional and not live.** No write-back, no watcher. It's an importer, not a vault.
6. **Vault notes bypass `handleStore`**, so they get neither entity extraction nor conflict detection
   — vault content is a second-class citizen in every "smart" subsystem.
7. **`maturityTier` (draft/validated/core) is computed-able but unused** — a ready-made "trust level"
   signal that no tool or UI exposes.
8. **No on-disk vector/embedding cache** beyond the DB; cold start re-loads the model; the LRU is
   process-local and prefix-keyed (collision risk on long texts).
9. **No real LLM in-process anywhere** — the only "intelligence" beyond regex is the external
   `claude -p` Stop hook, which needs the CLI installed and won't run in Docker/headless team deploys.
10. **Scale ceiling** is real: `/api/graph` re-embeds per node; sqlite-vec ~100K vectors; merges/
    consolidation are O(N) embed-bound.

---

## 11. One-line summary

A genuinely strong **local hybrid-search + memory-hygiene** server (RRF search, conflict/dedup,
quality scoring, dream-cycle consolidation, versioning, clean schema, good tests) with a **bolted-on,
mostly-inert knowledge-graph layer**: entity nodes are auto-created but edges almost never are, the
Obsidian link graph is parsed then ignored, vault sync is a read-only importer, and the dashboard's
"Knowledge Graph" is actually a memory-similarity view, not the entity graph.
