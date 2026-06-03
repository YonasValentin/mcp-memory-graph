# REST API & Ops (reference)

The HTTP surface (dashboard + JSON-RPC + public wiki) and the deploy/run story. The MCP stdio path needs none of this — use this when serving over HTTP or operating the MS-01 deploy.

> **Security:** never put a literal bearer token in code, logs, commits, or this skill. Always use the `$MCP_AUTH_TOKEN` env placeholder. The operator's live token lives only in their private config.

## Contents
1. REST endpoint contract
2. Auth, rate limiting, security
3. Docker / MS-01 deploy
4. Operator commands
5. Backup / restore / recover

---

## 1. REST endpoint contract

Base: `http://127.0.0.1:3100` (dev) / `https://mcp.yonasvalentin.dk` (prod, behind Cloudflare Access).

**Probe routes (public, no auth):**
| Method | Path | Notes |
|---|---|---|
| GET | `/live` | Liveness → `{status, uptime_s}` |
| GET | `/health` | Deep → `{status, db_ok, embedder_ok, schema_version, uptime_s}`; 503 if degraded |
| GET | `/ready` | Warms embedder; 200/503 |
| GET | `/metrics` | Prometheus; **Bearer** + gated by `MCP_METRICS_ENABLED=1`; 404 when disabled |

**`/api` routes (Bearer when token set; reuse the same handlers as the MCP tools):**
| Method | Path | Key params |
|---|---|---|
| GET | `/api/stats` | scope, namespace, department |
| GET | `/api/search` | `q`*, scope, namespace, department, document_type, tags(csv), language, mode(hybrid\|vector\|keyword), limit(1–100,d20), offset, min_confidence(0–1), date_from, date_to — **rerank OFF here** |
| GET | `/api/memories` | scope, namespace, department, document_type, limit, offset, sort_by, sort_order(d desc) |
| GET | `/api/memories/{id}` | path id*, include_chunks |
| PATCH | `/api/memories/{id}` | body: content, title, tags, metadata, expires_at, changed_by (413 if > `MCP_BODY_LIMIT`) |
| DELETE | `/api/memories/{id}` | path id* → `{deleted}` |
| GET | `/api/memories/{id}/versions` | limit(1–200,d50) |
| GET | `/api/memories/{id}/related` | limit(1–50,d10), min_similarity |
| GET | `/api/graph` | limit(1–500,d200), min_importance(0–1) |
| GET | `/api/manifest` | scope, namespace, department, document_type, limit(1–1000,d500), offset |

**MCP JSON-RPC:** `POST /mcp` (Bearer; per-session Streamable transport) — separate surface, not in openapi.yaml.

**Public wiki (unauthenticated, access-gated by data layer, not bearer):** `GET /publish/:namespace` (HTML index), `GET /publish/:namespace/graph` (JSON), `GET /publish/:namespace/search?q=` (JSON, side-effect-free), `GET /publish/:namespace/page/:id` (HTML). All routes are namespace-prefixed. Gated by `MCP_PUBLISH_ACCESS_LEVELS` (default `public`). *(These exist in `src/api/routes.ts` + `src/publish/wiki.ts`; openapi.yaml omits them.)*

**Error envelope:** `{ error, code, requestId, issues, retry_after_seconds }`. Codes: `UNAUTHORIZED`, `RATE_LIMITED` (honor `Retry-After`), `INVALID_INPUT` (Zod, `issues`), `NOT_FOUND`, `BAD_HOST` (DNS-rebind guard), `INTERNAL`.

## 2. Auth, rate limiting, security

- **Bearer** (`MCP_AUTH_TOKEN`), constant-time compared, gates `/api` + `/mcp`. **Fail-closed:** refuses to start on a non-loopback bind without a token unless `MCP_AUTH_OPTIONAL=1`. Boundary model = Cloudflare Access (ADR-0002, no per-user authz).
- **Rate limit:** dependency-free token bucket keyed on **socket peer** (not X-Forwarded-For unless `MCP_TRUSTED_IP_HEADER` set). `MCP_RATELIMIT_CAPACITY`(30)/`_REFILL_PER_SEC`(6); stricter `/publish` bucket. Single-process (in-memory).
- Middleware order: requestId → security-headers → localhost Host validation → `express.json(limit)` → CORS → rate-limit → bearer → publish limiter.
- `/metrics` needs its **own** bearer guard — if metrics enabled with no token, it's unauthenticated.

## 3. Docker / MS-01 deploy

Single container on MS-01; Cloudflare Access fronts `mcp.yonasvalentin.dk`. Host port **3200** → container 3100. Compose dir `/opt/stacks/mcp-memory-server`.
- **Volumes:** `mcp-data` (SQLite at `/data/memory.db`), `mcp-cache` (HF model cache, `HF_HOME=/cache`).
- **Env:** `MCP_AUTH_TOKEN`, `MCP_AUTH_OPTIONAL`, `MCP_METRICS_ENABLED=1`, `MCP_MEMORY_DB_PATH=/data/memory.db`, `MCP_MEMORY_DIMENSIONS` (must match persisted `embedding_dim`), `MCP_BODY_LIMIT`. `.env` at the compose dir.
- Dockerfile: `NODE_ENV=production`, unprivileged `node` user, read-only rootfs, `cap_drop ALL`, `MALLOC_ARENA_MAX=2`.
- **CI:** `.github/workflows/deploy.yml` on push→`main` → self-hosted MS-01 runner → rsync → `docker compose up -d --build` → poll `/health`.

## 4. Operator commands

```bash
ssh ms01 && cd /opt/stacks/mcp-memory-server
docker compose up -d                       # start
docker compose restart memory-server
docker compose logs --tail=200 -f memory-server          # JSON lines on stderr

curl -s http://127.0.0.1:3200/health | jq .
curl -s http://127.0.0.1:3200/ready                      # warm embedder
curl -s -H "Authorization: Bearer $MCP_AUTH_TOKEN" http://127.0.0.1:3200/metrics

docker compose logs --tail=500 memory-server | jq 'select(.level=="error")'
docker compose exec memory-server sqlite3 /data/memory.db "SELECT * FROM schema_meta"   # expect schema_version, embedding_dim
```
Metrics → Grafana: `mcp_tool_calls_total{tool,outcome}`, `api_requests_total{route,method,status}`, `mcp_tool_latency_seconds`, `api_request_latency_seconds`, `mcp_build_info{version,node}`.

## 5. Backup / restore / recover

```bash
# WAL-safe online backup → standalone .db (no -wal/-shm needed)
docker compose exec memory-server node dist/index.js backup --out /data/backup-$(date +%Y%m%d).db
docker compose cp memory-server:/data/backup-$(date +%Y%m%d).db /opt/backups/
```
- **Restore:** stop → copy backup over `/data/memory.db` → start.
- **"missing columns" (partial/legacy schema):** restore from backup, OR move DB aside and let init create fresh, preserving content first via `memory_export` / `sqlite3 .dump` then `memory_import`.
- **"Embedding dimension mismatch":** read `SELECT value FROM schema_meta WHERE key='embedding_dim'`, set `MCP_MEMORY_DIMENSIONS` to it.
- **Rollback deploy:** `git checkout <good-sha> && docker compose up -d --build && curl -fs .../health`, or re-run a prior successful GitHub Actions deploy.
- **Token rotation (~90d / on exposure):** `openssl rand -hex 32` → update `MCP_AUTH_TOKEN` in `.env` → `docker compose up -d --force-recreate` → verify → update clients. Single-token, no revocation list — old token dies on restart.
