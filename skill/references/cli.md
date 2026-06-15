# CLI reference

Run via `npx mcp-memory-graph <command>` (or the global binary if installed with `-g`). Under a non-interactive agent shell, `init` applies defaults and prints a report instead of prompting — pass flags or `--yes`.

## Commands

| Command | What it does |
|---------|--------------|
| `mcp-memory-graph` | Start the MCP server on stdio (the default; this is what Claude Code launches). |
| `mcp-memory-graph serve` | Start the HTTP server: MCP transport + REST API + web dashboard on one process. |
| `mcp-memory-graph init` | Setup wizard: register the 4 Claude Code hooks, write `config.json`, schedule nightly consolidation. User scope by default (fires in every session). |
| `mcp-memory-graph init --scope project` | Setup for the current project only; also writes `.claude/settings.json` and `.mcp.json` (auto-discovery for collaborators). |
| `mcp-memory-graph uninstall` | Reverse `init`: remove hooks and the nightly schedule. |
| `mcp-memory-graph consolidate` | Run the dream cycle manually (Score, Expire, Prune, Dedup, Gaps + access-log rotation). |
| `mcp-memory-graph backup [--out <path>]` | WAL-safe online snapshot. Retention via `MCP_MEMORY_MAX_BACKUPS` (default 10). |
| `mcp-memory-graph rebuild [--vault <path>]` | Rebuild the SQLite index from the vault's `.md` files. Collaborators run this after `git pull`; also how you re-embed after a model swap. |
| `mcp-memory-graph migrate` | Upgrade the database to the current schema version (auto-migrates forward on startup too). |
| `mcp-memory-graph vault-init [--vault <path>]` | Make the vault a git repo: union merge driver, `pull.rebase=false`, post-merge/post-checkout rebuild hooks. **Each collaborator runs this once in their own clone** (the driver lives in `.git/`, not the repo). Idempotent. |
| `mcp-memory-graph sync` | Export all valid memories + the graph sidecar to the vault as `.md`. (Import first if you hand-edited `.md` while the DB has newer state.) |
| `mcp-memory-graph export-graph [--out <path>] [--scope <s>] [--namespace <n>]` | Write a deterministic, committable `memory-graph.json` for git sharing. |
| `mcp-memory-graph git-setup` | Install the `.gitattributes` entry + `memory-union` merge driver for conflict-free graph sharing. |
| `mcp-memory-graph merge-graphs <ours> <theirs> <out>` | The union merge driver for `memory-graph.json` (invoked by git, not by hand). |
| `mcp-memory-graph keys create\|list\|revoke` | Per-key RBAC (schema v16): mint/inspect/revoke API keys, each pinned to a namespace set and an access-level ceiling. |

## `init` flags

| Flag | Effect |
|------|--------|
| `--scope <user\|project>` | Where hooks/config land. `user` (default) = all projects; `project` = this dir only (+ `.mcp.json`). |
| `--schedule HH:MM` | Nightly consolidation clock (24h). Re-run `init` after changing to regenerate the launchd plist. |
| `--vault <path>` | Obsidian vault root to wire up for sync/export/rebuild. |
| `--no-review-on-stop` | Disable the Stop-hook `claude -p` learning review (sets `review_on_stop:false`). |
| `--no-skill` | Skip writing the usage skill. |
| `--yes`, `-y` | Accept all defaults, no prompts (use in CI / agent shells). |
| `--remote <url>` | Wire the client to a shared self-hosted server over HTTP instead of a local file. Local capture hooks are not installed in remote mode. |
| `--token-env <NAME>` | (with `--remote`) reference this env var for the bearer token (default `MEMORY_MCP_TOKEN`). |
| `--token <value>` | (with `--remote`) inline a literal token — avoid committing it. |
| `--no-auth` | (with `--remote`) omit the auth header (loopback / trusted network only). |

## Team git-vault flow (quick)

```bash
npx mcp-memory-graph vault-init                 # once per clone
git add -A && git commit -m "memory snapshot" && git push
# collaborators after each pull:
git pull && npx mcp-memory-graph rebuild
```
If `rebuild` refuses with `VaultIntegrityError` after a hand-resolved merge, delete `.memory/manifest.json` (derived state) and re-run.
