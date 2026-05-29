# Handoff — mcp-memory-server "Revolution" (resume here)

Date: 2026-05-29. Repo: `/Users/yonasvalentin/Projekter/mcp-memory-server`. Version: **2.0.0**.

## TL;DR

The **backend/MCP/API is built, tested (710 tests, 100% line/statement coverage), and merged to `main`** (local, NOT pushed). It implements an 8-pillar local-first **bi-temporal knowledge-graph memory vault**. The **web UI is still v1 — it does NOT expose any new feature.** Nothing is deployed; the GitHub remote is stale. Next session's biggest job: **build the web UI for the new platform**, then live-MCP/real-model verification, then deploy/push.

Read these first: `.planning/REVOLUTION-SPEC.md` (the 8-pillar contract), `.planning/research/00-SYNTHESIS.md` + `01..06` (why/what, incl. the battle-test report `06`), this file.

## Git state

- Branch `feat/revolution-pillars` merged into `main` via `--no-ff` (merge commit `c43ba49`). Both branches local.
- ~40 commits this effort. Pillar 1 (6 slices) was committed directly on `main` before the branch; Pillars 2–8 + finalization on the branch.
- **NOT pushed.** GitHub `origin/main` is still the old stale state. Working tree clean.
- To see the work: `git log --oneline main` (top ~46 commits).

## How it was built (follow this method to continue)

superpowers **subagent-driven-development**: per vertical slice → dispatch an implementer subagent (general-purpose) with full context + strict TDD (RED→GREEN, commit when green) → then a combined **spec-compliance + code-quality review** subagent (superpowers:code-reviewer) → fix Critical/Important findings via SendMessage to the same implementer → mark done. Reviews caught real bugs every pillar — do NOT skip them. Tasks tracked in `.planning/PILLAR-TASKS.md` (all 26 build tasks marked conceptually done; backlog doc may be stale — git log is the source of truth).

## What's DONE (verified: build clean, 710 tests, integration + live-server smoke)

Schema migrated **v4 → v9**. 37 MCP tools. All new behavior is **additive / opt-in — default paths are byte-identical to v1** (this is why existing tests stayed green; preserve this property).

- **Pillar 1 — graph spine** (`src/graph/memory-links.ts`, `similarity-edges.ts`, entity-store co-occurrence, `vault/sync.ts` wikilink resolution): persistent `memory_links` edge store, confidence-tagged (EXTRACTED/INFERRED/AMBIGUOUS), three signals — wikilink (vault) + entity co-occurrence (store) + vector similarity ("unlinked mentions"). Surfaced in `memory_get` (links+backlinks) and `/api/graph`. **Fixed the original F1 bug** (graph had nodes, no edges).
- **Pillar 2 — bi-temporal** (`db/schema.ts` v6 cols `valid_from/valid_to/tx_expired`, `search/hybrid.ts`, `repository.ts` `invalidateMemory`): currently-valid default filter, `as_of` point-in-time, invalidate-don't-delete.
- **Pillar 3 — retrieval** (`graph/pagerank.ts`, `search/reranker.ts`, `search/contextual.ts`, `graph/graph-query.ts`): HippoRAG Personalized PageRank fused into RRF (`use_graph` opt-in), local cross-encoder rerank (`rerank` opt-in), contextual indexing (deterministic prefix at embed time — applied in store AND ingest/vault), `memory_query` token-budgeted hub-avoiding traversal.
- **Pillar 4 — self-correcting writes** (`graph/write-gate.ts`, `graph/contradiction.ts`, `search/temporal.ts`): ADD/UPDATE/DELETE/NOOP gate (`on_conflict` opt-in), local NLI contradiction → bi-temporal invalidation (opt-in, pluggable), forgetting-curve `stability` (schema v7) — opt-in decay type `'forgetting'` + opt-in consolidate `forgetting_floor`.
- **Pillar 5 — agent-OS** (`tools/core-memory.ts` schema v8, `search/tiers.ts`, `tools/reflect.ts`, `graph/communities.ts`): pinned `core_memory` block + self-edit tools, hot/recall/archival `memory_tiers`, `memory_reflect` (agent-driven, no LLM in server), GraphRAG `memory_communities` (label propagation, on-demand).
- **Pillar 6 — Obsidian-grade vault** (`vault/writer.ts`, `vault/canvas.ts`, `publish/wiki.ts`, `tools/templates.ts`+`session-note.ts`): bidirectional `.md` write-back (`memory_export_vault`, path-confined), JSON Canvas export (`memory_canvas`), **read-only `/publish` wiki** (unauthenticated by design, access-level gated, XSS-escaped + CSP), session notes + per-document_type templates.
- **Pillar 7 — team+solo** (`cli/init-wizard.ts`, `graph/graph-export.ts`, `cli/share.ts`, `tools/attribution.ts` schema v9): **interactive `memory init` wizard** (solo/team, scope, storage, sharing, capture — pure `buildConfig` + injectable `Prompter`), committable graph artifact (`export-graph`) + **git union merge driver** (`git-setup`, `merge-graphs` — deterministic order-independent union), `agent_id` attribution (`memory_attribution`, env `MCP_AGENT_ID`).
- **Pillar 8 — trust** (`tools/questions.ts`, `tools/forget.ts`+`history.ts`, `lib/sanitize.ts`, `lib/hot-reload.ts`): `memory_questions` digest (verify/gap/orphan), GDPR `memory_forget` (soft tombstone / hard export-before-erase) + `memory_history`, output sanitization at the single `formatResult` chokepoint (ANSI/control/DEL/DCS/BiDi-Trojan-Source), hot-reload gate busts stale `/api/graph` cache.

