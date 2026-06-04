# MCP Memory Server

Self-improving, local-first vector memory server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). Store, search, and manage knowledge across any domain — engineering, legal, accounting, HR, sales — with hybrid semantic + keyword search, access tracking, quality scoring, automatic learning extraction, and a "dream cycle" consolidation system, all running entirely on your machine.

## Why This Exists

AI assistants lose context between sessions. Your decisions, patterns, and institutional knowledge disappear when the conversation ends. This MCP server gives Claude a persistent, searchable memory that:

- **Survives across sessions** — Knowledge stored today is searchable tomorrow
- **Understands meaning** — "contract notice period" finds "90-day renewal clause" even without exact keyword match
- **Improves itself** — Tracks what gets accessed, scores quality, extracts learnings from sessions, and consolidates knowledge automatically
- **Stays private** — The core path runs entirely locally: local embeddings, no cloud APIs, no telemetry. The only exception is the **optional** Stop hook (opt-in via `init`), which sends your session transcript to your locally-installed Claude Code (`claude -p`) for learning extraction — disable it with `review_on_stop: false`
- **Works for any team** — Engineers store architectural decisions, lawyers store contract patterns, accountants store audit procedures

## Features

### Core Capabilities

- **49 MCP tools** — core CRUD + retrieval, a confidence-tagged knowledge graph, a self-correcting write gate, signed provenance + verification, an active-infrastructure event bus (SSRF-guarded webhooks), change-propagation + advisor surfaces, resumable session-state + expertise profiles, Agent-OS memory tiers, Obsidian-grade vault round-tripping, and GDPR-grade forget/history (full list below)
- **Hybrid search** — Combines vector similarity (semantic meaning) with keyword matching (exact terms) using Reciprocal Rank Fusion (RRF) for best-of-both-worlds retrieval. Opt-in `rerank: true` adds a cross-encoder rerank pass; `use_graph: true` blends in HippoRAG Personalized-PageRank multi-hop scores; `as_of: <timestamp>` runs the search against the graph as it stood at a past point in time
- **Local embeddings** — Transformers.js with all-MiniLM-L6-v2 (384 dimensions) runs entirely in Node.js. No Python, no cloud API, no GPU required
- **SQLite storage** — Single-file database using better-sqlite3 with two extensions:
  - **sqlite-vec** for vector nearest-neighbor search
  - **FTS5** for full-text keyword search with BM25 ranking
- **Smart document chunking** — Structure-aware strategies that respect content boundaries:
  - **Text**: Splits on paragraph boundaries
  - **Markdown**: Splits on headings, preserves heading context in each chunk
  - **Code**: Splits on function/class boundaries
  - **Legal**: Splits on sentence boundaries (preserves clause integrity)
- **Multi-scope isolation** — Organize memories into scopes: `global`, `project`, `user`, `team`, `department`
- **Version history** — Every update automatically saves the previous version. Full audit trail with who changed what and when
- **Temporal decay** — Configurable time-based scoring to favor recent memories (exponential or linear decay)
- **Confidence scoring** — Each search result includes a confidence score (0-1) with a human-readable level (high/medium/low)
- **Expiration** — Set expiry dates on time-sensitive memories. Expired memories are automatically excluded from search

### Retrieval quality & scale (measured, local, $0/token)

Every number below is produced on the machine running it — real embedding model, real production handlers, zero network egress. Clone the repo and re-run with `npm run bench`; full methodology + the printed gold set + misses in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

| | precision@1 | precision@3 | MRR | search p95 |
|---|---|---|---|---|
| Hybrid (RRF) | 0.563 | 0.750 | 0.704 | ~4 ms |
| **+ cross-encoder rerank** (MCP default) | **0.813** | **0.875** | **0.867** | ~230 ms |

**Scale (real embedder, file-backed SQLite):** retrieval p95 stays sub-second far past the goal — **9.1 ms at 10K vectors, 30 ms at 50K** (the rerank pass adds a ~constant ~200 ms). vs. mem0 / Zep / Letta / Cognee / Supermemory and native ChatGPT/Claude memory — all of which lead with self-reported, cloud-hosted, per-token numbers — this is the inverse: mid-pack accuracy at **0% cloud exposure and $0/token**, reproducible from a committed corpus + runner.

### Self-Improvement Capabilities

- **Access tracking** — Every search, get, and related-memory call records which memories were accessed, building a usage profile over time
- **Quality scoring** — Automatic `importance_score` and `confidence_score` (0-1) on every memory, combining access frequency, recency, and content signals
- **Learning extraction** — Headless `claude -p` invoked at session end uses Claude's own judgment to identify and store significant decisions, patterns, and fixes (replaces the old `type: "agent"` Stop hook, which is silently broken on macOS — see anthropics/claude-code#39184)
- **Dream cycle consolidation** — Scheduled or on-demand deduplication, scoring, pruning, expiration enforcement, and knowledge gap detection
- **Knowledge gap detection** — Tracks zero-result searches to identify missing knowledge areas

### Claude Code Hooks

Four opt-in hooks that integrate with Claude Code's lifecycle:

- **SessionStart** — Fast status check (memory count, expired, stale docs)
- **PostToolUse** — Tracks search hits and misses to `search-log.jsonl`
- **PreCompact** — Triggers learning extraction before context compression (disabled by default)
- **Stop** — Command hook that spawns headless `claude -p --allowedTools mcp__memory-server__memory_store` to review the session and store 0-5 curated learnings. Detached, ~30ms hook overhead, ~10–60s background review. Opt out via `review_on_stop: false` in `~/.mcp-memory/config.json`. Requires Claude Code CLI installed and authenticated on the same machine (the hook resolves `claude` from `$PATH` or `$CLAUDE_BIN`).

### Enterprise Metadata

Every memory supports rich metadata for cross-department use:

