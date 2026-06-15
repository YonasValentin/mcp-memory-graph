# Config, env, scopes

## Config file

Controls self-improvement, hooks, and per-project overrides. Resolution order:
`MCP_MEMORY_CONFIG_PATH` env → `<cwd>/.mcp-memory/config.json` (project-scope init writes this) →
`~/.mcp-memory/config.json`. Created by `init`, or hand-written. Changes hot-reload (no restart).

```json
{
  "defaults": { "scope": "project", "namespace": "auto" },
  "projects": [
    { "path": "~/Documents/MyApp", "namespace": "my-app", "watch": ["README.md", "docs/**/*.md"] }
  ],
  "consolidation": {
    "similarity_threshold": 0.85,
    "prune_after_days": 30,
    "min_importance_to_keep": 0.1,
    "max_operations": 100,
    "schedule": [{ "hour": 3, "minute": 0 }]
  },
  "hooks": {
    "track_searches": true,
    "review_on_stop": true,
    "extract_on_compact": false,
    "extract_on_session_end": false
  },
  "extraction": { "categories": ["decision", "pattern", "error_fix", "convention"], "min_confidence": 0.4 },
  "storage": { "db_path": "~/.mcp-memory/memory.db" },
  "vault": { "path": "~/Documents/vault", "write_through": true }
}
```

| Section | Key | Default | Meaning |
|---------|-----|---------|---------|
| `defaults` | `scope` | `"project"` | Default scope for new memories. |
| `defaults` | `namespace` | `"auto"` | `"auto"` derives from the project directory name. |
| `projects[]` | `path` / `namespace` / `watch` | | Project root, namespace override, globs to track for changes. |
| `consolidation` | `similarity_threshold` | `0.85` | Cosine threshold for dedup (0.5–1.0). |
| `consolidation` | `prune_after_days` | `30` | Days before low-quality memories are eligible to prune. |
| `consolidation` | `min_importance_to_keep` | `0.1` | Minimum importance to survive pruning. |
| `consolidation` | `max_operations` | `100` | Cap per consolidation run. |
| `consolidation` | `schedule` | `[{hour:3,minute:0}]` | One or more `{hour,minute}` (24h). Re-run `init` after changes to regenerate the launchd plist. |
| `hooks` | `track_searches` | `true` | Log search hits/misses to `search-log.jsonl`. |
| `hooks` | `review_on_stop` | `true` | Spawn headless `claude -p` at session end to review and store learnings. `false` disables without removing the hook. |
| `hooks` | `extract_on_compact` | `false` | Regex mine before context compression. |
| `hooks` | `extract_on_session_end` | `false` | Regex extract at session end. |
| `extraction` | `categories` | decision/pattern/error_fix/convention | Learning categories to extract. |
| `extraction` | `min_confidence` | `0.4` | Minimum confidence for extracted learnings. |
| `storage` | `db_path` | scope-dependent | SQLite file (`~/.mcp-memory/memory.db` user; `<project>/.mcp-memory/memory.db` project). `MCP_MEMORY_DB_PATH` overrides. |
| `vault` | `path` | unset | Vault root for `vault_sync`/`memory_export_vault`/`rebuild` default. `MCP_VAULT_PATH` / `--vault` override. |
| `vault` | `write_through` | `true` | Mirror memory writes out to the vault as `.md`. `MCP_VAULT_WRITE_THROUGH=0` overrides. |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_MEMORY_DB_PATH` | `~/.mcp-memory/memory.db` | Database file location (directory auto-created). |
| `MCP_MEMORY_MODEL` | `Xenova/all-MiniLM-L6-v2` | HuggingFace embedding model (ONNX, Transformers.js). Changing it requires a `rebuild` / re-embed. |
| `MCP_MEMORY_DIMENSIONS` | `384` | Embedding dimensions; must match the model's output. |
| `MCP_MEMORY_CONFIG_PATH` | `~/.mcp-memory/config.json` | Override config file location. |
| `MCP_AUTH_TOKEN` | unset | Shared bearer token for `serve`. Required on any non-loopback bind (unless `MCP_AUTH_OPTIONAL=1`). |
| `MCP_BIND` | `127.0.0.1` | Bind address for `serve`. Use `0.0.0.0` only behind a TLS-terminating proxy. |
| `MCP_AGENT_ID` | unset | Attribution tag for `memory_attribution` (or pass `agent_id` per store). |
| `MCP_VAULT_PATH` / `MCP_VAULT_WRITE_THROUGH` | unset / `1` | Vault root / write-through toggle. |
| `MCP_WEBHOOKS` | off | Gate that enables `memory_webhook` event-bus tools. |
| `MCP_SIGN_MEMORIES` / `MCP_TRUSTED_PUBKEYS` | off | ed25519 provenance signing / multi-machine trust allowlist (see `memory_verify`). |
| `MCP_PUBLISH_ACCESS_LEVELS` | `public` | Access levels exposed by the read-only `/publish/:namespace` wiki. |
| `MCP_MEMORY_MAX_BACKUPS` | `10` | Backup retention count. |

> Full env reference (rate limits, all vault/publish/webhook keys) lives in the package's `docs/ENV.md`.

## Scopes and metadata

**Scopes** isolate memories within one database: `global` | `project` | `user` | `team` | `department`.
`namespace` groups content within a scope (e.g. `"my-project"`, `"legal-team"`). A shared-database
`MCP_API_NAMESPACE` pin gives per-namespace multi-tenant isolation; a separate DB file per tenant is the strongest boundary.

Every memory carries: `scope`, `namespace`, `department`, `document_type` (contract/policy/code/incident/decision/report…),
`access_level` (`public`/`internal`/`confidential`/`restricted`, default `internal`), `tags[]`, `language` (ISO 639-1),
`source`, `author`, free-form `metadata` JSON, and optional `expires_at` (ISO 8601). `metadata._vault` is reserved
(internal sync bookkeeping; never surfaces in output).

**Bi-temporal:** updates invalidate rather than overwrite — the prior fact gets a `valid_to` stamp, so history is never
lost. Reads default to currently-valid rows; pass `as_of:<timestamp>` for point-in-time recall.
