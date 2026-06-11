# Workflows — driving the memory server

## Contents
1. The scope / namespace / privacy model (read first)
2. Solo: capture → recall
3. Team: git-shared vault
4. Auto-capture: Claude Code hooks
5. Maintenance: dream cycle, condense, forget
6. Ingest documents & Obsidian vaults
7. Multi-agent attribution

---

## 1. The scope / namespace / privacy model

Every memory has a **scope** and a **namespace**.

- **scope** ∈ `global` | `project` | `user` | `team` | `department`. Semantic, not enforced isolation.
- **namespace** sub-groups within scope. Default `"auto"` → derives from the project directory name.
- **department** — optional org axis (legal/sales/eng…), independent of scope.

**Privacy default (critical, easy to trip on):** an **unscoped** `memory_search` forcibly adds `scope != 'user'` — so `scope='user'` memories are **hidden** unless you search with explicit `scope:'user'`. If a memory "isn't found", this is the #1 cause. (Note: `memory_list`/`memory_export` do NOT apply this filter — they back backup/consolidation.)

**Forced namespace (shared HTTP endpoint):** when `MCP_API_NAMESPACE` is set, read/query tools are forced to that namespace and by-id reads are gated (foreign id → not-found / 404). This is how one shared HTTP server isolates callers — it is **not** concurrent multi-tenancy (single SQLite, process-wide namespace).

---

## 2. Solo: capture → recall

The everyday loop. No setup beyond registering the server.

**Capture** (be specific; let scope default or set it):
```
memory_store { content: "We chose RRF K=60 for hybrid fusion because it blends incommensurable vector+FTS scores without tuning.", document_type: "decision", tags: ["search","architecture"] }
```
- Discrete fact → `memory_store`. Large doc → `memory_ingest`. Structured note → `memory_template` then store.
- `on_conflict`: `add` (default — dedups at cosine 0.85), `update` (merge into the near-dup), `supersede` (retire the contradicted fact bi-temporally). The **NLI write-gate runs on every store** when wired: a genuine contradiction ("API uses 3000" vs "API does NOT use 3000") is detected and the old fact invalidated, not silently dropped.

**Recall:**
```
memory_search { query: "why did we pick our fusion algorithm", use_graph: true }
```
- `memory_search` is hybrid by default. Add `use_graph:true` for multi-hop. `rerank` is **ON by default at the MCP layer** (best precision, +~120–200ms) — pass `rerank:false` to go fast.
- Need a **compact answer**, not a hit list → `memory_query`.
- Know exact criteria → `memory_query_structured`.
- Don't know what's there → `memory_manifest` first.

---

## 3. Team: git-shared vault

"Team" here = a **git-shared Obsidian vault** (the Bruno model — `.md` files are the source of truth; the SQLite DB is a rebuildable cache). There is no shared SQL server.

**One-time setup (each member):**
```bash
npx mcp-memory-graph vault-init --vault ~/team-vault   # writes .gitattributes binding the union-merge driver — REQUIRED
```
`memory_export_vault` alone does NOT write `.gitattributes`; without `vault-init` the `.memory/graph.json` sidecar won't union-merge and concurrent edits collide.

**Daily flow:**
```bash
# work normally — memories mirror to vault .md via write-through (if enabled)
npx mcp-memory-graph sync --vault ~/team-vault   # flush DB → vault, write the graph sidecar
git add -A && git commit -m "memory: ..." && git push   # stages the vault .md + .memory/graph.json sidecar + .gitattributes
# teammate:
git pull
npx mcp-memory-graph rebuild --vault ~/team-vault   # rebuild the SQLite cache from the .md files
```

**Why it merges cleanly:** per-memory `.md` files get native 3-way git merge; only the `.memory/graph.json` sidecar needs the union driver (bound by `vault-init`). Timestamps are stamped ISO-Z so a tombstone never lexically out-sorts a later same-day edit.