| Field | Purpose | Examples |
|-------|---------|---------|
| `scope` | Isolation level | global, project, user, team, department |
| `namespace` | Sub-scope grouping | "my-project", "legal-team", "q4-audit" |
| `department` | Organizational unit | legal, engineering, hr, sales, finance |
| `document_type` | Content classification | contract, policy, code, incident, decision, report |
| `access_level` | Data sensitivity | public, internal, confidential, restricted |
| `tags` | Flexible categorization | ["renewal", "notice-period", "compliance"] |
| `language` | Content language (ISO 639-1) | "en", "da", "de" |
| `source` | Origin/provenance | file path, URL, system name |
| `author` | Creator attribution | person or system name |
| `metadata` | Domain-specific JSON | `{contract_type: "NDA", parties: ["A","B"]}` |
| `expires_at` | Auto-expiration date | ISO 8601 timestamp |

### Knowledge graph + bi-temporal model

- **Bi-temporal validity** — Every memory carries valid-time (`valid_from`/`valid_to`) alongside transaction-time. Updates *invalidate-don't-delete*: the prior fact is stamped `valid_to` instead of being overwritten, so history is never lost. `memory_search` and most reads default to currently-valid rows, but accept `as_of: <timestamp>` for point-in-time recall, and `memory_history` returns one memory's full bi-temporal timeline plus its edit versions.
- **Confidence-tagged links** — `memory_links` connect memories via wikilink, co-occurrence, and similarity edges, each carrying a confidence weight. `memory_graph` traverses entities and their relationships (multi-hop, depth 1–3); `memory_extract_entities` stores LLM-extracted entities/relationships.
- **HippoRAG multi-hop** — `use_graph: true` on search runs Personalized PageRank over the entity/link graph for associative, multi-hop retrieval.
- **Token-budgeted traversal** — `memory_query` answers a question with a *tight* subgraph: it seeds from hybrid search, walks the graph hub-avoiding up to `max_hops`, and returns a token-budgeted context string with a truncation hint — instead of flooding the window.
- **GraphRAG communities** — `memory_communities` detects densely-connected entity clusters via weighted label propagation for corpus-level "what are the main themes?" sensemaking.

### Self-correcting writes

- **Write gate** — Stores route through an ADD / UPDATE / DELETE / NOOP decision (`on_conflict`) so new facts reconcile with existing ones instead of blindly duplicating.
- **Contradiction detection** — A cross-encoder NLI model flags when an incoming memory contradicts what's already stored.
- **Forgetting curve** — Memories carry a `stability` signal so rarely-reinforced knowledge decays in ranking the way human memory does.

### Agent-OS memory

- **Core memory block** — A small, bounded, always-in-context note per `(scope, namespace)` that the agent maintains (`core_memory_get` / `core_memory_append` / `core_memory_replace`); appends that would overflow are refused so the agent compacts deliberately.
- **Hot / recall / archival tiers** — `memory_tiers` reports a MemGPT-style tier distribution derived from access recency + frequency and lists the hot working set.
- **Reflection** — `memory_reflect` gathers the most reflection-worthy memories and (in store mode) persists synthesized higher-level insights, linked back to their sources.

### Obsidian-grade vault

- **Bidirectional write-back** — `vault_sync` reads a vault *in*; `memory_export_vault` writes memories *out* as `.md` files with YAML frontmatter that round-trip losslessly.
- **JSON Canvas** — `memory_canvas` exports the graph as a JSON Canvas 1.0 `.canvas` that opens as a spatial board in real Obsidian.
- **Read-only memory wiki / Publish** — `serve` exposes `/publish/:namespace` (index, page, search, graph) as a read-only wiki. It is intentionally *not* behind bearer auth but is hard-scoped to published access levels (`MCP_PUBLISH_ACCESS_LEVELS`, default `public`).
- **Session notes + templates** — `memory_session_note` is a frictionless per-session "daily note" (appends to one memory per `session_id`); `memory_template` returns structured note scaffolds per document type.

### Team & solo sharing (Bruno-style git)

- **Interactive `memory init` wizard** — `memory init` walks you through configuration interactively (or `--yes` for all-defaults), writing `~/.mcp-memory/config.json` (or project-scoped) plus the Claude Code wiring.
- **Committable graph artifact** — `memory export-graph` writes a deterministic `memory-graph.json` you can commit and share like a Bruno collection. `memory git-setup` installs a `.gitattributes` entry and the `memory-union` git merge driver (`memory merge-graphs`) so parallel commits of that file merge instead of conflict.
- **Attribution** — Set `MCP_AGENT_ID` (or pass `agent_id` per store) and `memory_attribution` rolls up how many valid memories each agent wrote.

### Trust & governance

- **Questions to ask** — `memory_questions` surfaces gaps the graph is uniquely positioned to find: ambiguous links to confirm, under-documented frequent entities, and orphaned/stale memories.
- **GDPR-grade forget** — `memory_forget` soft-deletes (tombstones via `valid_to`, recoverable, still queryable via `as_of`) by default, or `hard: true` returns a portability export *first* then permanently erases. Additive — `memory_delete` is unchanged.
- **Output sanitization** — Every MCP tool result is run through a single sanitization chokepoint that neutralizes ANSI/VT escapes, control chars, and zero-width / BiDi Trojan-Source spoofing before it leaves the server. Stored content stays raw at rest.
- **Hot-reload** — Config changes are picked up without a restart.

### Web dashboard

The memory server includes a browser-based dashboard for viewing and managing memories outside of Claude. It runs on the same Express server as the MCP HTTP transport — no separate process needed.

**5 pages:**

