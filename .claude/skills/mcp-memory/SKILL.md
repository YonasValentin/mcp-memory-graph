---
name: mcp-memory
description: Expert operation AND development of mcp-memory-server — a local-first, bi-temporal, knowledge-graph memory server for Claude Code (41 MCP tools over one SQLite file + local embeddings; $0/token, no cloud, no telemetry). Use when (1) DRIVING the memory tools in any project wired to the server — storing/recalling/searching memories, choosing among the 41 memory_*/vault_*/core_memory_* tools, setting up auto-capture hooks, running a team git-vault sync, GDPR forget, the dream-cycle consolidate, or debugging why a memory is not found (scope/privacy/rerank surprises); or (2) DEVELOPING the server itself inside the mcp-memory-server repo — its architecture, where to change code, the build/test/bench/smoke commands, verified gotchas and tech debt, or the REST/Docker/MS-01 deploy. Triggers include any use of mcp__*memory*__ tools, "remember this"/"recall that", "store a decision", Obsidian vault sync, core memory, knowledge graph of memories, or work inside the mcp-memory-server codebase.
---

# mcp-memory

A local-first memory server for coding agents: durable, queryable, cross-session memory with **no cloud dependency**. Embeddings, vector index, full-text index, and a knowledge graph all run in-process against one SQLite file. **41 MCP tools**; 10 also exposed over a bearer-authed REST API + a dashboard. The DB is a rebuildable cache — the source of truth can be a git-shared Obsidian vault of plain `.md` files ("Bruno model").

## First: are you USING or DEVELOPING?

- **Using** (driving the memory tools, in any project) → §"Driver quick start" below, then `references/tool-catalog.md` + `references/workflows.md`.
- **Developing** (changing the server, inside the repo) → `references/architecture.md` + `references/developing.md`.
- Either way, **`references/gotchas.md`** lists the sharp edges that cost an hour each — skim it.

## Driver quick start

The everyday loop is two tools:

```
memory_store  { title: "<short label>", content: "<one discrete fact/decision/pattern/fix>", document_type: "decision", tags: [...] }
memory_search { query: "<what you want back, in meaning not keywords>" }
```

Five things to internalize before driving:

1. **Pick the right write.** Discrete fact → `memory_store`. Large document → `memory_ingest` (auto-chunks). Running session log → `memory_session_note`. Structured note → `memory_template` then store. **Pass a `title`** — it's optional and defaults to `null`, so an omitted title leaves every search hit titleless (a column of blanks on your first corpus).
2. **Pick the right read.** Recall by meaning → `memory_search`. Token-budgeted context for a question → `memory_query` (returns the relevant memory CONTENTS rendered into a block with `## <id>` headers + hop annotations — NOT a synthesized sentence; on a corpus with no graph links yet it's a flat list of seed memories). Exact filter → `memory_query_structured` (top-level memories only — ingested child chunks are excluded). Discover what exists → `memory_manifest`.
3. **Scope + privacy.** scope ∈ global|project|user|team|department; namespace defaults to the project dir *when set by the MCP client/hooks* (calling a handler directly defaults scope=`global`, namespace=`null`). **An unscoped `memory_search` hides `scope='user'` memories** — the #1 reason a memory "isn't found". Re-search with explicit `scope:'user'`.
4. **Rerank divergence.** `memory_search` over MCP defaults `rerank:true` (best precision, +~90ms Apple Silicon / ~200ms slower CPUs). REST `/api/search` **and a direct `handleSearch` call (what the `sim-*.mjs` templates do)** leave it OFF (faster, lower precision) — pass `rerank:true` there to match real MCP precision, or `rerank:false` over MCP to trade precision for speed.
5. **Delete vs forget.** `memory_delete` is a hard delete. For anything recoverable or governed, use `memory_forget` (soft tombstone, or hard-with-export-first).

Full per-tool when-to-use + params: **`references/tool-catalog.md`**.

## Top gotchas (full list in references/gotchas.md)

- **Privacy default** hides `scope='user'` from unscoped search.
- **`as_of` reconstructs validity, not content** — returns current content for historical instants.
- **The RRF `score` is not a confidence** (~0.02 artifact) — use `confidence`/`confidence_label`.
- **Team vault needs `memory vault-init`** (writes `.gitattributes` for union merge) — `memory_export_vault` alone does not.
- **Vault `.md` round-trip resets `confidence`/`access`/`stability`** — not a full-fidelity backup; use `memory_export` JSON for that.
- **Scale is O(n) brute-force KNN** — sub-second to ~50K, crosses 1s in low-millions; no ANN.

## Common requests → tools

| User says | Reach for |
|---|---|
| "Remember / store this decision" | `memory_store` (or `memory_template`→store) |
| "What do we know about X?" / "Recall…" | `memory_search` (add `use_graph:true` for multi-hop) |
| "Answer X from memory, concisely" | `memory_query` |
| "Ingest this doc/contract/spec" | `memory_ingest` |
| "Sync my Obsidian vault" | `vault_sync` (in) / `memory_export_vault` (out) / `memory_canvas` (board) |
| "Set up automatic memory capture" | `memory init` (registers hooks) — see workflows.md |
| "Clean up / dedup memories" | `memory_consolidate` (`dry_run:true` first) |
| "Forget this (GDPR)" | `memory_forget` |
| "What should I verify/learn next?" | `memory_questions` |
| "What are the main themes?" | `memory_communities` |

## Reference map

| File | Read when |
|---|---|
| `references/tool-catalog.md` | Choosing among the 41 tools; per-tool when-to-use + key params (param *schemas* are authoritative at call time) |
| `references/workflows.md` | Scope/privacy model, solo capture↔recall, team git-vault, hooks setup, maintenance, ingest, attribution |
| `references/gotchas.md` | Before debugging "missing memory", surprising ordering, vault loss, or any write/edit surprise |
| `references/architecture.md` | Developing — the six models, layers/key files, data model (schema v9), store/search lifecycles |
| `references/developing.md` | Developing — build/test/bench/sim commands, roadmap shipped-vs-remaining, current open items, competitive positioning, doc drift |
| `references/rest-and-ops.md` | Serving over HTTP — REST contract, auth/rate-limit, Docker/MS-01 deploy, backup/restore |

The exhaustive in-repo reference is `/.planning/CODEBASE-MAP.md` (642 lines). Keep this skill's facts in sync with the server when behavior changes — the count is **41 tools** (README's "37"/"17" are stale).

> **Security:** never echo, log, or commit a bearer token or homelab credential. REST/ops examples use the `$MCP_AUTH_TOKEN` placeholder — keep it that way.
