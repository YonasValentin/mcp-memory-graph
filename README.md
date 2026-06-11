# MCP Memory Graph

[![npm version](https://img.shields.io/npm/v/mcp-memory-graph?logo=npm&color=cb3837)](https://www.npmjs.com/package/mcp-memory-graph)
[![npm downloads](https://img.shields.io/npm/dm/mcp-memory-graph?color=cb3837)](https://www.npmjs.com/package/mcp-memory-graph)
[![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-1f6feb.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](./package.json)
[![MCP server](https://img.shields.io/badge/MCP-server-111111)](https://modelcontextprotocol.io/)
[![Built for Claude Code](https://img.shields.io/badge/built%20for-Claude%20Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)
[![Local-first · $0/token](https://img.shields.io/badge/local--first-%240%2Ftoken-2ea043)](#why-this-exists)

A memory server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and any other [MCP](https://modelcontextprotocol.io/) client. It gives your AI assistant a permanent, searchable memory that lives in one SQLite file on your machine. Store a decision today, ask about it next month, and the answer comes back. Everything runs locally: the embedding model, the search index, the knowledge graph. No cloud account, no API key, no per-token cost.

> **License:** source-available and free for noncommercial use ([PolyForm Noncommercial 1.0.0](./LICENSE)): personal projects, hobby, study, research, charity, education, and government. Commercial use requires a paid license ([COMMERCIAL.md](./COMMERCIAL.md)).

**Who it's for:** developers who want Claude (or Cursor, Codex, any MCP client) to remember decisions across sessions. Solo builders and hobbyists use it free. Teams share a knowledge base over git. And anyone who wants to replace a cloud memory service (mem0, Zep, Letta, Supermemory) with something that runs entirely on their own machine.

## Why this exists

AI assistants forget everything between sessions. Your decisions, your patterns, the bug you fixed last Tuesday: all gone when the conversation ends. This server fixes that.

- Knowledge stored today is searchable tomorrow, next week, next year.
- Search works by meaning, not just keywords. "contract notice period" finds "90-day renewal clause".
- It improves itself. It tracks what gets used, scores quality, extracts learnings from your sessions, and cleans itself up on a schedule.
- It stays private. Local embeddings, no cloud APIs, no telemetry. The one exception is the optional Stop hook, which sends your session transcript to your own locally installed Claude Code (`claude -p`) for learning extraction. You can turn that off with `review_on_stop: false`.
- It works for any kind of knowledge. Engineers store architecture decisions, lawyers store contract patterns, accountants store audit procedures.

## Quick start (about 5 minutes)

You need Node.js 20 or newer and Claude Code installed.

**1. Get the server.** From npm (easiest):

```bash
npm install -g mcp-memory-graph
```

Or from source:

```bash
git clone https://github.com/YonasValentin/mcp-memory-graph.git
cd mcp-memory-graph
npm install
npm run build
```

**2. Register the server with Claude Code:**

```bash
# npm install:
claude mcp add memory-server -- npx -y mcp-memory-graph

# from source:
claude mcp add memory-server node /path/to/mcp-memory-graph/dist/index.js
```

**3. Install the hooks (recommended):**

```bash
npx mcp-memory-graph init
```

This wires up automatic capture and recall: a status line when a session starts, search tracking, and an end-of-session review that stores what you learned. It also schedules a nightly cleanup. Answer the prompts, or pass `--yes` to accept the defaults.

**4. Try it.** Open a Claude Code session and say:

```
Remember this: we use Postgres for the main app database. Decided 2026-06-01,
because we need JSONB and full-text search in one place.
```

Then, in a later session:

```
What database did we decide to use, and why?
```

Claude searches its memory and answers with the stored decision. That's the whole loop.

**5. Verify the install.** Ask Claude:

```
What memory tools do you have available?
```

It should list all 49 tools (43 `memory_*`, 3 `vault_*`, 3 `core_memory_*`).

The first time a memory tool runs, the embedding model (about 30 MB) downloads from HuggingFace and is cached at `~/.cache/huggingface/`. Every start after that is instant.

To undo everything: `npx mcp-memory-graph uninstall`.

## How it works, in plain terms

When you store a memory, the server turns the text into a vector (a list of 384 numbers that captures its meaning) using a small model that runs inside Node.js. It also indexes the text for keyword search. Both live in one SQLite file, by default at `~/.mcp-memory/memory.db`.

When you search, the server runs both kinds of search at once, merges the rankings, and returns the best matches with a confidence label. A second model can then re-sort the top results for better precision (this is the reranker, on by default for MCP clients, and it costs about 200 ms).

On top of that sits a knowledge graph: memories link to entities and to each other, so the server can answer questions that need more than one hop, like "what does the payment service depend on?". A nightly "dream cycle" deduplicates, re-scores, prunes, and reports gaps.

## The benchmarks, and how to read them

Every number below was produced locally: real embedding model, real production handlers, no network. You can rerun all of them on your own machine.

A quick primer if benchmarks are new to you. A *gold set* is a list of questions where the right answer is known in advance. *Precision@1* asks: was the top result the right one? *Recall@5* asks: was the right answer anywhere in the top 5? *MRR* (mean reciprocal rank) rewards putting the right answer near the top. The *reranker* is a second model that re-sorts the top 50 results; it is slower but noticeably more accurate.

### Local gold set

| | precision@1 | precision@3 | MRR | search p95 |
|---|---|---|---|---|
| Hybrid (RRF) | 0.563 | 0.750 | 0.704 | ~4 ms |
| **+ cross-encoder rerank** (MCP default) | **0.813** | **0.875** | **0.867** | ~230 ms |

Reproduce with `npm run bench`. Full methodology, the gold set itself, and every miss are printed and documented in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

### Scale

With the real embedder and a file-backed SQLite database, retrieval p95 is 9.1 ms at 10,000 vectors and 30 ms at 50,000. The rerank pass adds a roughly constant 200 ms on top. Most memory products publish self-reported, cloud-hosted numbers; these are measured locally and reproducible from a committed corpus and runner.

### Public benchmarks

Four public memory benchmarks, run untuned (stock MiniLM embedder, production handlers, zero benchmark-specific tweaks), matching or beating MemPalace on all four:

| Benchmark | Our result | Comparison |
|---|---|---|
| [LongMemEval-S](https://github.com/xiaowu0162/LongMemEval) | R@5 = 97.8% | vs 96.6% published |
| [ConvoMem](https://huggingface.co/datasets/Salesforce/ConvoMem) | R@10 = 93.5% | vs 92.9% |
| [LOCOMO](https://github.com/snap-research/locomo) | session R@10 = 82.2%, R@50 = 100% | vs 60.3% baseline |
| [MemBench](https://github.com/import-myself/Membench) | hit@5 = 78.7% | vs their 80.3% *tuned* |

Run them yourself: `npm run bench:longmemeval`, `bench:locomo`, `bench:convomem`, `bench:membench`. The honest notes (where the reranker helps and where it hurts, the dedup floor on MemBench, gold-set size caveats) are in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

## Features

### Core

- **49 MCP tools**: CRUD and retrieval, a confidence-tagged knowledge graph, a self-correcting write gate, signed provenance and verification, an event bus with SSRF-guarded webhooks, change propagation and advisor surfaces, resumable session state, expertise profiles, memory tiers, Obsidian vault round-tripping, and GDPR-grade forget and history. Full list below.
- **Hybrid search**: vector similarity (meaning) plus keyword matching (exact terms), merged with Reciprocal Rank Fusion. `rerank: true` adds the cross-encoder pass. `use_graph: true` blends in HippoRAG Personalized PageRank multi-hop scores. `as_of: <timestamp>` searches the graph as it stood at a past moment.
- **Local embeddings**: Transformers.js running all-MiniLM-L6-v2 (384 dimensions) inside Node.js. No Python, no cloud API, no GPU.
- **SQLite storage**: one file, using better-sqlite3 with two extensions: sqlite-vec for vector nearest-neighbor search, FTS5 for keyword search with BM25 ranking.
- **Structure-aware chunking**: text splits on paragraphs, markdown on headings (heading context preserved in each chunk), code on function and class boundaries, legal on sentences.
- **Scopes**: organize memories into `global`, `project`, `user`, `team`, `department`.
- **Version history**: every update saves the previous version. Full audit trail of who changed what, when.
- **Temporal decay**: optional time-based scoring that favors recent memories (exponential or linear).
- **Confidence scoring**: every result carries a 0 to 1 confidence and a plain label (high, medium, low).
- **Expiration**: time-sensitive memories can carry an expiry date and drop out of search automatically.

### Self-improvement

- **Access tracking**: every search, get, and related-memory call records which memories were touched.
- **Quality scoring**: automatic `importance_score` and `confidence_score` on every memory, from access frequency, recency, and content signals.
- **Learning extraction**: at session end, a headless `claude -p` reviews the transcript and stores zero to five curated learnings. (This replaces the older `type: "agent"` Stop hook, which is silently broken on macOS; see anthropics/claude-code#39184.)
- **Dream cycle**: scheduled or on-demand deduplication, re-scoring, pruning, expiry enforcement, and knowledge-gap detection.
- **Gap detection**: searches that return nothing are logged, so you can see what knowledge is missing.

### Claude Code hooks

Four opt-in hooks, installed by `init`:

| Hook | When it fires | What it does |
|---|---|---|
| SessionStart | session begins | Fast status check (memory count, expired, stale docs) |
| PostToolUse | after a memory search | Tracks hits and misses to `search-log.jsonl` |
| PreCompact | before context compression | Optional learning extraction (off by default) |
| Stop | session ends | Spawns headless `claude -p` to review the session and store learnings |

The Stop hook detaches in about 30 ms and reviews in the background for 10 to 60 seconds. It needs the `claude` CLI on `$PATH` (or `$CLAUDE_BIN`), authenticated. Turn it off with `review_on_stop: false` in `~/.mcp-memory/config.json`.

### Metadata on every memory

| Field | Purpose | Examples |
|-------|---------|---------|
| `scope` | Isolation level | global, project, user, team, department |
| `namespace` | Sub-scope grouping | "my-project", "legal-team", "q4-audit" |
| `department` | Organizational unit | legal, engineering, hr, sales, finance |
| `document_type` | Content classification | contract, policy, code, incident, decision, report |
| `access_level` | Data sensitivity | public, internal, confidential, restricted |
| `tags` | Flexible categorization | ["renewal", "notice-period", "compliance"] |
| `language` | Content language (ISO 639-1) | "en", "da", "de" |
| `source` | Origin | file path, URL, system name |
| `author` | Creator | person or system name |
| `metadata` | Domain-specific JSON | `{contract_type: "NDA", parties: ["A","B"]}` |
| `expires_at` | Auto-expiration date | ISO 8601 timestamp |

`scope` and `namespace` group content within one database. A shared-database `MCP_API_NAMESPACE` pin gives supported per-namespace multi-tenant isolation (schema v14); a separate database file per tenant is the strongest boundary. See [docs/MULTI-TENANCY.md](docs/MULTI-TENANCY.md).

### Knowledge graph and bi-temporal model

- **Bi-temporal validity**: every memory carries valid-time (`valid_from`, `valid_to`) alongside transaction-time. Updates invalidate rather than delete: the prior fact gets a `valid_to` stamp instead of being overwritten, so history is never lost. Reads default to currently valid rows but accept `as_of: <timestamp>` for point-in-time recall. `memory_history` returns one memory's full timeline.
- **Confidence-tagged links**: memories connect via wikilink, co-occurrence, and similarity edges, each with a confidence weight. `memory_graph` traverses entities and relationships up to 3 hops. `memory_extract_entities` stores LLM-extracted entities and relationships.
- **HippoRAG multi-hop**: `use_graph: true` on search runs Personalized PageRank over the entity and link graph for associative retrieval.
- **Token-budgeted answers**: `memory_query` answers a question with a tight subgraph. It seeds from hybrid search, walks the graph up to `max_hops` while avoiding hubs, and returns a token-budgeted context string instead of flooding the window.
- **Communities**: `memory_communities` finds densely connected entity clusters, for "what are the main themes in here?" questions.

### Self-correcting writes

- **Write gate**: stores route through an ADD, UPDATE, DELETE, or NOOP decision (`on_conflict`), so new facts reconcile with existing ones instead of piling up duplicates.
- **Contradiction detection**: a cross-encoder NLI model flags when an incoming memory contradicts something already stored.
- **Forgetting curve**: memories carry a `stability` signal, so rarely reinforced knowledge slowly sinks in ranking, the way human memory fades.

### Agent-OS memory

- **Core memory block**: a small, bounded, always-in-context note per `(scope, namespace)` that the agent maintains itself (`core_memory_get`, `core_memory_append`, `core_memory_replace`). Appends that would overflow are refused, which forces deliberate compaction.
- **Tiers**: `memory_tiers` reports a MemGPT-style hot / recall / archival distribution and lists the hot working set.
- **Reflection**: `memory_reflect` gathers the most reflection-worthy memories and, in store mode, persists synthesized insights linked back to their sources.

### Obsidian vault

- **Bidirectional sync**: `vault_sync` reads a vault in. `memory_export_vault` writes memories out as `.md` files with YAML frontmatter that round-trips losslessly for every authored field (id, scope, namespace, tags, access_level, importance, timestamps). Two derived scores are not in the frontmatter and reset on re-import: `confidence_score` (to 0.6) and `stability` (to 1.0). Use `memory_export` (JSON) for a byte-perfect backup. One metadata key is reserved: `metadata._vault` holds internal sync bookkeeping and never appears in tool output or exported files.
- **JSON Canvas**: `memory_canvas` exports the graph as a JSON Canvas 1.0 `.canvas` file that opens as a spatial board in Obsidian.
- **Read-only wiki**: `serve` exposes `/publish/:namespace` (index, page, search, graph) as a read-only wiki. It is deliberately not behind bearer auth, but is hard-scoped to published access levels (`MCP_PUBLISH_ACCESS_LEVELS`, default `public`).
- **Session notes and templates**: `memory_session_note` appends to one "daily note" per session. `memory_template` returns structured note scaffolds per document type.

### Team and solo sharing (git)

- **`memory init` wizard**: interactive setup (or `--yes` for defaults) that writes `~/.mcp-memory/config.json` (or project-scoped config) plus the Claude Code wiring.
- **Committable graph artifact**: `memory export-graph` writes a deterministic `memory-graph.json` you can commit and share. `memory git-setup` installs a `.gitattributes` entry and the `memory-union` merge driver so parallel commits merge instead of conflict.
- **Attribution**: set `MCP_AGENT_ID` (or pass `agent_id` per store) and `memory_attribution` reports how many valid memories each agent wrote.

### Trust and governance

- **Questions to ask**: `memory_questions` surfaces what the graph is well placed to find: ambiguous links to confirm, frequently mentioned but under-documented entities, orphaned and stale memories.
- **GDPR-grade forget**: `memory_forget` soft-deletes by default (a tombstone via `valid_to`, recoverable, still visible via `as_of`). With `hard: true` it returns a portability export first, then permanently erases. `memory_delete` is unchanged.
- **Output sanitization**: every tool result passes through one chokepoint that strips ANSI and VT escapes, control characters, and zero-width or BiDi Trojan-Source spoofing before it leaves the server. Stored content stays raw at rest.
- **Hot reload**: config changes apply without a restart.

## Web dashboard

The server ships a browser dashboard for viewing and managing memories outside Claude. It runs on the same Express server as the MCP HTTP transport, so there is no separate process.

Six pages:

- **Dashboard**: memory counts, content size, breakdowns by scope, department, and type, plus the 10 most recently updated memories.
- **Search**: hybrid search with confidence and match-type badges, and instant fuzzy suggestions as you type.
- **Browse**: sortable, paginated table of all memories with scope filtering and quality indicators.
- **Memory detail**: full content, metadata, version history, related memories, inline edit and delete.
- **Knowledge graph**: D3 force-directed view. Nodes sized by importance, colored by scope. Zoom, pan, drag, double-click to navigate.
- **Tools**: a console for the full tool surface. It lists every tool the server advertises, renders a form from each schema, and runs it over the authenticated MCP endpoint. Destructive tools ask for confirmation first.

Tech: React 19, Vite, Tailwind CSS v4, shadcn/ui, Fuse.js, D3, Recharts.

**Run it:**

```bash
# Development (hot reload)
npm run build && npm run serve   # Terminal 1: server on :3100
npm run dev:web                   # Terminal 2: Vite on :5173 (proxies /api to :3100)

# Production (single process)
npm run build:all                 # Builds server + frontend
npm run serve                     # http://localhost:3100 serves both API and UI
```

**Docker:** the image includes the built frontend. After `docker compose up`, the dashboard is at `http://<host>:3200` alongside the MCP endpoint. Team members can browse the shared store from any browser, no Claude Code required.

### REST API (16 endpoints)

The REST surface is for reading and managing. Creating memories goes through MCP (`memory_store` over `POST /mcp`); there is deliberately no `POST /api/memories`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/stats` | Memory counts and breakdowns |
| `GET` | `/api/search?q=...` | Hybrid search with filters |
| `GET` | `/api/memories` | List with pagination and sorting |
| `GET` | `/api/memories/:id` | Single memory with metadata |
| `GET` | `/api/memories/:id/versions` | Version history |
| `GET` | `/api/memories/:id/related` | Semantically related memories |
| `PATCH` | `/api/memories/:id` | Update content or metadata |
| `DELETE` | `/api/memories/:id` | Delete a memory |
| `GET` | `/api/graph` | Nodes and edges for graph visualization |
| `GET` | `/api/manifest` | Integrity manifest (merkle root plus per-memory hashes) |
| `GET` | `/api/insights` | Trends and themes summary |
| `GET` | `/api/health` | Knowledge-gap report (recurring zero-result searches) |
| `GET` | `/api/webhooks` | List webhook targets (gated by `MCP_WEBHOOKS`) |
| `POST` | `/api/webhooks` | Register an SSRF-validated outbound target |
| `DELETE` | `/api/webhooks/:id` | Remove a webhook target |
| `POST` | `/api/webhooks/dispatch` | Drain the durable, HMAC-signed delivery queue |

The first nine are what the dashboard uses. All REST endpoints call the same handlers as the MCP tools; no business logic is duplicated.

## Self-improvement in detail

The server tracks how knowledge is used, scores quality, learns from sessions, and consolidates itself over time.

### The learning loop

```
 ┌──────────────────────────────────────────────────────────┐
 │                    SESSION                                │
 │  Claude searches → access_count++ on matched memories     │
 │  Claude stores   → new memory with initial scores         │
 │  Zero results    → knowledge gap recorded                 │
 └─────────────┬────────────────────────────────────────────┘
               │
               ▼
 ┌──────────────────────────────────────────────────────────┐
 │            SESSION END (Stop command hook)                │
 │  Hook spawns detached `claude -p` headless review         │
 │  --allowedTools restricts to memory_store only            │
 │  Claude judges → 0-5 curated entries via memory_store     │
 │  Deduplicates against existing memories                   │
 └─────────────┬────────────────────────────────────────────┘
               │
               ▼
 ┌──────────────────────────────────────────────────────────┐
 │              DREAM CYCLE (nightly or manual)              │
 │  1. Score    : Recalculate importance from access data    │
 │  2. Expire   : Enforce expiration dates                   │
 │  3. Prune    : Remove low-quality, never-accessed items   │
 │  4. Dedup    : Merge near-duplicate memories              │
 │  5. Gaps     : Surface zero-result search patterns        │
 └──────────────────────────────────────────────────────────┘
```

### Quality scoring

Every memory gets an `importance_score` between 0 and 1:

```
importance = 0.3 * current_score + 0.4 * normalized_access_frequency + 0.3 * recency_factor
```

Recency factor:

| Age | Factor |
|-----|--------|
| < 7 days | 1.0 |
| < 30 days | 0.7 |
| < 90 days | 0.4 |
| > 90 days | 0.1 |

Memories that are never accessed gradually lose importance. Auto-extracted memories start lower and get pruned if they never prove useful.

> **Note on access reinforcement.** The formula above is the periodic recompute run by the consolidate Score stage. Each read (`memory_get`, `memory_search`, `memory_related`) also applies a small immediate boost (`importance_score += 0.03`, capped at 1.0), and search uses importance as a mild rank multiplier (`1 + importance * 0.5`). A memory read 20 or more times approaches the ceiling from reads alone, and consolidate re-baselines it on the next run. This popularity weighting is intentional. If you want a fixed value that reads don't drift, set an explicit `importance_score` on `memory_store` or `memory_update`.

### Knowledge gap detection

When a search returns nothing, the query is logged. The dream cycle's gap stage surfaces these, so you can see what's missing from the store.

## Installation reference

### Prerequisites

- **Node.js 20+**, for any client.
- **An MCP client.** [Claude Code](https://docs.anthropic.com/en/docs/claude-code) is the first-class experience; the automatic capture and recall hooks are Claude-Code-only. Other MCP clients (Codex, Cursor, and the rest) get all 49 tools but drive them manually. See "Other MCP clients" below.
- **For the Stop hook only:** the `claude` binary on `$PATH` (or `$CLAUDE_BIN`), authenticated without prompting. Optional; disable with `review_on_stop: false`.

### What `init` does

```bash
npx mcp-memory-graph init                  # user scope: hooks apply to all projects
npx mcp-memory-graph init --scope project  # this project only
```

User scope writes hooks to `~/.claude/settings.json`, so they fire in every Claude Code session. Project scope writes hooks to `.claude/settings.json` in the current directory and creates `.mcp.json` for automatic server discovery; collaborators who clone the project get the memory server registered automatically.

Init does five things:

1. Verifies the hook scripts exist in `dist/hooks/`.
2. Registers the four hooks in settings.json.
3. Creates the config file with sensible defaults: `~/.mcp-memory/config.json` (user scope) or `<project>/.mcp-memory/config.json` (project scope; the generated `.mcp.json` pins it via `MCP_MEMORY_CONFIG_PATH`).
4. Writes memory usage instructions to `.claude/CLAUDE.md` (project scope) or prints a snippet (user scope).
5. Sets up the nightly consolidation schedule (macOS: launchd; Linux: prints a cron suggestion; skipped for project scope).

### Unattended setup (CI, provisioning, agents)

Every step is scriptable. There is no interactive-only path:

```bash
git clone https://github.com/YonasValentin/mcp-memory-graph.git
cd mcp-memory-graph
npm install && npm run build
npx mcp-memory-graph init --scope project --yes   # local: hooks + .mcp.json, no prompts
# or point at a shared self-hosted server instead:
# npx mcp-memory-graph init --remote https://memory.example.com --token-env MEMORY_MCP_TOKEN
```

## Other MCP clients (Codex, Cursor, and more)

Claude Code gets the hooks; everyone else gets the same 49 tools, driven manually. The server is a standard MCP server, so any client works. A line in the client's rules file makes usage near-automatic.

Register the server. Example for Codex, in `~/.codex/config.toml` (global) or `.codex/config.toml` (project, trusted only):

```toml
[mcp_servers.memory-graph]
command = "node"
args = ["/abs/path/to/mcp-memory-graph/dist/index.js"]
tool_timeout_sec = 180   # the first call downloads the ~30 MB model once; the 60s default can be tight

[mcp_servers.memory-graph.env]
MCP_MEMORY_DB_PATH = "/abs/path/to/.mcp-memory/memory.db"

# or a shared self-hosted server over HTTP (see Self-hosting below):
# url = "https://memory.example.com/mcp"
# bearer_token_env_var = "MEMORY_MCP_TOKEN"
```

Or `codex mcp add memory-graph -- node /abs/path/to/mcp-memory-graph/dist/index.js`. Cursor, Windsurf, and other clients use their own MCP config format, but the server command (`node .../dist/index.js`) and the HTTP option are the same.

Then nudge the agent in its instructions file (Codex: `AGENTS.md`; Cursor: project rules):

> Before answering questions about architecture, decisions, patterns, or past
> fixes, call `memory_search` on the memory-graph server first; store new
> decisions, patterns, and fixes with `memory_store`.

## Self-hosting and sharing a memory base

The server runs three ways, from a single-user cache to a knowledge base shared across many machines. All three are local-first: nothing leaves the machines you choose to run it on.

### 1. Local (single user), the default

`npx mcp-memory-graph init` registers a local stdio server plus the hooks. Memory lives in one SQLite file on your machine. Nothing else to run. Right choice for solo use.

### 2. Shared server (multiple machines or a group)

Run one server that many clients connect to over HTTP. Everyone shares the same memory base, live.

Start the server (pick one):

```bash
# From source: build the server (and the dashboard, if you want it) first
npm run build:all
MCP_AUTH_TOKEN=$(openssl rand -hex 32) MCP_BIND=0.0.0.0 npm run serve
# MCP at /mcp, REST at /api, dashboard at /, all on :3100

# Or with Docker (frontend included; publishes host port 3200 by default)
MCP_AUTH_TOKEN=$(openssl rand -hex 32) docker compose up -d
```

Set `MCP_AUTH_TOKEN` whenever the server is reachable beyond loopback. It is a shared bearer token, one secret for all clients. The server refuses to start unauthenticated on a non-loopback bind unless you set `MCP_AUTH_OPTIONAL=1`. Terminate TLS at a reverse proxy or tunnel for anything off-host.

Connect a client, one command per machine:

```bash
npx mcp-memory-graph init --remote https://memory.example.com --token-env MEMORY_MCP_TOKEN
export MEMORY_MCP_TOKEN=<the server token>     # in your shell or .env
```

For Claude Code this writes a project `.mcp.json` pointing at the shared server. The token is stored as an env-var reference (`"Authorization": "Bearer ${MEMORY_MCP_TOKEN}"`), so the committed `.mcp.json` never contains the secret. Non-Claude clients point at the same server through their own MCP config.

| Flag | Effect |
|------|--------|
| `--token-env <NAME>` | Reference this env var for the token (default `MEMORY_MCP_TOKEN`) |
| `--token <value>` | Inline a literal token instead (avoid committing it) |
| `--no-auth` | Omit the auth header (loopback or trusted network only) |

> In remote mode the local capture and recall hooks are not installed. The memory lives on the server, not in a local file the hooks could read. The agent uses `memory_search` and `memory_store` directly (the CLAUDE.md guidance is still written).

### 3. Git vault (async, version-controlled sharing)

Prefer your knowledge base in git, reviewed through pull requests, with no server to run? Export memories to plain Markdown and share the folder as a git repo:

```bash
npx mcp-memory-graph vault-init                    # make the vault a git repo (union merge driver + rebuild hook)
git add -A && git commit -m "memory snapshot" && git push
# collaborators, once after cloning:
#   npx mcp-memory-graph vault-init                # registers the union merge driver + post-merge hook in THEIR clone
# collaborators, thereafter: git pull && npx mcp-memory-graph rebuild
```

> **Each collaborator must run `vault-init` once in their own clone.** The merge driver and post-merge rebuild hook live in local git config (`.git/`), not in the repo. A fresh clone without `vault-init` will hit raw conflict markers in `.memory/graph.json` on its first concurrent pull. Re-running `vault-init` is idempotent and does not clobber the committed sidecar.

Two recovery notes for team vaults:

- After a merge you resolved by hand (the post-merge hook only fires on clean merges), `memory rebuild` can refuse with `VaultIntegrityError` because `.memory/manifest.json` is stale. Delete that file and re-run `rebuild`; it is derived state and regenerates.
- Hand-edited a `.md` while your database has newer state? Import first (`vault_sync` or `rebuild`), then export (`memory sync`). A full export from a stale database overwrites vault files, including your hand edit.

### Security notes

- `MCP_AUTH_TOKEN` is a single shared secret, fine for a trusted group; rotate it by restarting the server with a new value. For per-key RBAC (one server, N keys, each pinned to a namespace set and an access-level ceiling) use `memory keys create|list|revoke` (schema v16). The legacy shared token still works and is checked first. See [docs/MULTI-TENANCY.md](docs/MULTI-TENANCY.md#per-key-rbac-schema-v16).
- Never commit a token. The `--remote` default keeps it in an env var by design.
- Bind to `127.0.0.1` (the default) unless you front the server with a proxy that terminates TLS; then set `MCP_BIND=0.0.0.0`.

> Building an org-wide AI brain? One server, a key per employee, an org chart the AI can traverse (people, teams, SOPs, and tools as typed graph nodes), with enforced who-sees-what. The recipe, built on existing primitives, is in [docs/ENTERPRISE-BRAIN.md](docs/ENTERPRISE-BRAIN.md).

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_MEMORY_DB_PATH` | `~/.mcp-memory/memory.db` | Database file location. The directory is created automatically. |
| `MCP_MEMORY_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace embedding model name. Must be an ONNX model compatible with Transformers.js. |
| `MCP_MEMORY_DIMENSIONS` | `384` | Embedding vector dimensions. Must match the model's output. |
| `MCP_MEMORY_CONFIG_PATH` | `~/.mcp-memory/config.json` | Override location for the configuration file. |

The full env reference (auth, rate limits, webhooks, vault, publish) is in [docs/ENV.md](docs/ENV.md).

### Custom database location

```bash
claude mcp add memory-server --env MCP_MEMORY_DB_PATH=/path/to/project/.memory.db node /path/to/dist/index.js
```

### Alternative embedding models

```bash
# Swap the embedding model (same 384 dimensions; drop-in for the existing index
# AFTER a re-embed; see the warning below)
claude mcp add memory-server \
  --env MCP_MEMORY_MODEL=Xenova/bge-small-en-v1.5 \
  --env MCP_MEMORY_DIMENSIONS=384 \
  node /path/to/dist/index.js
```

> **Model identity is recorded and enforced.** The database remembers which embedding model built it (`schema_meta.embedding_model`). Starting the server with a different `MCP_MEMORY_MODEL` fails loudly instead of silently degrading every search (same dimension does not mean same vector space). To switch models: set the new model and run `memory rebuild` (re-embeds from the vault), or export and re-import.

### Configuration file

The config file controls self-improvement behavior, hook settings, and per-project overrides. Resolution order: `MCP_MEMORY_CONFIG_PATH` env, then `<cwd>/.mcp-memory/config.json` (project-scope init writes this), then `~/.mcp-memory/config.json`. Created by `npx mcp-memory-graph init`, or write it by hand:

```json
{
  "defaults": {
    "scope": "project",
    "namespace": "auto"
  },
  "projects": [
    {
      "path": "~/Documents/MyApp",
      "namespace": "my-app",
      "watch": ["README.md", "docs/**/*.md"]
    }
  ],
  "consolidation": {
    "similarity_threshold": 0.85,
    "prune_after_days": 30,
    "min_importance_to_keep": 0.1,
    "max_operations": 100
  },
  "hooks": {
    "extract_on_compact": false,
    "extract_on_session_end": false,
    "track_searches": true
  },
  "extraction": {
    "categories": ["decision", "pattern", "error_fix", "convention"],
    "min_confidence": 0.4
  }
}
```

| Section | Key | Default | Description |
|---------|-----|---------|-------------|
| `defaults` | `scope` | `"project"` | Default scope for new memories |
| `defaults` | `namespace` | `"auto"` | Default namespace (`"auto"` derives from project directory name) |
| `projects[]` | `path` | | Project root directory |
| `projects[]` | `namespace` | | Namespace override for this project |
| `projects[]` | `watch` | | Glob patterns for files to track for changes |
| `consolidation` | `similarity_threshold` | `0.85` | Cosine similarity threshold for deduplication (0.5-1.0) |
| `consolidation` | `prune_after_days` | `30` | Days before pruning low-quality memories |
| `consolidation` | `min_importance_to_keep` | `0.1` | Minimum importance score to survive pruning |
| `consolidation` | `max_operations` | `100` | Max operations per consolidation run |
| `hooks` | `extract_on_compact` | `false` | Mine transcript before context compression (regex-based, off by default) |
| `hooks` | `extract_on_session_end` | `false` | Extract learnings when session ends (regex-based, off by default) |
| `hooks` | `track_searches` | `true` | Log search hits and misses to `search-log.jsonl` |
| `hooks` | `review_on_stop` | `true` | Spawn headless `claude -p` at session end to review the transcript and store learnings. Set `false` to disable without removing the hook. |
| `extraction` | `categories` | `["decision", "pattern", "error_fix", "convention"]` | Learning categories to extract |
| `extraction` | `min_confidence` | `0.4` | Minimum confidence for extracted learnings |
| `storage` | `db_path` | scope-dependent | SQLite file location (`~/.mcp-memory/memory.db` for user scope, `<project>/.mcp-memory/memory.db` for project scope). `MCP_MEMORY_DB_PATH` overrides. |
| `vault` | `path` | unset | Obsidian vault root used by `vault_sync`, `memory_export_vault`, and `rebuild` when no explicit path is passed. `MCP_VAULT_PATH` and `--vault <path>` override. |
| `vault` | `write_through` | `true` | Mirror memory writes out to the vault as `.md` files when a vault is configured. `MCP_VAULT_WRITE_THROUGH=0` overrides. |

## CLI commands

| Command | Description |
|---------|-------------|
| `npx mcp-memory-graph` | Start the MCP server on stdio (default) |
| `npx mcp-memory-graph serve` | Start the HTTP server: MCP transport, REST API, web dashboard |
| `npx mcp-memory-graph init` | Interactive setup wizard: hooks, config, nightly schedule (user scope). Add `--yes`/`-y` for non-interactive |
| `npx mcp-memory-graph init --scope project` | Setup for the current project only (creates `.mcp.json` and `.claude/settings.json`) |
| `npx mcp-memory-graph uninstall` | Reverse init: remove hooks and schedule |
| `npx mcp-memory-graph consolidate` | Run the dream cycle manually |
| `npx mcp-memory-graph export-graph [--out <path>] [--scope <s>] [--namespace <n>]` | Write a committable, deterministic `memory-graph.json` for git sharing |
| `npx mcp-memory-graph git-setup` | Install the `.gitattributes` entry and `memory-union` merge driver for conflict-free graph sharing |
| `npx mcp-memory-graph merge-graphs <ours> <theirs> <out>` | Git union merge driver for `memory-graph.json` (invoked by git, not by hand) |
| `npx mcp-memory-graph vault-init [--vault <path>]` | Make the vault a git repo: union merge driver, `pull.rebase=false`, post-merge and post-checkout rebuild hooks |
| `npx mcp-memory-graph sync` | Export all valid memories plus the graph sidecar to the vault (`.md` files) |
| `npx mcp-memory-graph rebuild [--vault <path>]` | Rebuild the SQLite index from the vault's `.md` files (collaborators run this after `git pull`) |
| `npx mcp-memory-graph migrate` | Upgrade the database to the current schema version |
| `npx mcp-memory-graph backup [--out <path>]` | WAL-safe online snapshot (retention: `MCP_MEMORY_MAX_BACKUPS`, default 10) |
| `npx mcp-memory-graph keys create\|list\|revoke` | Per-key RBAC: mint, inspect, revoke API keys (namespace set plus access ceiling) |

## Tools reference

### 1. `memory_store`

Store a new memory. The vector embedding is generated automatically.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | string | Yes | | The text content to store |
| `title` | string | No | | Short title for the memory |
| `scope` | enum | No | `global`¹ | global, project, user, team, department |
| `namespace` | string | No | ¹ | Sub-scope (e.g., project name) |
| `importance_score` | number | No | computed | 0-1 manual importance override |
| `agent_id` | string | No | `MCP_AGENT_ID` env | Attribution for memory_attribution rollups |
| `on_conflict` | enum | No | `add` | add, supersede, skip: write-gate behavior on near-duplicates |
| `document_type` | string | No | | contract, policy, code, incident, decision, etc. |
| `source` | string | No | | Where this content came from |
| `author` | string | No | | Who created it |
| `department` | string | No | | legal, engineering, hr, sales, finance |
| `tags` | string[] | No | | Tags for categorization |
| `access_level` | enum | No | `internal` | public, internal, confidential, restricted |
| `language` | string | No | `en` | ISO 639-1 language code |
| `metadata` | object | No | | Domain-specific key-value pairs |
| `expires_at` | string | No | | ISO 8601 expiration date |

¹ When omitted, a loaded config file's `defaults.scope` and `defaults.namespace` (`"auto"` = project directory name) apply first; the hardcoded fallback is `global` with no namespace.

Example prompt:

```
Store this memory with department=legal and tags=["compliance","gdpr"]:
"All customer data processing agreements must include a GDPR Article 28 addendum effective January 2025."
```

### 2. `memory_search`

Hybrid vector plus keyword search across stored memories.

How it works:

1. Your query is embedded and compared against all stored vectors (semantic similarity).
2. Your keywords are matched against memory text via FTS5 (exact matching).
3. Both result lists merge using Reciprocal Rank Fusion.
4. Optional temporal decay favors recent memories.
5. Results get a confidence score and label.
6. The access is recorded for quality scoring.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | | Natural language query or keywords |
| `scope` | enum | No | | Filter by scope |
| `namespace` | string | No | | Filter by namespace |
| `department` | string | No | | Filter by department |
| `document_type` | string | No | | Filter by document type |
| `tags` | string[] | No | | Filter: must contain ALL specified tags |
| `access_level` | enum | No | | Filter by access level |
| `language` | string | No | | Filter by language |
| `limit` | number | No | `10` | Max results (1-100) |
| `offset` | number | No | `0` | Pagination offset |
| `search_mode` | enum | No | `hybrid` | `hybrid`, `vector`, or `keyword` |
| `temporal_decay` | object | No | | `{type: "exponential", half_life_days: 30}` or `{type: "linear", max_age_days: 365}` |
| `date_from` | string | No | | Only memories after this date |
| `date_to` | string | No | | Only memories before this date |
| `min_confidence` | number | No | | Minimum confidence threshold (0-1) |

Example prompts:

```
Search memories for "contract renewal notice requirements" in the legal department

Search memories for "authentication" with search_mode=keyword

Search memories for "deployment patterns" with temporal_decay={type:"exponential", half_life_days:60}
```

Each result includes the memory content and metadata, the combined RRF `score`, a normalized `confidence` (0-1), a `confidence_level` label (high at 0.7 and above, medium at 0.4 and above, low below that), and a `match_type` (hybrid, vector, or keyword).

> The default `detail_level: "summary"` projection returns `confidence_level` but omits the numeric `confidence` and the full `content`, to save tokens. Pass `detail_level: "full"` when you need them.

### 3. `memory_get`

Retrieve a specific memory by ID. For ingested documents, optionally include all child chunks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | | Memory UUID |
| `include_chunks` | boolean | No | `false` | Include child chunks for ingested documents |

### 4. `memory_update`

Update an existing memory. If content changes, the embedding regenerates automatically. The previous version is saved to history.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | | Memory ID to update |
| `content` | string | No | | New content (triggers re-embedding) |
| `title` | string | No | | New title |
| `metadata` | object | No | | Replacement metadata |
| `tags` | string[] | No | | Replacement tags |
| `expires_at` | string/null | No | | New expiry, or null to remove |
| `changed_by` | string | No | | Who made this change |

### 5. `memory_delete`

Delete memories by ID or by filter. At least one of `id` or `filter` is required.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Delete a specific memory |
| `filter.scope` | enum | No | Delete all in scope |
| `filter.namespace` | string | No | Delete all in namespace |
| `filter.department` | string | No | Delete all in department |
| `filter.before_date` | string | No | Delete older than date |
| `filter.expired_only` | boolean | No | Only delete expired memories |

### 6. `memory_list`

Browse memories with filtering, pagination, and sorting.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `scope` | enum | | Filter by scope |
| `namespace` | string | | Filter by namespace |
| `department` | string | | Filter by department |
| `document_type` | string | | Filter by type |
| `limit` | number | `20` | Max results (1-100) |
| `offset` | number | `0` | Pagination offset |
| `sort_by` | enum | `created_at` | `created_at`, `updated_at`, or `title` |
| `sort_order` | enum | `desc` | `asc` or `desc` |

### 7. `memory_ingest`

Ingest a full document: it is chunked by content type, each chunk is embedded, and everything is stored with parent-child relationships. Use this for large documents.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | | Full document text (required) |
| `title` | string | | Document title |
| `content_type` | enum | `text` | Chunking strategy: `text`, `markdown`, `code`, `legal`, `structured` |
| `chunk_size` | number | `512` | Target chunk size in characters (~4 chars per token) |
| `chunk_overlap` | number | `50` | Overlap between chunks for context |
| `source` | string | | Origin file or URL |
| `document_type` | string | | Document classification |
| `department` | string | | Department |
| `author` | string | | Author |
| `tags` | string[] | | Tags |
| `metadata` | object | | Domain-specific metadata |

Chunking by content type:

| Type | Strategy | Splits on |
|------|----------|-----------|
| `text` | Paragraph | Double newlines (`\n\n`) |
| `markdown` | Heading-aware | `#`, `##`, `###` headings |
| `code` | Function-aware | `function`, `class`, `const`, `interface` boundaries |
| `legal` | Sentence | Period, exclamation, question marks |
| `structured` | Paragraph | Double newlines (same as text) |

### 8. `memory_related`

Find memories semantically related to a given one. Uses vector similarity, so it finds connections keyword search misses.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | string | | Memory ID to find related for (required) |
| `limit` | number | `5` | Max results (1-50) |
| `min_similarity` | number | | Minimum similarity threshold (0-1) |

### 9. `memory_versions`

View a memory's version history. Every update creates a version record.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | string | | Memory ID (required) |
| `limit` | number | `10` | Max versions (1-50) |

### 10. `memory_stats`

Usage statistics about stored memories.

| Parameter | Type | Description |
|-----------|------|-------------|
| `scope` | enum | Filter stats by scope |
| `namespace` | string | Filter stats by namespace |
| `department` | string | Filter stats by department |

Returns totals for memories, documents, and chunks, breakdowns by scope, department, and type, storage size, and the expired count.

### 11. `memory_export`

Export current memory content as JSON for portability or migration. This is not a full backup: it serializes only currently live, top-level memories. It omits edit history, the knowledge graph, condense-undo originals, ingested child chunks, and soft-forgotten rows. For disaster recovery, copy the SQLite file (`cp ~/.mcp-memory/memory.db ...`, see the RUNBOOK); embeddings recompute deterministically on import.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `scope` | enum | | Filter export |
| `namespace` | string | | Filter export |
| `department` | string | | Filter export |

Max 1000 records per export.

### 12. `memory_import`

Import memories from JSON. Each item is embedded and stored.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `data` | array | | Array of memory objects (required) |
| `overwrite` | boolean | `false` | Overwrite existing IDs |

### 13. `vault_sync`

Scan an Obsidian vault, parse the markdown, embed and store. See [Obsidian Vault Integration](#obsidian-vault-integration) below.

### 14. `vault_status`

Sync status for a vault: files synced, pending, changed, and the last sync time.

### 15. `vault_search`

Hybrid search scoped to one vault's memories.

> By default this searches the namespace named after the vault's folder name. Memories exported from another namespace keep their original namespace in frontmatter. If a search over a freshly synced vault returns nothing, pass an explicit `namespace` (and/or `scope`) override.

### 16. `memory_consolidate`

The dream cycle: deduplicate, score, prune, expire, and detect knowledge gaps.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scope` | enum | No | | Limit consolidation to a scope |
| `namespace` | string | No | | Limit consolidation to a namespace |
| `similarity_threshold` | number | No | `0.85` | Cosine similarity for dedup (0.5-1.0) |
| `prune_expired` | boolean | No | `true` | Remove expired memories |
| `prune_low_quality` | boolean | No | `false` | Remove memories below min importance |
| `dry_run` | boolean | No | `false` | Preview changes without applying |
| `max_operations` | number | No | `100` | Cap on total operations per run |

Five stages run in order: Score (recalculate importance), Expire (enforce `expires_at`), Prune (drop low-quality when enabled), Dedup (merge near-duplicates), Gaps (surface zero-result searches). Returns a report with counts per stage.

Example prompts:

```
Run a dream cycle consolidation with dry_run=true to preview what would change

Consolidate memories in namespace=my-project with similarity_threshold=0.9

Run consolidation with prune_low_quality=true to clean up unused memories
```

### 17. `memory_extract_learnings`

Mine a session transcript for decisions, patterns, error fixes, and conventions using heuristic pattern matching. No external LLM needed.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `transcript` | string | Yes | | Session transcript text to mine |
| `scope` | enum | No | | Scope for extracted memories |
| `namespace` | string | No | | Namespace for extracted memories |
| `department` | string | No | | Department for extracted memories |
| `tags` | string[] | No | | Additional tags |
| `source` | string | No | | Source attribution |
| `categories` | enum[] | No | all | Filter to `decision`, `pattern`, `error_fix`, `convention` |
| `auto_store` | boolean | No | `true` | Automatically store extracted learnings |

Extraction looks for decision language ("we decided", "the fix was"), pattern language ("always use", "never do"), error fixes ("the problem was", "solved by"), and conventions ("our convention is", "standard practice"). Each hit is deduplicated against existing memories and stored with a lower initial confidence.

### 18-42. Graph, Agent-OS, vault round-trip, and governance tools

Parameters for the remaining tools are validated by Zod schemas in `src/schemas/`; each registration's full description lives in `src/server.ts`.

| # | Tool | Purpose |
|---|------|---------|
| 18 | `memory_tiers` | MemGPT-style hot / recall / archival tier distribution plus the hot working set |
| 19 | `memory_export_vault` | Write memories out to an Obsidian vault as `.md` files with YAML frontmatter (reverse of `vault_sync`) |
| 20 | `memory_canvas` | Export the graph as a JSON Canvas 1.0 `.canvas` for Obsidian |
| 21 | `memory_manifest` | Lightweight content-free index (titles, types, tags, scores) to discover what exists |
| 22 | `memory_graph` | Query the knowledge graph: entities, relationships, linked memories, multi-hop traversal (depth 1-3) |
| 23 | `memory_extract_entities` | Store LLM-extracted entities and relationships for a memory |
| 24 | `memory_condense` | Apply agent-generated summaries to condense old memories (original preserved) |
| 25 | `memory_restore` | Restore a condensed memory to its original content and re-embed |
| 26 | `memory_query` | Answer a question with a tight, token-budgeted subgraph instead of flooding context |
| 27 | `core_memory_get` | Read the pinned, always-in-context core-memory block for a `(scope, namespace)` |
| 28 | `core_memory_append` | Append to the core-memory block (refused if it would overflow `char_limit`) |
| 29 | `core_memory_replace` | Replace text in the core-memory block (used to update or compact it) |
| 30 | `memory_reflect` | Generative-Agents-style reflection: gather material, or store a synthesized insight |
| 31 | `memory_communities` | GraphRAG community detection over the entity graph for corpus-level themes |
| 32 | `memory_template` | Fetch a structured note scaffold per document type |
| 33 | `memory_session_note` | Per-session "daily note" (appends to one memory per `session_id`) |
| 34 | `memory_attribution` | Roll up how many valid memories each `agent_id` wrote |
| 35 | `memory_questions` | "Questions to ask" digest: ambiguous links, under-documented entities, orphans |
| 36 | `memory_forget` | GDPR-grade forget: soft-delete (recoverable) by default, or `hard` erase-after-export |
| 37 | `memory_history` | Point-in-time bi-temporal timeline plus edit-version history for one memory |
| 38 | `memory_unlinked_mentions` | Entity names mentioned in memory text with no graph edge yet (suggested links) |
| 39 | `memory_query_structured` | Exact metadata filter query over top-level memories (no semantic ranking) |
| 40 | `memory_version_diff` | Line-level diff between two stored versions of a memory |
| 41 | `memory_version_restore` | Roll a memory back to a previous version (snapshots the current one first) |
| 42 | `memory_verify` | Verify the signed provenance envelope of memories (ed25519 over content_hash plus origin): per-memory `ok`/`unsigned`/`content_mismatch`/`bad_signature`/`untrusted` plus a summary. Opt-in signing via `MCP_SIGN_MEMORIES`; multi-machine allowlist via `MCP_TRUSTED_PUBKEYS` / `trusted_pubkeys` |

### 43-49. Active infrastructure and typed shapes

| # | Tool | Purpose |
|---|------|---------|
| 43 | `memory_webhook` | Manage the event bus (gated by `MCP_WEBHOOKS`): register, list, delete SSRF-validated outbound targets, or dispatch the durable, HMAC-signed delivery queue (retry, circuit breaker, dead letter). Mutations emit created/updated/superseded/deleted/forgotten events |
| 44 | `memory_insights` | Advisor digest: unresolved conflicts, stale memories, most-contradicted facts, evidence-less decisions |
| 45 | `memory_health` | Store health roll-up: live/retired/stale counts, aging buckets, unresolved conflicts, webhook delivery health |
| 46 | `memory_revalidate` | Change propagation: list stale memories, preview a change's blast radius (dry run), or confirm a memory is current |
| 47 | `memory_session_state` | Resumable "where was I" session state, save and resume (versioned) |
| 48 | `memory_expertise` | Per-user expertise profile: observe a topic, get the profile |
| 49 | `memory_export_dataset` | Export learnings and reflections as JSONL training pairs (pairs/chatml/alpaca) for fine-tuning |

## Architecture

### System overview

```
Claude Code ──stdio──> MCP Memory Graph
                            │
                    ┌───────┴───────┐
                    │               │
              Transformers.js   SQLite DB
              (embeddings)    (~/.mcp-memory/memory.db)
                                    │
                       ┌────────────┼────────────┐
                       │            │            │
                   memories    memories_fts  memories_vec
                   (data +     (FTS5 index)  (vec0 index)
                    scores)
                       │
              ┌────────┼────────┐
              │        │        │
        memory_    memory_    ingest_
        versions   access_    source_
                   log        tracking


Claude Code Hooks (opt-in)
    │
    ├── SessionStart ──> memory_stats (status check)
    ├── PostToolUse ───> search-log.jsonl (hit/miss tracking)
    ├── PreCompact ────> learning extraction (disabled by default)
    └── Stop ──────────> spawn detached `claude -p` headless review
                              │
                              └─> --allowedTools mcp__memory-server__memory_store
                                  Claude reviews transcript → memory_store calls

Nightly Schedule (opt-in)
    └── 3:00 AM ───────> memory_consolidate (dream cycle)
```

### How hybrid search works

```
Query: "contract renewal notice"
         │
    ┌────┴────┐
    │         │
 Embed     Tokenize
    │         │
    ▼         ▼
 sqlite-vec  FTS5
 (semantic)  (keyword)
    │         │
    │  rank   │  rank
    │  1: A   │  1: A
    │  2: C   │  2: B
    │  3: B   │  3: D
    │         │
    └────┬────┘
         │
   Reciprocal Rank Fusion
   RRF(d) = Σ 1/(60 + rank)
         │
         ▼
   [A: 0.033, B: 0.026, C: 0.016, D: 0.016]
         │
   Temporal Decay (optional)
         │
   Confidence Scoring
         │
   Access Tracking (record hit)
         │
         ▼
   Final ranked results
```

### Database schema

The SQLite database is at schema version 18, with automatic forward migration from any earlier version. The core tables:

- **`memories`**: all memory data, TEXT primary key (UUIDs), parent-child support for document chunks, plus `access_count`, `last_accessed_at`, `importance_score`, and `confidence_score`.
- **`memories_fts`**: FTS5 virtual table for keyword search with BM25 ranking, synced with the memories table.
- **`memories_vec`**: vec0 virtual table for vector search. 384-dimension float32 embeddings with scope and namespace metadata for pre-filtering.
- **`memory_versions`**: version history for every change.
- **`memory_access_log`**: every search, get, and related-memory access, with timestamps and query context.
- **`ingest_source_tracking`**: ingested files, for change detection on re-ingestion.

Later schema versions add the knowledge-graph tables (entities, links, conflicts, communities), webhooks, session state, and the RBAC `api_keys` table. Every mutation keeps the three core tables in sync atomically inside a SQLite transaction; the `repository.ts` layer enforces this, and nothing else touches the tables directly.

### Project layout

```
src/
├── index.ts        # Entry point (stdio transport)
├── server.ts       # All 49 tool registrations
├── config/         # Config file loading + validation
├── db/             # Connection, schema, migrations, repository (three-table sync)
├── embeddings/     # Embedding providers (Transformers.js, registry, Ollama)
├── search/         # Hybrid search, reranker, temporal decay, scoring
├── chunking/       # Per-content-type chunking strategies
├── graph/          # Entities, links, PageRank, communities
├── vault/          # Obsidian round-trip, write-through, bookkeeping
├── tools/          # One handler per MCP tool
├── api/            # REST routes + security middleware
├── events/         # Webhook bus (SSRF guard, HMAC, retry)
├── cli/            # init, serve, vault, backup, keys, migrate, ...
├── hooks/          # Claude Code lifecycle hooks
└── schemas/        # Zod schemas for every tool input
```

## Use cases by department

Engineering:

```
Store memory: "We chose event sourcing over CRUD for the order service because
we need full audit trail and the ability to replay events for debugging.
ADR-042, decided 2026-03-15."
department=engineering, document_type=decision, tags=["architecture","event-sourcing"]
```

Legal:

```
Ingest this contract template with content_type=legal, department=legal,
document_type=contract, tags=["template","nda","standard"]
```

Finance:

```
Store memory: "Q4 2025 revenue recognition policy change: SaaS contracts
over 12 months now recognized ratably per ASC 606 guidance."
department=finance, document_type=policy, tags=["revenue-recognition","asc-606"]
```

HR:

```
Ingest the employee handbook with department=hr, content_type=text,
document_type=policy, tags=["handbook","onboarding"]
```

Sales:

```
Store memory: "When prospect objects on price vs CompetitorX, lead with
our 99.9% uptime SLA and dedicated support. This converted 3 deals in Q1."
department=sales, document_type=pattern, tags=["objection-handling","pricing","competitorx"]
```

## Obsidian Vault Integration

Point the server at a vault folder and every markdown file becomes a searchable memory, with frontmatter, tags, and wiki-links extracted. No Obsidian app needed; it reads the files straight from disk.

| Tool | Description |
|------|-------------|
| `vault_sync` | Scan vault, parse files, embed and store. Incremental (mtime-based). |
| `vault_status` | Sync status: files synced, pending, changed, last sync time. |
| `vault_search` | Hybrid search scoped to a vault's memories. |

What gets extracted:

| Obsidian feature | Memory field |
|------------------|-------------|
| YAML frontmatter `title:` | `title` |
| YAML frontmatter `tags: [...]` | `tags` (merged with inline) |
| YAML frontmatter `author:` | `author` |
| YAML frontmatter (all fields) | `metadata.frontmatter` |
| Inline `#tags` in content | `tags` (merged with frontmatter) |
| `[[wiki-links]]` | `metadata.links` array |
| File path relative to vault | `source` |
| Vault directory name | `namespace` |

Usage examples:

```
Sync my Obsidian vault at ~/Documents/my-vault

Check vault sync status for ~/Documents/my-vault

Search my vault for "meeting action items about hiring"

Sync vault but only the notes/ and projects/ folders:
  vault_sync with include_patterns=["notes/**", "projects/**"]

Force re-sync everything (ignore modification times):
  vault_sync with force=true
```

`vault_sync` parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `vault_path` | string | | Absolute path to vault directory (required) |
| `chunk_size` | number | `1024` | Target chunk size for large files |
| `chunk_overlap` | number | `50` | Overlap between chunks |
| `force` | boolean | `false` | Re-sync all files regardless of mtime |
| `include_patterns` | string[] | | Only sync matching globs (e.g., `["notes/**"]`) |
| `exclude_patterns` | string[] | | Skip matching globs (e.g., `["templates/**"]`) |

How sync works: it scans the vault recursively for `.md` files (skipping `.obsidian/`, `.trash/`, `.git/`), compares modification times against the last sync, extracts frontmatter, wiki-links, and tags from new or changed files, embeds, and stores. Deleted files have their memories removed. Files larger than the chunk size are split with markdown-aware chunking. A second sync of an unchanged vault takes under a millisecond.

## Security and privacy

- No network calls after the one-time model download (cached locally).
- No telemetry, no analytics, no tracking.
- Hooks are opt-in. They are only installed when you run `npx mcp-memory-graph init`.
- The nightly schedule is opt-in too, and removed by `npx mcp-memory-graph uninstall`.
- Everything is one SQLite file: easy to back up, move, or delete.
- `access_level` metadata (public, internal, confidential, restricted) for organizational awareness.
- Data never leaves your machine.

Backup:

```bash
# WAL-safe online snapshot with retention
npx mcp-memory-graph backup

# Or a simple file copy
cp ~/.mcp-memory/memory.db ~/.mcp-memory/memory.db.backup
```

Reset:

```bash
# Delete the database to start fresh
rm ~/.mcp-memory/memory.db
```

## Nightly consolidation

When installed via `npx mcp-memory-graph init`, a nightly job runs all five dream-cycle stages plus access-log rotation (entries older than 90 days are dropped).

On macOS, a launchd plist is created at `~/Library/LaunchAgents/com.mcp-memory.consolidate.plist`, scheduled for 3:00 AM. On Linux, init prints a cron suggestion:

```bash
# Add to crontab -e
0 3 * * * /usr/local/bin/npx mcp-memory-graph consolidate
```

Run it manually any time:

```bash
npx mcp-memory-graph consolidate
```

## Limitations

- **Scale ceiling.** Vector search is an exact scan: 9.1 ms p95 at 10K vectors, about 30 ms at 50K, and it degrades linearly from there. Comfortable into the low hundreds of thousands; past that you want a dedicated ANN index, which this server does not have yet.
- **English-optimized.** The default MiniLM model is English-only in practice; cross-language matching is weak. A multilingual model can be configured via `MCP_MEMORY_MODEL` (with a rebuild), but the shipped benchmarks only validate the default.
- **First-call cold start.** Three to five seconds on first use while the embedding model loads. Cached after that.
- **Heuristic extraction.** `memory_extract_learnings` uses pattern matching, not an LLM. It catches common phrasings and misses subtle ones. (The Stop hook's `claude -p` review is the LLM-quality path.)
- **One process.** RBAC keys and revocation live in the server process. For horizontal scale you shard tenants across processes or give each tenant their own database file.

## Roadmap

What's actually next, in rough order:

- **Multilingual embeddings, opt-in.** Ship a multilingual ONNX model option (the embedder registry and the model-identity guard already exist, so a swap is safe and loud).
- **Office document ingestion.** PDF, DOCX, XLSX, and friends as an ingest mode, with local extraction only.
- **Vault file watcher.** Auto-rebuild on `.md` changes instead of manual `rebuild`.
- **`as_of` content reconstruction.** Point-in-time queries currently reconstruct validity (which facts were live); reconstructing the content of edited memories at that instant is the remaining half.
- **ANN index** for corpora past a few hundred thousand vectors.
- **Windows test suite port.** The server runs on Windows, but the test suite carries POSIX path assumptions; the Windows CI leg is non-blocking until that's done.

## Tech stack

| Component | Package | Purpose |
|-----------|---------|---------|
| MCP SDK | `@modelcontextprotocol/sdk` ^1.29 | Model Context Protocol server framework |
| Embeddings | `@huggingface/transformers` ^3.8 | Local ONNX model inference in Node.js |
| Database | `better-sqlite3` ^12.10 | Synchronous SQLite with native bindings |
| Vector search | `sqlite-vec` 0.1.10-alpha.4 | vec0 virtual table for KNN search |
| Validation | `zod` ^3.25 | Schema validation for tool inputs |
| TypeScript | `typescript` ^5 | Strict mode, ES2022 target |
| Frontend | React 19, Vite, Tailwind CSS v4 | Web dashboard SPA |
| UI components | shadcn/ui | Accessible component primitives |
| Fuzzy search | `fuse.js` ^7 | Client-side autocomplete suggestions |
| Graph viz | `d3-force`, `d3-zoom`, `d3-drag` | Knowledge graph layout |

## License

Source-available, not open source. Licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE): free for any noncommercial purpose (personal projects, hobby, study, research, charitable, educational, public-research, and government use). Commercial use requires a paid license; see [COMMERCIAL.md](./COMMERCIAL.md).

If you're unsure whether your use counts as commercial, check the safe harbors in the [license](./LICENSE) or just ask: yonasmougaard@gmail.com.

## Keywords

MCP memory server · Model Context Protocol · Claude Code memory · persistent AI memory · LLM long-term memory · AI agent memory · local-first memory · $0/token memory · hybrid vector + keyword search · semantic search · knowledge graph · bi-temporal memory · HippoRAG / Personalized PageRank · cross-encoder reranking · RAG memory · SQLite vector database · sqlite-vec · FTS5 / BM25 · local embeddings (all-MiniLM-L6-v2, Transformers.js) · Obsidian vault sync · JSON Canvas · GDPR forget · signed provenance · self-hosted memory.

Also searched as: a self-hosted, privacy-first alternative to mem0, Zep, Letta, Cognee, and Supermemory · long-term memory for Claude / Cursor / Codex · an Obsidian-backed knowledge base for AI agents · a local knowledge-graph memory that never leaves your machine.