- **Dashboard** — memory counts, content size, breakdowns by scope/department/type, and the 10 most recently updated memories
- **Search** — hybrid vector+keyword search with confidence and match-type badges. Fuse.js provides instant fuzzy suggestions as you type (indexes titles and tags client-side)
- **Browse** — sortable, paginated table of all memories with scope filtering and quality score indicators
- **Memory detail** — full content view, metadata panel, version history, related memories (vector similarity), and inline edit/delete
- **Knowledge graph** — D3 force-directed visualization of memory relationships. Nodes are sized by importance and colored by scope. Zoom, pan, drag, hover tooltips, double-click to navigate

**Tech stack:** React 19, Vite, Tailwind CSS v4, shadcn/ui (21 components), Fuse.js, D3, Recharts

**Running it:**

```bash
# Development (hot reload)
npm run build && npm run serve   # Terminal 1: server on :3100
npm run dev:web                   # Terminal 2: Vite on :5173 (proxies /api to :3100)

# Production (single process)
npm run build:all                 # Builds server + frontend
npm run serve                     # http://localhost:3100 serves both API and UI
```

**Docker / team deployment:**

The Docker image includes the built frontend. After `docker compose up`, the dashboard is available at `http://<host>:3100` alongside the MCP endpoint. Team members can browse the shared memory store from any browser — no Claude Code required.

**REST API (9 endpoints):**

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
| `GET` | `/api/graph` | Nodes + edges for graph visualization |

The REST endpoints call the same handler functions as the MCP tools. No business logic is duplicated.

---

## Self-improvement

The memory server is a self-improving system. It tracks how knowledge is used, scores quality, learns from sessions, and consolidates itself over time.

### The Learning Loop

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
 │  1. Score    — Recalculate importance from access data    │
 │  2. Expire   — Enforce expiration dates                   │
 │  3. Prune    — Remove low-quality, never-accessed items   │
 │  4. Dedup    — Merge near-duplicate memories              │
 │  5. Gaps     — Surface zero-result search patterns        │
 └──────────────────────────────────────────────────────────┘
```

### Quality Scoring Formula

Every memory receives an `importance_score` (0-1) computed as:

```
importance = 0.3 * current_score + 0.4 * normalized_access_frequency + 0.3 * recency_factor
```

**Recency factor:**
| Age | Factor |
|-----|--------|
| < 7 days | 1.0 |
| < 30 days | 0.7 |
| < 90 days | 0.4 |
| > 90 days | 0.1 |

Memories that are never accessed gradually lose importance. Auto-extracted memories start with a lower score and get pruned if they are never useful.

### Knowledge Gap Detection

When a search returns zero results, the query is logged. During the dream cycle's gap detection stage, these zero-result queries are surfaced so you can identify what knowledge is missing from the memory store.

---

## Installation

### Prerequisites

- **Node.js 20+** (required)
- **Claude Code** installed and authenticated ([docs](https://docs.anthropic.com/en/docs/claude-code)). The Stop hook spawns `claude -p` in headless mode, so the binary must be on `$PATH` (or pointed at via `$CLAUDE_BIN`) and authenticated without prompting.

### Build from Source

```bash
git clone https://github.com/YonasValentin/mcp-memory-server.git
cd mcp-memory-server
npm install
npm run build
```

### Add to Claude Code

```bash
claude mcp add memory-server node /path/to/mcp-memory-server/dist/index.js
```

The first time a memory tool is used, the embedding model (~30MB) downloads automatically from HuggingFace and is cached locally at `~/.cache/huggingface/`. Subsequent starts are instant.

### Setup Hooks (Recommended)

After building, run the init command to register hooks, config, and nightly consolidation:

```bash
# Global (user scope) — hooks apply to all projects
npx mcp-memory-local init

# Per-project — hooks and MCP registration scoped to this project only
npx mcp-memory-local init --scope project
```

**User scope** (default) writes hooks to `~/.claude/settings.json`. Hooks fire in every Claude Code session regardless of project.

**Project scope** writes hooks to `.claude/settings.json` in the current directory and creates `.mcp.json` for automatic MCP server discovery. Collaborators who clone the project get the memory server registered automatically.

Init performs these steps:
1. Verify hook scripts exist in `dist/hooks/`
2. Register hooks in settings.json (SessionStart, PostToolUse, PreCompact, Stop)
3. Create `~/.mcp-memory/config.json` with sensible defaults
4. Set up `.claude/CLAUDE.md` with memory server usage instructions (project scope) or print snippet (user scope)
5. Set up nightly consolidation schedule (macOS: launchd, Linux: cron suggestion)

To reverse everything:

```bash
npx mcp-memory-local uninstall
```

### Verify Installation

In a Claude Code session, ask:
```
What memory tools do you have available?
```

Claude should list all 49 tools (43 `memory_*` + 3 `vault_*` + 3 `core_memory_*`).

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_MEMORY_DB_PATH` | `~/.mcp-memory/memory.db` | Database file location. The directory is created automatically. |
| `MCP_MEMORY_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace embedding model name. Must be an ONNX model compatible with Transformers.js. |
| `MCP_MEMORY_DIMENSIONS` | `384` | Embedding vector dimensions. Must match the model's output dimensions. |
| `MCP_MEMORY_CONFIG_PATH` | `~/.mcp-memory/config.json` | Override location for the configuration file. |

### Custom Database Location

```bash
# Store memories in a project-specific location
claude mcp add memory-server --env MCP_MEMORY_DB_PATH=/path/to/project/.memory.db node /path/to/dist/index.js
```

### Alternative Embedding Models

```bash
# Use a larger model for higher accuracy (768 dimensions, slower)
claude mcp add memory-server \
  --env MCP_MEMORY_MODEL=Xenova/bge-small-en-v1.5 \
  --env MCP_MEMORY_DIMENSIONS=384 \
  node /path/to/dist/index.js
