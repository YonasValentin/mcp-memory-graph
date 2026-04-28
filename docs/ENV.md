# Environment variables

Every `MCP_*` variable read by the server, with default and effect. Settings
read once at process start unless noted.

## Networking & auth

| Variable | Default | Effect |
|---|---|---|
| `MCP_PORT` | `3100` | TCP port for `serve` mode. |
| `MCP_BIND` | `127.0.0.1` | Interface to bind on. Set to `0.0.0.0` to expose externally; this requires `MCP_AUTH_TOKEN` (or `MCP_AUTH_OPTIONAL=1`) at startup. |
| `MCP_AUTH_TOKEN` | _unset_ | Bearer token. When set, every request to `/api/*` and `/mcp/*` must carry `Authorization: Bearer <token>` (constant-time comparison). |
| `MCP_AUTH_OPTIONAL` | _unset_ | Set to `1` to allow unauthenticated access on a non-loopback bind. Should only be used in trusted local networks. |
| `MCP_ALLOWED_ORIGINS` | `http://localhost:5173` | Comma-separated allowlist for CORS. Origins not in the list receive no `Access-Control-Allow-Origin` header. |
| `MCP_BODY_LIMIT` | `256kb` | Maximum JSON body size for any request. Larger payloads return 413. |

## Rate limiting

| Variable | Default | Effect |
|---|---|---|
| `MCP_RATELIMIT_CAPACITY` | `30` | Token-bucket capacity per IP (burst size). |
| `MCP_RATELIMIT_REFILL_PER_SEC` | `6` | Sustained refill rate. |
| `MCP_RATELIMIT_DISABLED` | _unset_ | Set to `1` to bypass rate limiting entirely. |

## Health & metrics

| Variable | Default | Effect |
|---|---|---|
| `MCP_METRICS_ENABLED` | _unset_ | Set to `1` to expose `/metrics` (Prometheus exposition). When set with `MCP_AUTH_TOKEN`, the bearer is required. |
| `MCP_HEALTH_REQUIRE_EMBEDDER` | _unset_ | Set to `1` to make `/health` return 503 until the embedder is warmed up. By default the DB check alone is enough. |

## Storage & paths

| Variable | Default | Effect |
|---|---|---|
| `MCP_MEMORY_DB_PATH` | `~/.mcp-memory/memory.db` | SQLite database file. Parent directory is created if it doesn't exist. |
| `MCP_MEMORY_CONFIG_PATH` | `~/.mcp-memory/config.json` | Config file consumed by hooks and the consolidate CLI. |
| `MCP_MEMORY_CWD` | _unset_ | Override the current working directory used by hook scripts. Set internally by the Stop hook. |
| `MCP_MEMORY_TRANSCRIPT_BASE` | `~/.claude/projects` | Allowlisted base directory for the Stop hook's `transcript_path`. Anything outside this base is rejected. |

## Embedding

| Variable | Default | Effect |
|---|---|---|
| `MCP_MEMORY_MODEL` | `Xenova/all-MiniLM-L6-v2` | Hugging Face model identifier loaded via `@huggingface/transformers`. |
| `MCP_MEMORY_DIMENSIONS` | `384` | Vector dimension for `memories_vec`. Persisted in `schema_meta.embedding_dim` on first init; mismatched values throw on subsequent opens. |
| `HF_HOME` | _unset_ | Cache directory for the Hugging Face model (set in Docker to `/cache`). |

## Hooks (set automatically by the Stop hook chain)

| Variable | Default | Effect |
|---|---|---|
| `MCP_MEMORY_REVIEW_IN_PROGRESS` | _unset_ | Re-entry guard: when set, Stop hook exits immediately. Prevents infinite recursion when the headless reviewer's own Stop hook fires. |
| `MCP_MEMORY_SESSION_ID` | _unset_ | Forwarded to the background extractor for source-tagging. |
| `CLAUDE_BIN` | `claude` | Override the Claude Code binary used by the headless reviewer. |

## Logging

| Variable | Default | Effect |
|---|---|---|
| `MCP_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. Logs are JSON lines on stderr. Sensitive keys (`Authorization`, `password`, `secret`, `api_key`, `cookie`) are redacted automatically. |

## Production checklist

For a non-loopback deployment behind Cloudflare Access / NGINX:

```bash
export MCP_AUTH_TOKEN="$(openssl rand -base64 32)"
export MCP_ALLOWED_ORIGINS="https://mem.example.com"
export MCP_BIND=0.0.0.0
export MCP_BODY_LIMIT=512kb
export MCP_RATELIMIT_CAPACITY=120
export MCP_RATELIMIT_REFILL_PER_SEC=24
export MCP_METRICS_ENABLED=1
export MCP_LOG_LEVEL=info
```
