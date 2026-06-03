# Developing the server (contributor reference)

For changing the server itself. Pair with `architecture.md` (map) and `/.planning/CODEBASE-MAP.md` (exhaustive).

## Contents
1. Build / test / verify commands
2. Testing conventions
3. Roadmap — shipped vs remaining
4. Current open items (honest)
5. Competitive positioning
6. Doc drift to fix

---

## 1. Build / test / verify commands

```bash
npm run build      # tsc
npm test           # vitest — 1000 tests (mock embedder, :memory: SQLite, deterministic)
npm run smoke      # REAL MCP stdio JSON-RPC round-trip (41 tools, real models)
npm run bench      # REAL retrieval quality + latency (gold set, real embedder + reranker)

# Real-runtime simulations (real model + real SQLite + real git):
node scripts/battle/sim-solo.mjs        # RERANK=1 for the rerank path; P@1/MRR
node scripts/battle/sim-team.mjs        # 2-dev git vault: recall, lossless, union merge
node scripts/battle/verify-nli.mjs      # real NLI write-gate (DeBERTa-v3-xsmall)
node scripts/battle/verify-hooks.mjs    # all 4 hooks live
node scripts/battle/verify-scale.mjs    # 1K/10K/50K latency
node scripts/battle/verify-web.mjs      # boot server + drive dashboard headless
```
Models cache under `node_modules/@huggingface/transformers/.cache` (embedder, reranker, NLI all present offline). Worktree agents: `ln -s <repo>/node_modules node_modules` before running.

**Gates:** `npm run build` clean + `npm test` green are mandatory. For any quality/behavior claim, run the relevant real sim — mock tests alone don't prove retrieval quality or the real-model paths.

## 2. Testing conventions

- Two Vitest projects: backend (`vitest.config.ts`, node, `src/**/*.test.ts`) and web (`web/vitest.config.ts`, jsdom). Backend thresholds enforced: **lines/statements 100, functions 99, branches 90** (with a documented exclude list).
- Shared harnesses: `createTestDb()` (fresh `:memory:`, full schema + migrations re-run from 0) and `MockEmbeddingProvider` (deterministic 384-dim hashed vectors, no download). API tests boot the real Express app via `buildApp` on an ephemeral port with raw `node:http`. Rerankers/NLI use injected stubs.
- **TDD throughout** — red → green, full suite is the gate. Every test file opens with a JSDoc tying it to a phase/pillar/bug-ID.
- **Untested surfaces to be careful around:** the MCP dispatch path (`createServer`/`instrument`/41-tool registration/`memory_delete` `innerType()` reconstruction) is exercised only by `smoke`, not unit tests — a dropped/renamed tool passes CI. The `extract-entities` handler, `graphCache` namespace isolation, and the search-log writer→reader contract are thin/incidental.

## 3. Roadmap — shipped vs remaining

The R0–R8 "revolutionary roadmap" is **partially shipped** — not a clean BUILT/UNBUILT split. Current truth:

