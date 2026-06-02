Both core claims verified against live source: `consolidate.ts:64-68` reads `results` while the writer emits `results_count`, and `getReadOnlyDb`/`getReadWriteDb` are byte-identical migration-running functions. Plan files exist at the referenced paths. I have everything needed to synthesize.

# mcp-memory-server — BATTLE PLAN

> Single prioritized plan for the full overhaul. Verified against live source (`consolidate.ts:64-83`, `direct-access.ts:18-35` confirmed). Refactor detail: `.battle/plans/REFACTOR.md`. Structure detail: `.battle/plans/STRUCTURE.md`.

---

## 1. Executive summary

**Current state.** 921 tests green. The real local embedder (Transformers.js / all-MiniLM-L6-v2) works in-process. The substrate is genuinely strong and largely unique in the field: single-file SQLite + sqlite-vec + FTS5 RRF hybrid, full graph schema already shipped (entities, aliases, relationships, conflicts, versions), enterprise governance (scope/namespace/department/access_level, soft+hard forget, audit log), Obsidian vault round-trip, JSON Canvas, REST API, and a 6-stage dream-cycle. **100% local, zero-telemetry, zero cost-per-token** — a moat no cloud rival (mem0/Zep/Letta/Cognee/Supermemory) or native memory (ChatGPT/Claude) can claim.

**The gap to "revolutionary."** Three classes of problem stand between "solid" and "beats the field":

1. **Confirmed correctness bugs that silently corrupt or degrade** — a cache key collision returning wrong vectors, a "read-only" path that mutates schema, exports that resurrect deleted facts, negations mislabeled as duplicates. These must be fixed first; they undermine every benchmark claim and every demo.
2. **A credibility vacuum** — *zero* published benchmark numbers while every competitor (even self-reported) leads with LOCOMO/LongMemEval scores. We cannot claim "revolutionary" without a reproducible local harness.
3. **Three category-defining features the substrate already half-supports but doesn't exploit**: **bi-temporal validity** (the single most-cited 2026 differentiator, Zep owns it — but no one owns it *locally + vault-backed*), a **self-weaving graph + Personalized PageRank** (the graph is currently a bag of nodes with constant-0.5 edges), and a **local NLI write-gate + cross-encoder reranker** (closes the recall/precision gap to mem0 without a cloud LLM).

Ruthless framing: **fix the silent-corruption bugs → publish numbers → ship bi-temporal + self-weaving graph → reframe from "search box" to "agent-OS memory."** Everything else is supporting fire.

---

## 2. Fix queue (ordered)

Bugs first, by severity. `type`: **B**=bug, **D**=divergence. Blast radius is the count/kind of call sites or consumers affected.