**Merge requires a CLEAN working tree** (battle-v3 P-TEAM): `git pull`/`git merge` aborts with `"untracked working tree files would be overwritten by merge"` if a stale export or an aborted prior merge left incoming per-memory `.md` files untracked — the `.memory/graph.json` union driver itself merges fine; the friction is the `.md` files. Run `sync`+`commit` (or `git stash -u` / remove the stray files) so `git status` is clean **before** pulling. `vault-init` resolves the vault from `--vault` **or** `MCP_VAULT_PATH` **or** `config.json` (`vault.path`) — only the `--vault` form is shown above. (Heads-up: the package/binary name used here is `mcp-memory-graph`; the hook matcher in §4 uses the server name `memory-server` — don't conflate them.)

**Caveats:** `vault rebuild` **hard-deletes** the DB+WAL+SHM before rebuilding — the vault must be the source of truth. Vault `.md` round-trip resets `confidence`/`access`/`stability` signal columns (identity + content preserved) — not a full-fidelity backup. See gotchas.md.

---

## 4. Auto-capture: Claude Code hooks

`memory init` registers four opt-in lifecycle hooks (standalone node processes, 5s budget, fail-soft, exit 0):

| Hook | Fires | Does |
|---|---|---|
| SessionStart | session begins | Auto-recall status line (read-only DB) |
| PostToolUse (search) | after a memory search | Logs `results_count` → feeds `memory_consolidate` knowledge-gap detection |
| PreCompact | before context compaction | If `extract_on_compact` enabled → regex-mines the transcript → auto-captures learnings |
| Stop | turn ends | Spawns `review-and-store` (LLM, default-on) to capture session learnings |

**Setup:**
```bash
npx mcp-memory-graph init                  # user scope → ~/.claude/settings.json (all projects)
npx mcp-memory-graph init --scope project  # → .claude/settings.json + .mcp.json (collaborators auto-discover)
npx mcp-memory-graph init --yes            # accept defaults, non-interactive
npx mcp-memory-graph uninstall             # reverse
```
- The Stop hook spawns `claude -p` headless — the `claude` binary must be on `$PATH` or set `$CLAUDE_BIN`.
- The hook matcher hardcodes the server name `memory-server` (tool `mcp__memory-server__memory_search`). If you register the server under a different name, the hooks won't match.
- `init --project` is **not** the same as `--scope project` (known gotcha — verify the resulting scope).
- `init` (user scope) installs the hooks but does **not** register the MCP server — run `claude mcp add` (below) separately, or use `--scope project` which also writes `.mcp.json`.

**Custom DB location:** the DB file is resolved by the shared `resolveDbPath()` (`src/db/db-path.ts`) — precedence **explicit arg > `MCP_MEMORY_DB_PATH` env > `config.storage.db_path` > `~/.mcp-memory/memory.db`**. The server, CLI, REST API, **and** the SessionStart hook all go through it, so set the location **once** and every process (server + hooks + nightly launchd + CLI) honors it — no per-hook env threading, no launchd edit:
```bash
npx mcp-memory-graph init                  # answer the "Database path:" prompt with e.g. ~/Documents/.mcp-memory/memory.db
                                            # → written to config.storage.db_path; read by every process
claude mcp add memory-server node /path/to/dist/index.js          # register the server (no --env needed — it reads the config)
claude mcp add -s user memory-server node /path/to/dist/index.js  # for ALL projects
```
- Set `MCP_MEMORY_DB_PATH` to **override** the config for a one-off/ad-hoc DB (env wins over `config.storage.db_path`).

---

## 5. Maintenance: dream cycle, condense, forget

**Dream cycle** (nightly cron if `init` set it up, or on demand):
```
memory_consolidate { dry_run: true }    # preview: merges, prunes, score updates, knowledge gaps
memory_consolidate { }                  # apply
```
Then act on its report: `memory_condense` flagged candidates (preserves originals; `memory_restore` to undo), and check `memory_questions` for what to verify/learn next.

**Forget (GDPR):**
```
memory_forget { id, hard: false }   # soft tombstone — recoverable, still as_of-queryable
memory_forget { id, hard: true }    # returns a portability export FIRST, then erases (irreversible, cascades)
```
Use `memory_forget` (not `memory_delete`) for anything governance-related — `memory_delete` is a plain hard delete with no export.

---

## 6. Ingest documents & Obsidian vaults

**Document:**
```
memory_ingest { content: "<long doc>", content_type: "markdown" }   # auto-chunks, embeds each chunk, links via parent_id
```
content_type ∈ text|markdown|code|legal|structured. (`structured` silently falls back to paragraph chunking — see gotchas.)

**Obsidian vault in:**
```
vault_sync { vault_path: "~/Documents/my-vault" }     # incremental by mtime; reconciles by frontmatter id
vault_status { vault_path: "~/Documents/my-vault" }   # counts
vault_search { vault_path: "~/Documents/my-vault", query: "hiring action items" }
```
**Memories out → vault / board:**
```
memory_export_vault { vault_path: "~/Documents/my-vault" }   # .md + frontmatter
memory_canvas { vault_path: "~/Documents/my-vault", name: "knowledge" }   # JSON Canvas board
```

---

## 7. Multi-agent attribution

Set `agent_id` at store time (or `MCP_AGENT_ID` env). Then:
```
memory_attribution { }   # { by_agent, by_author, total } — who wrote what
```
`agent_id` (the writing agent) is distinct from `author` (the human/source). Memories stored without `agent_id` bucket under "unattributed".