```

### Configuration File

The config file at `~/.mcp-memory/config.json` controls self-improvement behavior, hook settings, and per-project overrides. Created automatically by `npx mcp-memory-local init`, or create it manually:

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
| `projects[]` | `path` | — | Project root directory |
| `projects[]` | `namespace` | — | Namespace override for this project |
| `projects[]` | `watch` | — | Glob patterns for files to track for changes |
| `consolidation` | `similarity_threshold` | `0.85` | Cosine similarity threshold for deduplication (0.5-1.0) |
| `consolidation` | `prune_after_days` | `30` | Days before pruning low-quality memories |
| `consolidation` | `min_importance_to_keep` | `0.1` | Minimum importance score to survive pruning |
| `consolidation` | `max_operations` | `100` | Max operations per consolidation run |
| `hooks` | `extract_on_compact` | `false` | Mine transcript before context compression (regex-based, disabled by default) |
| `hooks` | `extract_on_session_end` | `false` | Extract learnings when session ends (regex-based, disabled by default) |
| `hooks` | `track_searches` | `true` | Log search hits/misses to `search-log.jsonl` |
| `hooks` | `review_on_stop` | `true` | Spawn headless `claude -p` at session end to review transcript and call `memory_store`. Set `false` to disable per-session-end review without removing the hook from `settings.json`. |
| `extraction` | `categories` | `["decision", "pattern", "error_fix", "convention"]` | Learning categories to extract |
| `extraction` | `min_confidence` | `0.4` | Minimum confidence for extracted learnings |

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `npx mcp-memory-local` | Start MCP server on stdio (default) |
| `npx mcp-memory-local serve` | Start HTTP server with MCP transport + REST API + web dashboard |
| `npx mcp-memory-local init` | Interactive setup wizard: hooks, config, and nightly schedule (user scope). Add `--yes`/`-y` to accept all defaults non-interactively |
| `npx mcp-memory-local init --scope project` | Setup for current project only (creates `.mcp.json` + `.claude/settings.json`) |
| `npx mcp-memory-local uninstall` | Reverse init: remove hooks and schedule |
| `npx mcp-memory-local consolidate` | Run the dream cycle manually |
| `npx mcp-memory-local export-graph [--out <path>] [--scope <s>] [--namespace <n>]` | Write a committable, deterministic `memory-graph.json` for git sharing |
| `npx mcp-memory-local git-setup` | Install the `.gitattributes` entry + `memory-union` git merge driver for conflict-free graph sharing |
| `npx mcp-memory-local merge-graphs <ours> <theirs> <out>` | Git union merge driver for `memory-graph.json` (invoked by git, not by hand) |

---

## Tools Reference

### 1. `memory_store`

Store a new memory with automatic vector embedding generation.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | string | Yes | — | The text content to store |
| `title` | string | No | — | Short title for the memory |
| `scope` | enum | No | `global` | global, project, user, team, department |
| `namespace` | string | No | — | Sub-scope (e.g., project name) |
| `document_type` | string | No | — | contract, policy, code, incident, decision, etc. |
| `source` | string | No | — | Where this content came from |
| `author` | string | No | — | Who created it |
| `department` | string | No | — | legal, engineering, hr, sales, finance |
| `tags` | string[] | No | — | Tags for categorization |
| `access_level` | enum | No | `internal` | public, internal, confidential, restricted |
| `language` | string | No | `en` | ISO 639-1 language code |
| `metadata` | object | No | — | Domain-specific key-value pairs |
| `expires_at` | string | No | — | ISO 8601 expiration date |

**Example prompt:**
```
Store this memory with department=legal and tags=["compliance","gdpr"]:
"All customer data processing agreements must include a GDPR Article 28 addendum effective January 2025."
```

---

### 2. `memory_search`

Hybrid vector+keyword search across all stored memories.

**How search works:**

1. Your query is embedded into a vector and compared against all stored memory vectors (semantic similarity)
2. Your query keywords are matched against memory text via FTS5 (exact keyword matching)
3. Results from both are merged using Reciprocal Rank Fusion (RRF)
4. Optional temporal decay is applied to favor recent memories
5. Results are scored with a confidence level
6. Access is recorded for quality scoring (access_count incremented, last_accessed_at updated)

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | — | Natural language query or keywords |
| `scope` | enum | No | — | Filter by scope |
| `namespace` | string | No | — | Filter by namespace |
| `department` | string | No | — | Filter by department |
| `document_type` | string | No | — | Filter by document type |
| `tags` | string[] | No | — | Filter: must contain ALL specified tags |
| `access_level` | enum | No | — | Filter by access level |
| `language` | string | No | — | Filter by language |
| `limit` | number | No | `10` | Max results (1-100) |
| `offset` | number | No | `0` | Pagination offset |
| `search_mode` | enum | No | `hybrid` | `hybrid`, `vector`, or `keyword` |
| `temporal_decay` | object | No | — | `{type: "exponential", half_life_days: 30}` or `{type: "linear", max_age_days: 365}` |
| `date_from` | string | No | — | Only memories after this date |
| `date_to` | string | No | — | Only memories before this date |
| `min_confidence` | number | No | — | Minimum confidence threshold (0-1) |

**Example prompts:**
```
Search memories for "contract renewal notice requirements" in the legal department

Search memories for "authentication" with search_mode=keyword