| # | Issue | Sev | Type | Fix | Test to add | Blast radius |
|---|-------|-----|------|-----|-------------|--------------|
| 1 | **Embedding cache key = `text.slice(0,500)`** → shared-prefix collision returns the *wrong* vector on the live path (`server.ts:180`). Silent, order-dependent corpus corruption. | **HIGH** | B | `cache.ts:30,46`: key on a content hash of the **full** text (e.g. SHA-256, or `len + hash(tail)`), not a 500-char prefix. | Two distinct texts sharing first 500 chars → assert `embed(a) !== embed(b)` and each matches its own inner-provider vector. | Narrow code, **wide data**: every store/search/dedup through `CachedEmbeddingProvider`. Fix is 2 lines; risk is the latent corruption already on disk → flag a re-embed advisory. |
| 2 | **`getReadOnlyDb()` is a misnamed `getReadWriteDb()`** — runs `initializeSchema`+`runMigrations`, so backup/sync/export-graph/vault-init silently ALTER tables and bump `schema_version` (verified: v4→v9, adds `stability`/`agent_id`/`core_memory`). Backup mutates the DB it's snapshotting. | **HIGH** | B | `direct-access.ts:18-23`: open `{ readonly: true }` (add mode to `connection.ts:9-35`); `getReadOnlyDb` must **not** migrate — verify version ≥ required, else throw pointing at `migrate`. Keep `getReadWriteDb` as the only migrating path. | Stamp temp DB at v4; call `getReadOnlyDb()`; assert `schema_version` still `4`, no `stability`/`agent_id`/`core_memory`. Pair: `getReadWriteDb()` *does* migrate to 9. | 4 CLI commands (`backup.ts:33`, `sync.ts:37`, `share.ts:27`, `vault-init.ts:68`). Moderate: must confirm those flows don't *rely* on the implicit migration. |
| 3 | **`memory_export` resurrects dead facts** — `SELECT * FROM memories` with no `valid_to/tx_expired` and no `parent_id IS NULL` filter; `include_embeddings` is a documented param that does nothing; hard `LIMIT 1000` silently truncates large corpora. The backup/migration primitive loses and revives data. | **HIGH** | D | `export.ts:33-37`: add validity guard + `parent_id IS NULL`; either implement `include_embeddings` (join `memories_vec`) or drop the param; replace fixed `LIMIT 1000` with limit/offset + `has_more`/`truncated` flag. | Store live + superseded + child rows; export; assert only live top-level returned, count matches `memory_list`, `truncated` flag on >limit corpora. | Export consumers + restore round-trip. Couples with #7 (predicate consolidation) and #9 (vec authority). |
| 4 | **stats/manifest count dead rows; DB size = 0 for `:memory:`** — every COUNT/GROUP BY in `stats.ts:38-123` and `manifest.ts:17,37` omits the validity filter, so `memory_stats` overcounts vs `memory_list`/search and grows wronger with every supersede; `statSync` on env path → 0 (or wrong file) for `:memory:`. | **HIGH** | D | Add `valid_to IS NULL AND tx_expired IS NULL` to every count/group-by and to manifest conditions; derive DB size from the live connection (`db.name`/`PRAGMA database_list`), treat `:memory:` explicitly. | Store+supersede; assert `memory_stats.total_memories === memory_list count`; manifest excludes retired docs; `:memory:` size not conflated with stat failure. | Read-only surfaces; consumes the shared predicate from #7. |
| 5 | **`memory_update` re-embeds RAW content** without `contextualizeForEmbedding` (`update.ts:42`), while store/ingest/vault/store-merge all contextualize. Editing a memory silently *degrades* its own retrievability. | **HIGH** | D | `update.ts:42`: embed `contextualizeForEmbedding(content, {title, document_type, namespace})` using post-update fields, exactly as `store.ts:153-159`. | Store contextualized titled memory, search-rank it; `memory_update` content; assert post-update vector matches contextualized form and rank does not drop. | Single handler. Low risk, high recall impact. |
| 6 | **Default store can't tell a fact from its negation** — `detectConflicts` (Jaccard+vector overlap) runs on every store; NLI only fires when a classifier *and* `on_conflict==='supersede'` are both wired (`store.ts:91`), which no default integration does. "X uses port 3000" vs "X does NOT use port 3000" → classified duplicate (correction silently dropped). | **HIGH** | D | Run NLI on the near-dup-but-low-agreement shortlist whenever a classifier exists, regardless of `on_conflict`; stop letting `detectConflicts` emit duplicate/superseded purely from token overlap; document the no-NLI limitation. **Co-design with revolutionary feature R3.** | "X uses port 3000" then "X does NOT use port 3000": assert NOT classified duplicate; with NLI → contradiction recorded, both retained pending invalidation. | `store.ts:67,91`, conflict-resolver banding. High: touches the core write gate; gate behind classifier presence. |
| 7 | **vec0 rows survive invalidation** — `invalidateMemory` stamps `valid_to` only; `memories_vec` keeps a live vector, so raw `MATCH` returns retired memories. In-tree consumers re-filter (17 hand-written ways, inconsistent column sets), but any new/external consumer leaks stale facts; index grows unbounded with tombstones. | **MED** | B | `repository.ts:289-300`: also DELETE the `memories_vec` row on invalidate (look up rowid as `deleteMemory` does). If as_of vector replay is wanted later, instead centralize the re-filter in one shared helper (ties to REFACTOR **C1**). | Invalidate a memory; assert raw `MATCH` no longer returns it; assert index row gone. | Every `MATCH` call site. Pairs with C1 predicate consolidation. |
| 8 | **`consolidate` knowledge_gaps always `[]`** — reader gates `entry.results === 0` but writer emits `results_count`; the only test fabricates the reader shape, masking it. `report.knowledge_gaps` never populates in production. | **MED** | B | `consolidate.ts:64-68` + `:83`: rename interface field + guard to `results_count`. | Write log in the **writer's** real shape (`results_count`, `top_confidence`, `scope`, `namespace`, `cwd`); assert gap surfaces; assert fixture contains `results_count` not `results`. | Single file. Trivial, isolated. |
| 9 | **extract-learnings dedups at cosine ~0.955, consolidate at 0.85** — leftover linear L2 constant `(1-0.85)*2=0.30` vs the correct `l2FromCosineSim(0.85)=0.5477`. Paraphrases in (0.85, 0.955) are stored as new memories instead of corroborated. | **MED** | D | `extract-learnings.ts:111`: `const DEDUP_DISTANCE_THRESHOLD = l2FromCosineSim(0.85)`. Folds into REFACTOR **D1** (shared `thresholds.ts`). | Stub embedder with two paraphrases at cosine 0.90; assert 2nd extract → `stored_count===0`, `corroboration_count===1`; parity-check consolidate `duplicates_merged>=1`. | Single file; consume shared constant to prevent recurrence. |

