---
name: mcp-memory-graph
description: >-
  Drive the mcp-memory-graph MCP server like an expert: store, recall, and reconcile
  durable knowledge across sessions over 49 local tools ($0/token, one SQLite file).
  Use when ANY memory tool is in play (mcp__*memory*__), when the user says "remember
  this" / "recall that" / "store a decision", when a memory seems missing (scope, privacy,
  or rerank surprise), for Obsidian vault sync, core memory, the dream-cycle consolidate,
  GDPR forget, a team git-vault, or when asked to "set up / configure the memory server".
---

# mcp-memory-graph — driving the memory server

A local-first, bi-temporal knowledge-graph memory for your AI assistant. Everything (embeddings,
vector + keyword index, graph) runs on this machine against one SQLite file. No cloud, no API key,
no per-token cost. You operate it by calling its tools well. **Full tool reference →
`references/tools.md`; CLI → `references/cli.md`; config/env/scopes → `references/config.md`;
advanced (RBAC, webhooks, multi-tenancy, reranker/consolidate tuning) → `references/advanced.md`.**

## Tool-selection decision tree

**WRITE — pick by shape of what you're saving:**
- One discrete fact / decision / pattern → `memory_store` (ALWAYS pass a `title`).
- A large document (contract, doc, transcript) → `memory_ingest` (auto-chunks by `content_type`).
- A running "what happened this session" log → `memory_session_note` (appends to one daily note).
- A small fact the agent must keep in-context every turn → `core_memory_append` (pinned block).

**READ — pick by what you want back:**
- Recall by meaning, ranked list → `memory_search` (hybrid; rerank ON for MCP).
- A token-budgeted *answer* to a question (not a list) → `memory_query`.
- Exact metadata match, no ranking (e.g. all `department:legal` `document_type:contract`) → `memory_query_structured`.
- Discover *what exists* without reading content → `memory_manifest`.
- Multi-hop / associative ("what depends on X?") → `memory_graph`, or `use_graph:true` on `memory_search`.

**DELETE — default to recoverable:**
- `memory_forget` (soft tombstone, GDPR-aware, still visible via `as_of`) — use this normally.
- `memory_delete` (hard, irreversible) — only when truly purging.

## Gotchas (load-bearing — these are the "why didn't it work" traps)

- An **unscoped `memory_search` HIDES `scope:"user"` memories**. If a personal memory seems missing, re-search with `scope:"user"`.
- **Reranking defaults ON for MCP clients** (~230 ms, big precision win). Add `use_graph:true` for multi-hop/associative recall.
- **Always pass a `title` to `memory_store`** — it drives manifest, recall, and dedup.
- **Write gate `on_conflict`** = `add` | `supersede` | `skip`. Use `supersede` so new facts reconcile instead of piling up duplicates.
- Run `memory_consolidate` with **`dry_run:true` FIRST**, inspect the report, then run for real.
- **Model-identity lock:** changing `MCP_MEMORY_MODEL` needs a rebuild/re-embed (same dimensions ≠ same vector space). The DB fails loudly if you swap without rebuilding.
- `as_of:<timestamp>` gives **point-in-time recall** (bi-temporal) — the graph as it stood then.
- **Scopes** = `global` | `project` | `user` | `team` | `department`; `namespace` groups within a scope.

## Core workflows

- **Store a decision:** `memory_store` with `title`, the decision + rationale in `content`, `document_type:"decision"`, relevant `tags`, and `on_conflict:"supersede"` if it replaces an old call.
- **Recall before answering:** before answering about architecture/decisions/patterns/past fixes, call `memory_search` first (rerank ON). If nothing and it could be personal, retry with `scope:"user"`. For a synthesized answer use `memory_query`.
- **Ingest a doc:** `memory_ingest` with `content`, a `title`, and `content_type` (`markdown`/`code`/`legal`/`text`); it chunks and links children to the parent automatically.
- **Team git-vault sync:** export to Markdown and share via git — `npx mcp-memory-graph vault-init` once per clone (registers the union merge driver), then `git pull && npx mcp-memory-graph rebuild` after pulls. See `references/cli.md`.
- **GDPR forget:** `memory_forget` (recoverable). For an erase-after-export use `memory_forget` with `hard:true` (returns a portability export, then permanently erases).

## Setup walkthrough (when asked to set up / configure the server)

`init` under a non-interactive agent shell applies defaults and prints a report instead of prompting,
so **ASK the user the choices first, then run `init` with matching flags.** Ask:

1. **Scope** — all projects (`--scope user`, default) or this project only (`--scope project`)?
2. **Hooks** — install the auto-capture/recall Claude Code hooks? (skip with `--no-skill`-adjacent flags / decline init)
3. **Session review** — let the Stop hook spawn `claude -p` to extract learnings? If no → `--no-review-on-stop`.
4. **Consolidation time** — nightly dream-cycle clock → `--schedule HH:MM`.
5. **Obsidian vault** (optional) — a vault path to sync → `--vault <path>`.

Then run, e.g.:
```bash
npx mcp-memory-graph init --scope project --schedule 03:30 --vault ~/Documents/vault --no-review-on-stop
# all defaults, no prompts:
npx mcp-memory-graph init --yes
# point at a shared self-hosted server instead of a local file:
npx mcp-memory-graph init --remote https://memory.example.com --token-env MEMORY_MCP_TOKEN
```
`--no-skill` skips writing this skill; `--yes`/`-y` accepts all defaults non-interactively.
