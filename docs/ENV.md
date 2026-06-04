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
| `MCP_API_NAMESPACE` | _unset_ | Multi-tenancy: when set, BOTH the MCP stdio tools and the REST API force every read/write to this namespace, overriding any caller-supplied value (read AND write isolation). Unset (or empty string) → no forced scoping; the single-user stdio default. |
| `NODE_ENV` | _unset_ | When `production`, API error responses omit the `detail` field (no internal error messages leak to clients). |

## Security headers

| Variable | Default | Effect |
|---|---|---|
| `MCP_HSTS_DISABLED` | `0` | Set to `1` to skip the `Strict-Transport-Security` header (e.g. plain-HTTP test rigs). |
| `MCP_HSTS_MAX_AGE` | `15552000` (180 days) | `max-age` for the HSTS header, in seconds. |
| `MCP_CSP_DISABLED` | `0` | Set to `1` to skip the Content-Security-Policy header (debug only). |
| `MCP_CSP_EXTRA_CONNECT` | _unset_ | Extra space-separated origins appended to the CSP `connect-src` directive (e.g. `https://api.example.com`). |

## Publish / memory wiki

| Variable | Default | Effect |
|---|---|---|
| `MCP_PUBLISH_ACCESS_LEVELS` | `public` | Comma-separated `access_level` allowlist for the read-only `/publish/:namespace` wiki. Only memories at these levels are reachable via the index, page-by-id, search, or graph. Defaults to `public`-only. |

## Rate limiting

| Variable | Default | Effect |
|---|---|---|
| `MCP_RATELIMIT_CAPACITY` | `30` | Token-bucket capacity per IP (burst size) for the `/api` + `/mcp` surfaces. |
| `MCP_RATELIMIT_REFILL_PER_SEC` | `6` | Sustained refill rate for the `/api` + `/mcp` limiter. |
| `MCP_PUBLISH_RATELIMIT_CAPACITY` | `15` | Token-bucket capacity per IP for the read-only `/publish/:namespace` wiki (stricter than the API surface). |
| `MCP_PUBLISH_RATELIMIT_REFILL_PER_SEC` | `2` | Sustained refill rate for the `/publish` limiter. |
| `MCP_RATELIMIT_DISABLED` | _unset_ | Set to `1` to bypass rate limiting entirely. |
| `MCP_TRUSTED_IP_HEADER` | _unset_ | Name of a TRUSTED, proxy-set header (e.g. `x-real-ip`) to read the client IP from for per-IP rate limiting when behind a reverse proxy. Unset → the socket peer address is used. Only enable when a proxy you control sets this header. |

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
| `MCP_VAULT_PATH` | _unset_ (→ `config.vault.path`) | Obsidian vault root for `rebuild` and vault CLI commands. Falls back to `vault.path` in `config.json`; a `--vault <path>` flag overrides both. |
| `MCP_VAULT_WRITE_THROUGH` | _unset_ (on) | Set to `0` to disable mirroring memory writes out to the vault as `.md` files. Default is write-through enabled (when a vault is configured). |

## Embedding

| Variable | Default | Effect |
|---|---|---|
| `MCP_MEMORY_MODEL` | `Xenova/all-MiniLM-L6-v2` | Hugging Face model identifier loaded via `@huggingface/transformers`. |
| `MCP_MEMORY_DIMENSIONS` | `384` | Vector dimension for `memories_vec`. Persisted in `schema_meta.embedding_dim` on first init; mismatched values throw on subsequent opens. |
| `MCP_MEMORY_NLI_MODEL` | `Xenova/nli-deberta-v3-xsmall` | Cross-encoder NLI model used for contradiction detection in the self-correcting write gate. Loaded lazily on first use. |
| `MCP_MEMORY_RERANKER_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Cross-encoder model used when search is called with `rerank: true`. Loaded lazily on first use. |
| `HF_HOME` | _unset_ | Cache directory for the Hugging Face model (set in Docker to `/cache`). |

## Trust & provenance (M2)

| Variable | Default | Effect |
|---|---|---|
| `MCP_REDACT_MODE` | `off` | Inbound secret-redaction gate applied before content is embedded/persisted (and before it can reach a git-shared vault). `scrub` replaces detected secrets (API keys, tokens, JWTs, PEM private keys, `password=`/`api_key=` assignments) with typed `[REDACTED:kind]` placeholders and records a `metadata.redactions` count; `block` rejects the write with an error naming the kinds; `off` is a passthrough. Wired into `memory_store` and `memory_ingest`. |
| `MCP_SIGN_MEMORIES` | _unset_ (off) | Set to `1`/`true` to attach a signed provenance envelope to every new memory: an ed25519 signature over `content_hash + agent_id + scope + namespace + created_at`. `memory_verify` checks it. Off = memories are stored unsigned (today's behaviour); `memory_verify` reports them as `unsigned`. |
| `MCP_MEMORY_KEY_DIR` | `~/.mcp-memory` | Directory holding the ed25519 signing keypair (`keys/ed25519.key` 0600, `keys/ed25519.pub`). Generated on first signed write. Override for tests or to relocate the key. |
| `MCP_TRUSTED_PUBKEYS` | _unset_ | `:`- or `,`-separated list of FILE PATHS to teammate SPKI PEM public keys. `memory_verify` accepts a memory signed by this machine's own key OR any of these — a teammate's valid signature on a synced vault reads `verified` instead of `untrusted`. Unreadable paths are skipped. |

## Active infrastructure (M3)

| Variable | Default | Effect |
|---|---|---|
| `MCP_WEBHOOKS` | _unset_ (off) | Set to `1`/`true` to enable the outbound event bus — the first network egress in this otherwise local-first server. Mutations then enqueue HMAC-signed deliveries to registered `memory_webhook` targets (all SSRF-validated: public http(s) only). Off = no targets fire, zero hot-path cost. |

## Compute governor (M6.2)

| Variable | Default | Effect |
|---|---|---|
| `MCP_COMPUTE_GOVERNOR_MODE` | `off` | Graceful-degradation governor over the heavy per-request ML ops. `off` = always allow (no-op). `warn` = allow but flag over-budget. `throttle` = once over budget, skip reranking (search → free vector+FTS RRF) and the NLI gate (store → overlap heuristic only) — a quality downgrade, never an error. `block` = like throttle but also sets `denied` so a caller may refuse. |
| `MCP_COMPUTE_GOVERNOR_CAPACITY` | `600` | Burst budget in token units (embed=1, rerank=3, nli=4). |
| `MCP_COMPUTE_GOVERNOR_REFILL_PER_SEC` | `60` | Sustained refill rate (token units/sec); window = capacity / refill. |

## Pluggable embeddings (M6.4)

| Variable | Default | Effect |
|---|---|---|
| `MCP_MEMORY_DIMENSIONS` | `384` | (See Embedding.) `memories_vec` is single-fixed-dim; a second model must reconcile to this dimension (Matryoshka `truncateTo`) or use a per-model vec table. The pluggable `EmbeddingRegistry` forces the LOCAL provider for `confidential`/`restricted` access regardless of preference. |

## Attribution

| Variable | Default | Effect |
|---|---|---|
| `MCP_AGENT_ID` | _unset_ (→ `null`) | Default `agent_id` stamped on every `memory_store` write when the call doesn't pass one. Lets a whole deployment auto-tag its writes for `memory_attribution` rollups; unset means no attribution (existing behaviour). |

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