**Ordering rationale.** #1 and #2 corrupt data/schema invisibly on the live path — nothing else can be trusted until they're fixed. #3–#5 are HIGH user-facing data-loss/degradation. #6 is HIGH but co-designed with R3 (don't fix twice). #7–#9 are MED and several collapse into the DRY pass (§4), so sequence them right before/with C1 and D1.

---

## 3. Competitive gap → roadmap

### Where we win (defend and amplify)
- **100% local-first, single SQLite file, zero telemetry, $0/token.** No rival can guarantee data never leaves the machine. This is the framing for *everything*.
- **Hybrid vector + FTS5/BM25 in one local engine** — beats keyword-only (official MCP server, Memori) and out-simplifies the Neo4j/FalkorDB/Modal stacks (Zep, Cognee).
- **Obsidian-vault round-trip + JSON Canvas + REST + web dashboard** on one process — more complete than basic-memory.
- **Enterprise governance** (scopes/departments/access_level/GDPR forget/attribution) — far beyond native memory and reference servers.
- **Cross-model**: any MCP client, not locked to ChatGPT/Claude.

### Where we lose (the targets)
- **No bi-temporal validity** — only decay. Zep's headline capability. *Single most-cited differentiator.*
- **No benchmark numbers at all** — pure credibility gap vs everyone.
- **Graph is a bag of nodes** — constant-0.5 edges, no co-occurrence/wiki-link edges, no multi-hop.
- **Heuristic regex extraction + no ADD/UPDATE/DELETE/NOOP write gate** — lower recall than mem0's LLM extraction.
- **Weak 384-dim MiniLM base, no reranker** — under-retrieves on precision.
- **No agent self-editing / tiered core memory** (Letta), no GraphRAG sensemaking, scale ceiling ~100K vectors.

### Buildable, category-defining roadmap (ordered by leverage)