Search memories for "deployment patterns" with temporal_decay={type:"exponential", half_life_days:60}
```

**Response includes for each result:**
- Full memory content and metadata
- `score` — Combined RRF score
- `confidence` — Normalized 0-1 confidence
- `confidence_level` — "high" (>=0.7), "medium" (>=0.4), or "low"
- `match_type` — "hybrid", "vector", or "keyword"

---

### 3. `memory_get`

Retrieve a specific memory by ID. For ingested documents, optionally include all child chunks.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | — | Memory UUID |
| `include_chunks` | boolean | No | `false` | Include child chunks for ingested documents |

---

### 4. `memory_update`

Update an existing memory. If content changes, the vector embedding is automatically regenerated. The previous version is saved to version history.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `id` | string | Yes | — | Memory ID to update |
| `content` | string | No | — | New content (triggers re-embedding) |
| `title` | string | No | — | New title |
| `metadata` | object | No | — | Replacement metadata |
| `tags` | string[] | No | — | Replacement tags |
| `expires_at` | string/null | No | — | New expiry, or null to remove |
| `changed_by` | string | No | — | Who made this change |

---

### 5. `memory_delete`

Delete memories by ID or by filter. At least one of `id` or `filter` must be provided.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | No | Delete specific memory |
| `filter.scope` | enum | No | Delete all in scope |
| `filter.namespace` | string | No | Delete all in namespace |
| `filter.department` | string | No | Delete all in department |
| `filter.before_date` | string | No | Delete older than date |
| `filter.expired_only` | boolean | No | Only delete expired memories |

---

### 6. `memory_list`

Browse memories with filtering, pagination, and sorting.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `scope` | enum | — | Filter by scope |
| `namespace` | string | — | Filter by namespace |
| `department` | string | — | Filter by department |
| `document_type` | string | — | Filter by type |
| `limit` | number | `20` | Max results (1-100) |
| `offset` | number | `0` | Pagination offset |
| `sort_by` | enum | `created_at` | `created_at`, `updated_at`, or `title` |
| `sort_order` | enum | `desc` | `asc` or `desc` |

---

### 7. `memory_ingest`

Ingest a full document: automatically chunks it based on content type, embeds each chunk, and stores with parent-child relationships. Use this for large documents.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `content` | string | — | Full document text (required) |
| `title` | string | — | Document title |
| `content_type` | enum | `text` | Chunking strategy: `text`, `markdown`, `code`, `legal`, `structured` |
| `chunk_size` | number | `512` | Target chunk size in characters (~4 chars/token) |
| `chunk_overlap` | number | `50` | Overlap between chunks for context |
| `source` | string | — | Origin file/URL |
| `document_type` | string | — | Document classification |
| `department` | string | — | Department |
| `author` | string | — | Author |
| `tags` | string[] | — | Tags |
| `metadata` | object | — | Domain-specific metadata |

**How chunking works by content type:**

| Type | Strategy | Splits On |
|------|----------|-----------|
| `text` | Paragraph | Double newlines (`\n\n`) |
| `markdown` | Heading-aware | `#`, `##`, `###` headings |
| `code` | Function-aware | `function`, `class`, `const`, `interface` boundaries |
| `legal` | Sentence | Period, exclamation, question marks |
| `structured` | Paragraph | Double newlines (same as text) |

---

### 8. `memory_related`

Find memories semantically related to a given memory. Uses vector similarity to discover connections you might not find with keyword search.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | string | — | Memory ID to find related for (required) |
| `limit` | number | `5` | Max results (1-50) |
| `min_similarity` | number | — | Minimum similarity threshold (0-1) |

---

### 9. `memory_versions`

View the version history of a memory. Every update automatically creates a version record.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `id` | string | — | Memory ID (required) |
| `limit` | number | `10` | Max versions (1-50) |

---

### 10. `memory_stats`

Get usage statistics about stored memories.

| Parameter | Type | Description |
|-----------|------|-------------|
| `scope` | enum | Filter stats by scope |
| `namespace` | string | Filter stats by namespace |
| `department` | string | Filter stats by department |

**Returns:** Total memories, documents, chunks, breakdowns by scope/department/type, storage size, expired count.

---

### 11. `memory_export`

Export memories as JSON for backup or migration.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `scope` | enum | — | Filter export |
| `namespace` | string | — | Filter export |
| `department` | string | — | Filter export |
| `include_embeddings` | boolean | `false` | Include raw vectors (large) |

Max 1000 records per export.

---

### 12. `memory_import`

Import memories from JSON. Each item is embedded and stored.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `data` | array | — | Array of memory objects (required) |
| `overwrite` | boolean | `false` | Overwrite existing IDs |

---

### 13. `vault_sync`