New env vars (see `docs/ENV.md`): `MCP_AGENT_ID`, `MCP_PUBLISH_ACCESS_LEVELS`, `MCP_MEMORY_NLI_MODEL`, `MCP_MEMORY_RERANKER_MODEL`, `MCP_CSP_DISABLED`, `MCP_HSTS_*`, `MCP_CSP_EXTRA_CONNECT`.
New CLI (see `src/index.ts`): `init` (wizard), `export-graph`, `merge-graphs`, `git-setup`.

## What's NOT done (the honest gaps — next session's work)

1. **WEB UI — biggest gap.** `web/` React app builds clean but `web/src/api/client.ts` calls only `/api/*` (v1). The 5 pages (Dashboard, Search, Browse, MemoryDetail, KnowledgeGraph) expose ZERO new features. Only passive win: `KnowledgeGraph.tsx` now shows real `/api/graph` edges (not visually tested). **Build UI for:** bi-temporal time-travel (`as_of` slider), graph traversal (`memory_query`)/communities/tiers/reflect views, core-memory editor, canvas-export + vault-export buttons, a real publish-wiki browser (currently only raw server-rendered HTML at `/publish/:ns`), GDPR forget/history panel, write-gate (`on_conflict`)/`rerank`/`use_graph` toggles, attribution + questions dashboards. NOTE: most new tools are MCP-only — they likely need **new REST endpoints in `src/api/routes.ts`** before the React UI can call them (only memory_search/list/get/related/versions/stats/graph + PATCH/DELETE are REST-exposed today; the publish routes exist). Add REST wrappers for the new read tools first, then build UI.
2. **No live MCP-client verification.** Tools are unit + HTTP-smoke tested, never exercised through Claude Code over the MCP transport (stdio/HTTP). Wire it into a Claude Code MCP config and round-trip the new tools.
3. **NLI + cross-encoder reranker never run with a real model.** Stub-tested only (hermetic by design; models download on first real use). Run `memory_search rerank:true` and the NLI contradiction path with `MCP_MEMORY_RERANKER_MODEL`/`MCP_MEMORY_NLI_MODEL` loaded; confirm latency + behavior.
4. **Real-embedder corpus behavior.** Most tests use `MockEmbeddingProvider` (deterministic hash → near-orthogonal vectors, so similarity edges + semantic dedup are ~no-ops under mock — that's why an integration run shows `memoryLinks: 0`; this is a test artifact, NOT a bug; wikilinks + real-embedder similarity populate them). Validate similarity edges + contradiction + consolidate dedup with the real `Xenova/all-MiniLM-L6-v2`.
5. **Not deployed / not pushed.** MS-01 deploy (it runs at `mcp.yonasvalentin.dk`, port 3200 — see global CLAUDE.md) and `git push` are pending the user's go-ahead. User explicitly chose **keep-local, no-push** earlier — confirm before pushing.
6. **Minor review nits deferred** (non-blocking, noted in reviews): `reranker.ts` extractScore could be factored out of the c8-ignore; `init.ts` `resolveWizardConfigPath` guard is a tautology; `by_author` in attribution has no 'unattributed' bucket; assorted doc/test polish. Search commits/reviews if you want the list.

## Conventions + gotchas (READ before editing)

- **TDD always** (superpowers:test-driven-development): write the failing test, see it fail, minimal code to green, commit. The reviews enforce this.
- **Schema changes = dual-definition pattern.** New column/table goes in BOTH `initializeSchema` (fresh-DB block, `src/db/schema.ts`) AND a new `migration{version:N}` (`src/db/migrations.ts`), then bump `CURRENT_SCHEMA_VERSION`. Shared DDL constants (e.g. `MEMORY_LINKS_DDL`, `CORE_MEMORY_DDL`) are reused across both. **Do NOT add new columns to `V4_MEMORY_COLUMNS`** (that list is the v4 floor checked before migrations run; adding to it breaks legacy-DB upgrades). Tests assert `String(CURRENT_SCHEMA_VERSION)` dynamically — never hardcode the version number.
- **Coverage gate is strict** (`vitest.config.ts`: 100% lines/statements, 99% functions, 90% branches). Keep it green. c8-ignore ONLY genuinely-untestable IO (HF model load/inference, TTY readline, git/network shell-out). Pure CLI IO wrappers are in the `coverage.exclude` list — follow that precedent, don't exclude files with testable logic.
- **Additive/opt-in invariant.** Every new behavior defaults OFF or no-ops without context so v1 behavior is byte-identical. `contextualizeForEmbedding` returns content unchanged when no title/type/namespace — this is what keeps embeddings stable. Preserve this.
- **Output sanitization chokepoint** = `formatResult` in `src/server.ts` (calls `sanitizeDeep`). All tool output flows through it. Sanitize at OUTPUT only — stored content stays raw.
- **Path safety**: any feature writing files from untrusted memory titles MUST use `confineToVault` (`src/vault/writer.ts`) — realpath + startsWith guard + filename sanitization.
- **Mock embedder caveat** (above): orthogonal vectors → similarity/semantic features are no-ops under mock. Test those with crafted vectors (insertMemory + controlled Float32Array) or a capturing/stub embedder, not relevance.

## Verify the current state

```bash
cd /Users/yonasvalentin/Projekter/mcp-memory-server
npm run build                 # clean tsc
npm test                      # 710 passing
npx vitest run --coverage     # gate green (100/100/99/90)
npm run build:web             # web app builds (v1 features only)
# live smoke:
MCP_MEMORY_DB_PATH=/tmp/x.db MCP_PORT=3207 node dist/index.js serve   # then curl /health, /publish/<ns>, /api/stats
# assembled-platform integration: /tmp/mcp-stress/integration.mjs (recreate from this handoff if gone)
```

## The wedge (the "why" — keep this north star)

The only **100%-local, agent-native, bi-temporal knowledge-graph memory vault**: graphify's confidence-tagged graph + Obsidian's ownership/links/canvas/publish + Zep's time-travel + mem0/HippoRAG/MemGPT retrieval — with the "**the LLM is the consuming agent over MCP**" trick so the server stays cloud-free (it does cheap local work: graph math, local embeddings, NLI-on-shortlist, decay, clustering; the agent does generative steps). Sharing = **Bruno-style git** (committable markdown + graph.json + union merge driver), not Postman SaaS. Solo and team. MIT.

## Recommended next-session order

1. **REST endpoints** in `src/api/routes.ts` for the new read tools (query/communities/tiers/questions/attribution/history/etc.) — TDD via the buildApp harness.
2. **Web UI** for the new pillars (start with the highest-wow: bi-temporal time-travel + graph traversal + communities + publish-wiki browser). Update `web/src/api/client.ts` + add pages/components; build + Playwright/webapp-testing verify.
3. **Live MCP client** round-trip + **real-model** (NLI/reranker/embedder) verification.
4. **Deploy** to MS-01 + **push** (confirm with user first — they chose keep-local).