| R | Feature | Why category-defining | Cost / substrate |
|---|---------|----------------------|------------------|
| **R0** | **Reproducible local benchmark harness** — commit a LOCOMO + LongMemEval-S runner + numbers to the repo. | Converts the privacy story from claim to **proof**; ends the "no numbers" gap. *First fully-local, open, independently-reproducible benchmark* vs everyone's self-reported cloud claims. Even mid-pack scores win the framing: "92% of mem0's accuracy at 0% cloud exposure." | New harness; no schema change. **Do immediately after the §2 bug fixes** so the numbers reflect a correct system. |
| **R1** | **Bi-temporal memory** — `valid_from/valid_to + tx_created/tx_expired` on memories *and* entity_relationships; default predicate `valid_to IS NULL AND tx_expired IS NULL`; `as_of` query param; invalidate-don't-delete on contradiction. | The white-space no one occupies: **first local-first, vault-backed system with Zep's headline capability.** Mostly schema on top of existing `superseded_at`/`memory_conflicts`. Pairs with bug #7 (vec authority) and the C1 predicate. | Pure schema + predicate work. Substrate already present. High leverage, moderate effort. |
| **R2** | **Self-weaving graph + HippoRAG PageRank** — wire `findOrCreateRelationship` into store+vault; grow real weighted edges from (a) entity co-occurrence (IDF-weighted strength, not 0.5), (b) resolved `[[wiki-links]]` (parsed in `vault/sync.ts` then thrown away today), (c) vector-KNN unlinked mentions. Add Personalized PageRank (~80 LOC power-iteration) as a 3rd ranker fused into `hybrid.ts`. | Genuine **multi-hop recall** no one does locally — Obsidian can't auto-link; mem0 needs cloud LLM for semantic edges. | Reuses shipped graph tables. Local graph math. |
| **R3** | **Self-correcting write gate** — ADD/UPDATE/DELETE/NOOP discipline with a **small local NLI cross-encoder** (MiniLM/DeBERTa-MNLI via installed `@huggingface/transformers`) over the conflict shortlist; common case decided locally, ambiguous escalated to the consuming agent over MCP; contradictions trigger **bi-temporal invalidation** (R1), not overwrite. **Subsumes bug #6.** | Cheaper, private, self-consistent vs mem0's cloud-LLM-per-write. Directly lifts recall/accuracy and the benchmark numbers. | Model already installable. Couples #6 + R1. |
| **R4** | **Local cross-encoder reranker** (`Xenova/ms-marco-MiniLM-L-6-v2`) as final stage over top-50 RRF candidates. | Anthropic measured rerank dropping retrieval failure 2.9%→1.9% — biggest precision-per-line win for the weak MiniLM base, fully local, bounded cost. | Single final stage in `hybrid.ts`. Low risk, high precision. |
| **R5** | **Two-way Obsidian vault + typed-edge JSON Canvas** — route vault content through `handleStore` (entity extraction + conflict detection), write memories back as frontmattered `.md`, chokidar watcher, `.canvas` with directional `depends-on`/`supersedes` edges from a query. | **Most viral, screenshot-able demo.** basic-memory writes flat notes; nobody emits typed-edge Canvas. The memory becomes a spatial editable map in real Obsidian. | Builds on R1/R2 edges + existing vault/canvas code. |
| **R6** | **Pinned core-memory tier + MemGPT self-edit tools over MCP** — reserved namespace loaded each SessionStart, edited via `core_memory_append/replace`, hot/cold mapped onto existing `access_count`/`condensation_level`. | An MCP server *already is* the archival/recall tier, so self-editing core memory is nearly free here, expensive everywhere else. Reframes product from "search box" to **"agent-OS memory."** Tools already exist (`core_memory_*` in the MCP surface) — wire the SessionStart load + tiering. | Low; primitives shipped. |
| **R7** | **GDPR-grade compliant-memory layer** — formal consent tags, retention windows (extend `expires_at`), verifiable right-to-be-forgotten (cascade delete + tombstone in `memory_access_log`), exportable access trail. | Every cloud rival punts privacy to the app layer. A 100% local, audit-trailed server makes **"provably compliant memory"** a demoable moat for legal/finance/HR (the existing department/access_level model). | Extends shipped governance. |
| **R8** | **Pluggable embedding tier + adaptive retrieval router** — one-line swap to bge-m3/nomic/Matryoshka/Ollama endpoint with re-embed migration; per-query route (vector vs RRF vs PageRank vs subgraph) by query type. | Kills the "384-dim is weak" objection while staying local; router beats any fixed strategy and lifts benchmark scores. | Medium; after R0 quantifies the gains. |

**Sequencing:** §2 bugs → **R0 (numbers)** → **R1 (bi-temporal)** → **R3+R2 (write gate + graph)** → **R4 (reranker)** → **R5/R6 (viral + agent-OS)** → **R7/R8**. R0 first so every later feature's gain is measured, not asserted.

---

## 4. DRY / one-source-of-truth consolidations

From `.battle/plans/REFACTOR.md` — **14 consolidations, 5 new single-source modules** (`src/db/predicates.ts`, `src/lib/tenancy.ts`, `src/constants/enums.ts`, `src/constants/thresholds.ts`, `src/lib/paths.ts`). Ordered by leverage; several directly retire the §2 bugs.