| R | Feature | Status |
|---|---|---|
| R0 | Reproducible local benchmark harness | ✅ Shipped (`npm run bench`, `docs/BENCHMARKS.md`) |
| R1 | Bi-temporal memory | ◑ **Validity shipped** (valid_from/valid_to/tx_expired, invalidate-don't-delete, `as_of` validity queries, `memory_history`). **Remaining:** `as_of` *content* reconstruction (returns current content for historical instants). |
| R2 | Self-weaving graph + Personalized PageRank | ✅ Shipped (IDF-weighted edges, wikilinks→typed edges, PageRank fused into hybrid) |
| R3 | Self-correcting NLI write-gate | ✅ Shipped (runs on **every** store on the near-dup shortlist; real DeBERTa verified; contradiction → bi-temporal invalidate) |
| R4 | Local cross-encoder reranker | ✅ Shipped (ms-marco-MiniLM-L-6-v2; **default ON at MCP** over top-50) |
| R5 | Two-way Obsidian + typed Canvas | ◑ **One-way shipped** (`vault_sync` in, `export_vault`/`canvas` out). **Remaining:** chokidar live watcher + directional typed edges (`depends-on`/`supersedes`). |
| R6 | Pinned core-memory tier | ◑ **Tools shipped** (`core_memory_*`, `memory_tiers`). **Remaining:** auto-loading the pinned tier into context at SessionStart. |
| R7 | GDPR-grade compliance layer | ◑ **Forget shipped** (`memory_forget` soft/hard + export-on-hard). **Remaining:** consent tags, retention windows, verifiable RTBF, exportable access trail. |
| R8 | Pluggable embeddings + adaptive router | ◯ **Unbuilt** (model swappable via `MCP_MEMORY_MODEL`, but no Matryoshka/bge-m3/Ollama router or per-query route selection). |

## 4. Current open items (honest)

Two fix waves are CLOSED — **do not treat them as open**:
- The original **9-bug battle queue** (embedding cache key collision, getReadOnlyDb migrate, export resurrects dead rows, stats/manifest dead rows, update raw re-embed, NLI-only-on-supersede, vec0 survives invalidation, consolidate `results_count`, extract-dedup threshold), retired into single-source modules.
- The **battle-overhaul pass** (8-persona hands-on testing → 5 fixes, TDD, 1000 tests green): (1) `expires_at` TTL ISO-Z collation across search/stats/consolidate/expired-delete/session-start + `condensed_at`/`superseded_at` writes — expired rows had leaked into search; (2) `vault_status` raw-mtime compare (was "changed" forever on sub-ms FS); (3) `importance_score` settable on store/update; (4) `memory_graph` false strength comment + `idf_strength` surfaced; (5) vault round-trip recovers `importance_score`/`created_at`/`updated_at` from frontmatter.

Genuinely **open** (verified by the persona pass unless noted):
- **`as_of` vector reconstruction of superseded facts** — `search_mode:'vector'` returns nothing for retired facts (vec row dropped on invalidate; candidate set built from indexes before the as_of predicate). keyword/hybrid work. Fix needs keeping the vec row (and auditing every raw `MATCH` consumer re-filters) or unioning a bitemporal scan when `as_of` is set. **Highest-value remaining bug** (core bitemporal differentiator).
- **`entity_aliases` is write-only** — no tool resolves aliases to entities; the read/resolution half (LEFT JOIN in `handleGraph` + search) was never wired.
- **`memory_consolidate` `dry_run` under-counts merges** — apply mutates the index mid-pass; a faithful preview must simulate against a copy.
- **Soft-forget has no un-tombstone tool** — `memory_forget {hard:false}` is recoverable only via direct DB access.
- **Flaky test:** `src/__tests__/search/forgetting.test.ts` — timing-sensitive in the full parallel run.
- **O(n) scale hotspots:** brute-force sqlite-vec KNN on every store (×2) and search. Matters only at low-millions; ANN/HNSW is the fix.
- **Timestamp-collation residual:** rows written space-format before the ISO-Z fixes stay vulnerable until re-edited; no normalizing migration exists.
- **Minors:** `session_note`/`core_memory_append` unbounded growth; no `.max()` on search query; `init --project` ≠ `--scope project`; `legal` chunker not clause-aware; `vault_sync` doesn't strip a leading H1; content round-trip gains a trailing newline.
- **REST `/api/search` rerank off by default** → dashboard lower precision than MCP; a REST opt-in param is the candidate fix.
- **No top-level MCP server `instructions` field** — `createServer()` sets only name+version. Adding `instructions` (+ tightening the 41 tool descriptions) would help **every** MCP client. Highest-leverage "how to use this" investment.
- **Structure debt:** `src/schemas/index.ts` + `src/db/repository.ts` splits deferred (churns 100+ test imports).

## 5. Competitive positioning

vs mem0 / Zep / Letta / Cognee / Supermemory — what this server does that they don't:
- **100% local-first, single SQLite file, zero telemetry, $0/token** — no cloud rival guarantees data never leaves the machine. The core moat.
- **Hybrid vector + FTS5/BM25 RRF in one local engine** — no Neo4j/FalkorDB/Modal stack to run.
- **Obsidian round-trip + JSON Canvas + REST + dashboard in one process.**
- **Enterprise governance** (scopes/departments/access_level/GDPR forget/attribution) beyond native ChatGPT/Claude memory.
- **Cross-model** — any MCP client.

Honest weaknesses: weaker 384-dim MiniLM base (mid-pack precision; rerank closes some gap), O(n) scale ceiling (~low-millions), heuristic regex extraction (lower recall than LLM extraction), small published gold set (24 rows / 16 queries — credibility caveat). The pitch is **$0/token + 0% cloud exposure**, not top-of-leaderboard accuracy.

## 6. Doc drift to fix (when touching docs)

- **README** says "37 tools" (and "17" in older sections) — actual is **41**. The verify line "17 tools" is stale.
- **`docs/ENV.md`** omits env vars the code reads: `MCP_API_NAMESPACE`, `MCP_TRUSTED_IP_HEADER`, `MCP_VAULT_PATH`, `MCP_VAULT_WRITE_THROUGH`, `MCP_PUBLISH_RATELIMIT_CAPACITY`/`_REFILL_PER_SEC`.
- **`docs/openapi.yaml`** does not define the `/publish` wiki routes (they exist in `src/api/routes.ts` + `src/publish/wiki.ts`).
- **`CONTRIBUTING.md`** cites coverage thresholds 75/75/70; actual enforced is 100/100/99/90.
- **`docs/RUNBOOK.md`** shows `schema_version|4` as expected `schema_meta` output (~line 122) — stale; `CURRENT_SCHEMA_VERSION=9`.
- **Config dead key:** `storage.db_path` — `db/connection.ts` reads `MCP_MEMORY_DB_PATH` env, not the config key.
- Web pins Vitest `^4`, backend `^3` (version skew).