Scan an Obsidian vault, parse markdown files, embed and store. See the [Obsidian Vault Integration](#obsidian-vault-integration) section for full details.

---

### 14. `vault_status`

Show sync status for an Obsidian vault: files synced/pending/changed, last sync time.

---

### 15. `vault_search`

Hybrid search scoped to a specific vault's memories.

---

### 16. `memory_consolidate`

The "Dream Cycle" — run consolidation to deduplicate, score, prune, expire, and detect knowledge gaps.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `scope` | enum | No | — | Limit consolidation to a scope |
| `namespace` | string | No | — | Limit consolidation to a namespace |
| `similarity_threshold` | number | No | `0.85` | Cosine similarity for dedup (0.5-1.0) |
| `prune_expired` | boolean | No | `true` | Remove expired memories |
| `prune_low_quality` | boolean | No | `false` | Remove memories below min importance |
| `dry_run` | boolean | No | `false` | Preview changes without applying |
| `max_operations` | number | No | `100` | Cap on total operations per run |

**Five stages executed in order:**

1. **Score** — Recalculate `importance_score` for all memories using access frequency and recency
2. **Expire** — Remove memories past their `expires_at` date
3. **Prune** — Remove low-quality memories (when `prune_low_quality=true`)
4. **Dedup** — Find and merge near-duplicate memories above the similarity threshold
5. **Gaps** — Surface zero-result search queries as knowledge gap candidates

**Returns:** A `ConsolidationReport` with counts for each stage (scored, expired, pruned, merged, gaps found).

**Example prompts:**
```
Run a dream cycle consolidation with dry_run=true to preview what would change

Consolidate memories in namespace=my-project with similarity_threshold=0.9

Run consolidation with prune_low_quality=true to clean up unused memories
```

---

### 17. `memory_extract_learnings`

Mine a session transcript for decisions, patterns, error fixes, and conventions using heuristic pattern matching. No external LLM needed.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `transcript` | string | Yes | — | Session transcript text to mine |
| `scope` | enum | No | — | Scope for extracted memories |
| `namespace` | string | No | — | Namespace for extracted memories |
| `department` | string | No | — | Department for extracted memories |
| `tags` | string[] | No | — | Additional tags for extracted memories |
| `source` | string | No | — | Source attribution |
| `categories` | enum[] | No | all | Filter to specific categories: `decision`, `pattern`, `error_fix`, `convention` |
| `auto_store` | boolean | No | `true` | Automatically store extracted learnings |

**How extraction works:**
1. Heuristic pattern matching identifies sentences containing decision language ("we decided", "the fix was"), pattern language ("always use", "never do"), error fixes ("the problem was", "solved by"), and conventions ("our convention is", "standard practice")
2. Each extracted learning is deduplicated against existing memories
3. If `auto_store=true`, new learnings are stored with appropriate metadata and a lower initial confidence score

**Example prompts:**
```
Extract learnings from this session transcript with namespace=my-project

Extract only error_fix and decision learnings from this transcript
```

### 18–42. Graph, Agent-OS, vault round-trip, and governance tools

The remaining tools are summarized below (parameters are validated by Zod schemas in `src/schemas/`; each registration's full description lives in `src/server.ts`):

| # | Tool | Purpose |
|---|------|---------|
| 18 | `memory_tiers` | MemGPT-style hot / recall / archival tier distribution + the hot working set |
| 19 | `memory_export_vault` | Write memories OUT to an Obsidian vault as `.md` files with YAML frontmatter (reverse of `vault_sync`) |
| 20 | `memory_canvas` | Export the graph as a JSON Canvas 1.0 `.canvas` for Obsidian |
| 21 | `memory_manifest` | Lightweight content-free index (titles/types/tags/scores) to discover what exists |
| 22 | `memory_graph` | Query the knowledge graph: entities, relationships, linked memories, multi-hop traversal (depth 1–3) |
| 23 | `memory_extract_entities` | Store LLM-extracted entities + relationships for a memory |
| 24 | `memory_condense` | Apply agent-generated summaries to condense old memories (original preserved) |
| 25 | `memory_restore` | Restore a condensed memory to its original full content and re-embed |
| 26 | `memory_query` | Answer a question with a tight, token-budgeted subgraph instead of flooding context |
| 27 | `core_memory_get` | Read the pinned, always-in-context core-memory block for a `(scope, namespace)` |
| 28 | `core_memory_append` | Append to the core-memory block (refused if it would overflow `char_limit`) |
| 29 | `core_memory_replace` | Replace text in the core-memory block (used to update/compact it) |
| 30 | `memory_reflect` | Generative-Agents-style reflection: gather material, or store a synthesized insight |
| 31 | `memory_communities` | GraphRAG community detection over the entity graph for corpus-level themes |
| 32 | `memory_template` | Fetch a structured note scaffold per document type |
| 33 | `memory_session_note` | Frictionless per-session "daily note" (appends to one memory per `session_id`) |
| 34 | `memory_attribution` | Roll up how many valid memories each `agent_id` wrote |
| 35 | `memory_questions` | "Questions to ask" digest: ambiguous links, under-documented entities, orphans |
| 36 | `memory_forget` | GDPR-grade forget: soft-delete (recoverable) by default, or `hard` erase-after-export |
| 37 | `memory_history` | Point-in-time bi-temporal timeline + edit-version history for one memory |
| 38 | `memory_unlinked_mentions` | Find entity names mentioned in memory text that have no graph edge yet (suggested links) |
| 39 | `memory_query_structured` | Exact metadata filter query over top-level memories (no semantic ranking) |
| 40 | `memory_version_diff` | Line-level diff between two stored versions of a memory |
| 41 | `memory_version_restore` | Roll a memory back to a previous version (snapshots the current one first) |
| 42 | `memory_verify` | Verify the signed provenance envelope of memories (ed25519 over content_hash + origin): per-memory `ok`/`unsigned`/`content_mismatch`/`bad_signature`/`untrusted` + a `{verified, unsigned, tampered, untrusted}` summary. Opt-in signing via `MCP_SIGN_MEMORIES`; multi-machine allowlist via `MCP_TRUSTED_PUBKEYS` / `trusted_pubkeys` |

### 43–49. Active infrastructure + typed shapes (M3–M6)

| # | Tool | Purpose |
|---|------|---------|
| 43 | `memory_webhook` | Manage the active-infrastructure event bus (gated `MCP_WEBHOOKS`): register/list/delete SSRF-validated outbound targets, or dispatch the durable, HMAC-signed delivery queue (retry + circuit-breaker + dead-letter). Mutations emit created/updated/superseded/deleted/forgotten |
| 44 | `memory_insights` | Active advisor digest — unresolved conflicts, stale (needs-revalidation) memories, most-contradicted facts, evidence-less decisions |
| 45 | `memory_health` | Store health roll-up — live/retired/stale counts, aging buckets, unresolved conflicts, webhook delivery health → `ok`/`attention` |
| 46 | `memory_revalidate` | Change-propagation surface — list stale memories, preview a change's blast radius (dry-run), or confirm a memory is current |
| 47 | `memory_session_state` | Resumable "where was I" session-state save/resume (versioned, dedup-gate-safe) |
| 48 | `memory_expertise` | Adaptive per-user expertise profile — observe a topic (saturating curve) / get the profile |
| 49 | `memory_export_dataset` | Read-only LoRA/distillation flywheel — export learnings + reflections as JSONL training pairs (pairs/chatml/alpaca) |

---

## Architecture

### System Overview

```
Claude Code ──stdio──> MCP Memory Server
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

### How Hybrid Search Works

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

### Database Schema

The SQLite database (schema version 3, with automatic migration from v1/v2) contains:

- **`memories`** — Core table with all memory data, TEXT primary key (UUIDs), supports parent-child relationships for document chunks. Includes `access_count`, `last_accessed_at`, `importance_score`, and `confidence_score` columns
- **`memories_fts`** — FTS5 virtual table for full-text keyword search with BM25 ranking. External content mode, synced with memories table
- **`memories_vec`** — vec0 virtual table for vector nearest-neighbor search. 384-dimension float32 embeddings with scope/namespace metadata for pre-filtering
- **`memory_versions`** — Version history table tracking all changes
- **`memory_access_log`** — Tracks every search, get, and related-memory access with timestamps and query context
- **`ingest_source_tracking`** — Tracks ingested files for change detection during re-ingestion

### Three-Table Sync

Every mutation (insert, update, delete) keeps all three tables in sync atomically via SQLite transactions. The `repository.ts` layer enforces this — no direct table access elsewhere.

### Project Structure

```
src/
├── index.ts              # Entry point (shebang + stdio transport)
├── server.ts             # 17 tool registrations with McpServer
├── types.ts              # All TypeScript interfaces
├── config/
│   └── loader.ts         # Config file reader + Zod validation
├── lib/
│   └── direct-access.ts  # Shared DB+embedder for hooks/CLI
├── db/
│   ├── connection.ts     # Singleton DB, sqlite-vec loading, WAL mode
│   ├── schema.ts         # Table/index/virtual table creation
│   ├── migrations.ts     # Schema versioning (v1 → v2 → v3)
│   └── repository.ts     # Three-table sync (memories + FTS5 + vec0)
├── embeddings/
│   ├── provider.ts       # EmbeddingProvider interface (swappable)
│   └── transformers.ts   # Transformers.js implementation (lazy-loaded)
├── search/
│   ├── hybrid.ts         # Vector + FTS5 + RRF fusion engine
│   ├── temporal.ts       # Exponential/linear decay functions
│   └── scoring.ts        # Confidence scoring and labeling
├── chunking/
│   ├── strategies.ts     # Per-content-type chunking strategies
│   └── chunker.ts        # Chunking orchestrator with overlap
├── tools/
│   ├── store.ts          # memory_store handler
│   ├── search.ts         # memory_search handler
│   ├── get.ts            # memory_get handler
│   ├── update.ts         # memory_update handler
│   ├── delete.ts         # memory_delete handler
│   ├── list.ts           # memory_list handler
│   ├── ingest.ts         # memory_ingest handler
│   ├── related.ts        # memory_related handler
│   ├── versions.ts       # memory_versions handler
│   ├── stats.ts          # memory_stats handler
│   ├── export.ts         # memory_export handler
│   ├── import.ts         # memory_import handler
│   ├── consolidate.ts    # memory_consolidate handler
│   └── extract-learnings.ts # memory_extract_learnings handler
├── cli/
│   ├── init.ts           # npx mcp-memory-local init
│   ├── uninstall.ts      # npx mcp-memory-local uninstall
│   ├── consolidate.ts    # npx mcp-memory-local consolidate
│   └── cleanup-extracted.ts  # Utility to purge auto-extracted noise
├── hooks/
│   ├── memory-session-start.ts
│   ├── memory-post-search.ts
│   └── memory-pre-compact.ts
└── schemas/
    └── index.ts          # 17 Zod schemas with LLM-discoverable descriptions
```

---

## Use Cases by Department

### Engineering
```
Store memory: "We chose event sourcing over CRUD for the order service because
we need full audit trail and the ability to replay events for debugging.
ADR-042, decided 2026-03-15."
department=engineering, document_type=decision, tags=["architecture","event-sourcing"]
```

### Legal
```
Ingest this contract template with content_type=legal, department=legal,
document_type=contract, tags=["template","nda","standard"]
```

### Accounting / Finance
```
Store memory: "Q4 2025 revenue recognition policy change: SaaS contracts
over 12 months now recognized ratably per ASC 606 guidance."
department=finance, document_type=policy, tags=["revenue-recognition","asc-606"]
```

### HR
```
Ingest the employee handbook with department=hr, content_type=text,
document_type=policy, tags=["handbook","onboarding"]
```

### Sales
```
Store memory: "When prospect objects on price vs CompetitorX, lead with
our 99.9% uptime SLA and dedicated support — this converted 3 deals in Q1."
department=sales, document_type=pattern, tags=["objection-handling","pricing","competitorx"]
```

---

## Obsidian Vault Integration

Sync an Obsidian vault to vector memory. Point at a vault folder, and all markdown files are ingested with their frontmatter, tags, and wiki-links as searchable memories. **No Obsidian app needed** — works by reading files directly from disk.

### Vault Tools

| Tool | Description |
|------|-------------|
| `vault_sync` | Scan vault, parse files, embed and store. Incremental (mtime-based). |
| `vault_status` | Show sync status: files synced/pending/changed, last sync time. |
| `vault_search` | Hybrid search scoped to a vault's memories. |

### What Gets Extracted

| Obsidian Feature | Memory Field |
|------------------|-------------|
| YAML frontmatter `title:` | `title` |
| YAML frontmatter `tags: [...]` | `tags` (merged with inline) |
| YAML frontmatter `author:` | `author` |
| YAML frontmatter (all fields) | `metadata.frontmatter` |
| Inline `#tags` in content | `tags` (merged with frontmatter) |
| `[[wiki-links]]` | `metadata.links` array |
| File path relative to vault | `source` |
| Vault directory name | `namespace` |

### Usage Examples

```
Sync my Obsidian vault at ~/Documents/my-vault

Check vault sync status for ~/Documents/my-vault

Search my vault for "meeting action items about hiring"

Sync vault but only the notes/ and projects/ folders:
  vault_sync with include_patterns=["notes/**", "projects/**"]

Force re-sync everything (ignore modification times):
  vault_sync with force=true
```

### `vault_sync` Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `vault_path` | string | — | Absolute path to vault directory (required) |
| `chunk_size` | number | `1024` | Target chunk size for large files |
| `chunk_overlap` | number | `50` | Overlap between chunks |
| `force` | boolean | `false` | Re-sync all files regardless of mtime |
| `include_patterns` | string[] | — | Only sync matching globs (e.g., `["notes/**"]`) |
| `exclude_patterns` | string[] | — | Skip matching globs (e.g., `["templates/**"]`) |

### How Sync Works

1. Scans vault directory recursively for `.md` files (skips `.obsidian/`, `.trash/`, `.git/`)
2. Compares file modification times against last sync
3. For new/changed files: extracts frontmatter, wiki-links, tags → embeds → stores
4. For deleted files: removes memories and sync metadata
5. Large files (> chunk_size) are automatically chunked using markdown-aware splitting

### Incremental Sync

Only files that changed since last sync are re-processed. A `vault_sync_meta` table tracks file paths and modification times. Second sync of an unchanged vault takes <1ms.

---

## Security and Privacy

- **No network calls** after initial model download (cached locally)
- **No telemetry**, no analytics, no tracking
- **Hooks are opt-in** — Claude Code hooks are only installed when you explicitly run `npx mcp-memory-local init`. Without init, no hooks intercept tool calls
- **Nightly schedule is opt-in** — The consolidation schedule is only created during init and can be removed with `npx mcp-memory-local uninstall`
- **Single SQLite file** — easy to backup, move, or delete
- **Access level metadata** — tag memories as public/internal/confidential/restricted for organizational awareness
- Data never leaves your machine

### Backup

```bash
# Simple file copy
cp ~/.mcp-memory/memory.db ~/.mcp-memory/memory.db.backup

# Or use the export tool
# Ask Claude: "Export all memories from the legal department"
```

### Reset

```bash
# Delete the database to start fresh
rm ~/.mcp-memory/memory.db
```

---

## Nightly Consolidation

When installed via `npx mcp-memory-local init`, a nightly consolidation job runs all five dream cycle stages plus access log rotation (entries older than 90 days).

**macOS:** A launchd plist is created at `~/Library/LaunchAgents/com.mcp-memory.consolidate.plist`, scheduled to run at 3:00 AM.

**Linux:** During init, a cron entry suggestion is printed for you to add manually:

```bash
# Add to crontab -e
0 3 * * * /usr/local/bin/npx mcp-memory-local consolidate
```

To run the dream cycle manually at any time:

```bash
npx mcp-memory-local consolidate
```

---

## Limitations

- **~100K vectors max** — sqlite-vec is optimized for local use, not millions of records. For larger datasets, consider a dedicated vector database
- **384-dimension embeddings** — The default model (all-MiniLM-L6-v2) balances speed and quality. Larger models give better accuracy but are slower
- **English-optimized** — The default model works best with English text. Multilingual models (e.g., multilingual-e5) can be configured via `MCP_MEMORY_MODEL`
- **First query cold start** — ~3-5 seconds on first use while the embedding model loads (cached after that)
- **Heuristic extraction** — Learning extraction uses pattern matching, not an LLM. It catches common phrasing but may miss subtly expressed decisions or conventions

---

## Roadmap

### Planned: Additional Embedding Providers

- **OpenAI embeddings** — For users who prefer cloud-based embeddings with higher accuracy on complex content
- **Ollama local models** — Run larger embedding models locally via Ollama
- **Configurable per-scope** — Use fast local embeddings for high-volume scopes, cloud embeddings for critical knowledge

### Planned: Enhanced Vault Features

- **Bidirectional export** — Write memories back as `.md` files Obsidian can read
- **Backlink graph** — Use wiki-link relationships for multi-hop discovery
- **Auto-sync on change** — Optional file watcher for real-time sync

### Planned: Enhanced features

- **Auto-tagging** — LLM-generated tags and summaries on store
- **Multi-database** — Separate databases per project/team with cross-database search
- **Notion sync** — Bi-directional sync between the memory server and Notion workspaces (same pattern as vault sync)
- **Webhook system** — Outgoing webhooks on memory create/update/delete for Slack, Discord, or custom endpoints

---

## Tech Stack

| Component | Package | Purpose |
|-----------|---------|---------|
| MCP SDK | `@modelcontextprotocol/sdk` ^1.28.0 | Model Context Protocol server framework |
| Embeddings | `@huggingface/transformers` ^3.8.1 | Local ONNX model inference in Node.js |
| Database | `better-sqlite3` ^12.8.0 | Synchronous SQLite with native bindings |
| Vector search | `sqlite-vec` ^0.1.7 | Vec0 virtual table for KNN search |
| Validation | `zod` ^3.24.0 | Schema validation for tool inputs |
| IDs | `uuid` ^11.1.0 | UUID v4 generation for memory IDs |
| TypeScript | `typescript` ^5.7.2 | Strict mode, ES2022 target, Node16 modules |
| Frontend | React 19, Vite 8, Tailwind CSS v4 | Web dashboard SPA |
| UI components | shadcn/ui (base-ui) | 21 accessible component primitives |
| Fuzzy search | `fuse.js` ^7 | Client-side fuzzy autocomplete suggestions |
| Graph viz | `d3-force`, `d3-zoom`, `d3-drag` | Knowledge graph force-directed layout |

---

## License

MIT — see [LICENSE](./LICENSE).