| Order | ID | Consolidation | Blast radius | Risk | Notes |
|-------|----|---------------|--------------|------|-------|
| 1 | **C1** | **Retired-row predicate** → `src/db/predicates.ts`. Hand-written ~17 ways with inconsistent column sets (pagerank/graph/hooks include `superseded_at IS NULL`, others don't); **genuinely missing** in export/stats/manifest. | Wide (search, tools, graph, vault, hooks, publish). | **Med** — must pick the canonical column set; behavior-changing where currently missing (that's the point — fixes #3/#4). | Retires bugs **#3, #4** and underpins **#7** and **R1**. Do early. |
| 2 | **D1** | **Dedup `0.85` threshold + `l2FromCosineSim`** → `src/constants/thresholds.ts`. | extract-learnings, consolidate. | **Low.** | Retires bug **#9**. |
| 3 | **C2** | **`confidence_level` label thresholds** — scoring.ts (0.7/0.4) vs related.ts (0.8/0.5) on the same field → single source. | 2 sites. | **Low** but behavior-changing on one side; pick the intended cut. | Latent divergence found during recon. |
| 4 | **T1** | **Tenancy policy** → `src/lib/tenancy.ts`. Two parallel impls of `MCP_API_NAMESPACE` (server.ts `forcedNs`/`withForcedNs`/`idInForcedNs` vs routes.ts `forcedApiNamespace`/`assertNamespaceAllowed`) running the identical ownership SELECT. | server.ts + routes.ts (security-sensitive). | **Med** — security path; verify byte-identical enforcement + tests on both surfaces. | Single source removes divergence risk on an auth boundary. |
| 5 | **E1/E2/Y1** | **Enum tuples** → `src/constants/enums.ts`. `scope` duplicated 11x + access_level/search_mode/content_type/entity_type/learning-categories/sort-fields; derive `z.infer` to retire the manual `types.ts` mirror. | Wide but mechanical. | **Low-Med** — large diff, but each is a literal-to-import swap; lock with a snapshot of emitted schema. | Removes the most-copied literals; feeds Zod + types from one tuple. |
| 6 | **M1** | **Embedder singleton** — three identical singletons → one. | 3 sites. | **Low.** | |
| 7 | **S1** | **scope/namespace/department WHERE-builder** (11x) → shared. | 11 sites. | **Low-Med.** | |
| 8 | **S2/S3** | **dbPath resolution (7x) + config-path (6x)** → `src/lib/paths.ts`. | 13 sites. | **Low** but touches #2/#4 path logic — sequence after #2. | DB-size fix (#4) should read from the live connection, not this. |
| 9 | **S4/S5/D2** | **tags-JSON parse, age_days/freshness_warning copies, second threshold dup**. | Scattered. | **Low.** | Mop-up. |

**Risk discipline:** C1, T1, E1 are the load-bearing ones (behavior-changing or security-adjacent) — TDD each, snapshot the emitted tool schema + metric labels before/after. The rest are mechanical.

---

## 5. Structure overhaul

From `.battle/plans/STRUCTURE.md` — **8 proposals**. Key insight: production fan-in is tiny (36 tool handlers imported by only 5 production files; the 1268-LOC schemas god-file by only 2), so churn cost lives almost entirely in the **69 test files**. Invariant throughout: **zero behavior change** — tool names, registration order, error envelopes, metric labels byte-identical.

### Safe now (4) — barrel-preserving, near-zero import edits
| ID | Change | Risk |
|----|--------|------|
| **P1** | Split `schemas/index.ts` by domain + extract its 18 private field-factories. | **Safe** — barrel re-export keeps 2 importers unchanged. |
| **P3** | Split `db/repository.ts` by aggregate. | **Safe** — barrel preserved. |
| **P7** | Codify "barrel only for unit-consumed folders" rule. | **Safe** — convention only. |
| **P8** | Ship ubiquitous-language glossary (no cross-dir renames; `handleX`/`runX` already uniform). | **Safe** — docs only. |

### Moderate (2) — verbatim cut-paste + re-export, snapshot-verified
| ID | Change | Risk |
|----|--------|------|
| **P2** | Split `server.ts` 41-call registration wall into per-domain `register*` modules. | **Moderate** — snapshot emitted tool list + metric labels; re-export security helpers. |
| **P4** | Split `serve.ts` into transport/middleware/config. | **Moderate** — same snapshot discipline. |

### Defer (2) — destabilizing, negative ROI now
| ID | Change | Why defer |
|----|--------|-----------|
| **P5** | Regroup `tools/` into crud/cognition/graph/vault/io. | **Destabilizing** — rewrites 100+ test import lines, **zero reuse benefit** (only 5 intra-tools imports), worsens existing `communities.ts`/`canvas.ts` name collisions. |
| **P6** | Co-locate all 101 tests. | **Destabilizing** — largest single diff, conflicts directly with P5. |

**Recommendation:** Do **P1, P3, P7, P8** alongside the §4 DRY pass (they make the new single-source modules land cleanly). Do **P2/P4** only after the §2 bugs and C1/T1 land (so registration/transport changes ride a stable base). **Defer P5/P6** until after the roadmap features stabilize the `tools/` surface — re-grouping a moving target is waste.

---

## 6. Battle-test matrix

Real-life scenarios that **must pass** before calling it remarkable. Each row is a gate.

### A. Solo dev (SQLite, single file)
- [ ] Fresh `npm i` → `init` creates one SQLite file; store/search/list/get round-trip with the **real** embedder (not mock).
- [ ] Store contextualized titled memory, edit via `memory_update`, re-search → rank does **not** drop (gate on bug **#5**).
- [ ] Store a fact then its negation → not a silent duplicate NOOP; correction is retained/surfaced (gate on **#6/R3**).
- [ ] Two long memories sharing first 500 chars → distinct vectors, correct neighbors (gate on **#1**).
- [ ] `memory_export` → wipe → `memory_import` round-trip: live count in == out, **no resurrected superseded/child rows**, no silent truncation on a 5000-row corpus (gate on **#3**).
- [ ] `memory_stats.total_memories === memory_list count` after several supersedes (gate on **#4**).

### B. Team (git vault, 2 devs, merge)
- [ ] Two devs each store memories in a git vault; commit; **union merge driver** merges the deterministic graph artifact with **no conflict markers** and no lost later edits (regression guard: the prior Bruno timestamp-collation bug).
- [ ] `backup`/`sync`/`vault-init` against a below-current DB does **not** silently migrate schema (gate on **#2**).
- [ ] Wiki-links authored in Obsidian survive sync and become **real graph edges** (gate on **R2/R5**), not parsed-and-discarded.
- [ ] Tenancy: a namespaced API caller cannot read/write another namespace (gate on **T1**, both server.ts and routes.ts surfaces).

### C. HTTP / MCP server
- [ ] MCP `serve` and REST `serve` both boot; emitted **tool list + metric labels byte-identical** to pre-refactor snapshot (gate on **P2/P4**).
- [ ] Bearer-auth REST + MCP forced-namespace enforcement identical across both transports.
- [ ] `:memory:` mode: `memory_stats.database_size_bytes` not conflated with a stat failure (gate on **#4**).
- [ ] Concurrent reads during a consolidate run don't corrupt; read-only handles are genuinely read-only (gate on **#2**).

### D. Quality metrics (must be measured, not asserted)
- [ ] **Precision@k and MRR** on a held-out set, reported before/after R4 reranker (target: measurable precision lift).
- [ ] **LOCOMO + LongMemEval-S** run via the committed R0 harness; numbers committed to repo with the runner.
- [ ] **Latency**: p50/p95 for store and search at 1K / 10K / 100K vectors, published as a dashboard (target framing: contest Supermemory sub-300ms / Memori 10-50ms with reproducible local numbers).
- [ ] **knowledge_gaps** actually populate from real hook output (gate on **#8**).
- [ ] extract-learnings and consolidate dedup at the **same** cosine target (gate on **#9**).

### E. Competitive parity checks
- [ ] **Bi-temporal**: "what did we believe about X on date Y, and what superseded it, by whom" answerable via `as_of` (parity with Zep; gate on **R1**) — and *no competitor matches it locally + vault-backed*.
- [ ] **Multi-hop**: a 2-hop associative query returns the bridging memory via PageRank that pure vector/FTS misses (gate on **R2**).
- [ ] **Write gate**: ADD/UPDATE/DELETE/NOOP decisions made locally by NLI on the common case; only ambiguous cases escalate (gate on **R3**).
- [ ] **Self-editing core memory**: agent loads pinned core block at SessionStart and edits it via MCP (parity with Letta; gate on **R6**).
- [ ] **Viral demo**: a query emits a valid `.canvas` with typed directional edges that opens as a spatial map in real Obsidian (gate on **R5**).
- [ ] **Provably local**: full run with network disabled — store, search, extract, consolidate, NLI gate all succeed offline, zero telemetry (the moat, end-to-end).

---

**Bottom line.** Fix the four silent-corruption HIGHs (#1–#5) and the three MEDs (#7–#9) first — they invalidate every number and demo. Then **publish benchmarks (R0)** to convert the privacy story into proof. Then ship **bi-temporal (R1) + self-weaving graph/write-gate (R2/R3) + reranker (R4)** to take the recall/precision and temporal-reasoning crowns *locally* — white-space no competitor occupies. The DRY pass (C1/D1/T1) lands the predicate and threshold fixes structurally so they can't regress; defer the destabilizing structure moves (P5/P6) until the `tools/` surface stops moving.