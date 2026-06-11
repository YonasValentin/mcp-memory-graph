# Operational runbook

How to operate the MCP Memory Graph in production. The reference deployment
is a single Docker container on MS-01, fronted by Cloudflare Access at
`mcp.yonasvalentin.dk`. The SQLite database is mounted on a host volume.

## Surface area

| Endpoint | Purpose | Auth |
|---|---|---|
| `POST /mcp` | MCP JSON-RPC entry point | Bearer |
| `GET /api/...` | REST surface for the dashboard | Bearer |
| `GET /health` | Deep probe (DB + schema_version + embedder warm-state) | Public |
| `GET /live` | Liveness only | Public |
| `GET /ready` | Warms the embedder and reports ready/not-ready | Public |
| `GET /metrics` | Prometheus exposition | Bearer (when configured) + `MCP_METRICS_ENABLED=1` |

## Day-to-day

### Start / stop

```bash
ssh ms01
cd /opt/stacks/mcp-memory-graph

docker compose up -d
docker compose down
docker compose restart memory-server
docker compose logs --tail=200 -f memory-server
```

The CI deploy workflow (`.github/workflows/deploy.yml`) does the equivalent
on every push to `main`: rsync the workspace, then `docker compose up -d --build`,
then poll `/health`.

### Health checks

```bash
curl -s http://127.0.0.1:3200/health | jq .
# { status, db_ok, embedder_ok, schema_version, uptime_s }

curl -s http://127.0.0.1:3200/live
# { status: "ok", uptime_s }

# Force the embedder to warm up:
curl -s http://127.0.0.1:3200/ready
```

### Tail structured logs

```bash
docker compose logs --tail=500 memory-server | jq '.'
docker compose logs --tail=500 memory-server | jq 'select(.level=="error")'
docker compose logs --tail=500 memory-server | jq 'select(.event=="http_request" and .status>=400)'
```

The logger writes one JSON line per event to stderr. Useful event names:

- `server_listening`: process startup. Includes `host` and `port`.
- `auth_disabled`: emitted when `MCP_AUTH_TOKEN` is unset.
- `http_request`: every API request. Fields: `{requestId, route, method, status, duration_ms}`.
- `tool_call`: every MCP tool invocation. Fields: `{tool, outcome, duration_ms}`.
- `conflict_detect_failed`, `conflict_record_failed`, `entity_extract_failed`: store-path soft failures.
- `embedder_init_failed`: `/ready` could not load the model.
- `stop_hook_spawn_failed`: Stop hook could not spawn the headless reviewer.

### Metrics

```bash
curl -s -H "Authorization: Bearer $MCP_AUTH_TOKEN" http://127.0.0.1:3200/metrics
```

Info gauge: `mcp_build_info{version,node}`. Constant 1. The labels pin which
version and runtime is live. Use it for "version deployed" panels and alert
annotations.
Counters: `mcp_tool_calls_total{tool,outcome}`, `api_requests_total{route,method,status}`.
Histograms: `mcp_tool_latency_seconds`, `api_request_latency_seconds`.

Wire into Grafana on MS-01 for production dashboards. Suggested panels:

- `rate(mcp_tool_calls_total{outcome="error"}[5m])` (tool error rate)
- `histogram_quantile(0.95, rate(api_request_latency_seconds_bucket[5m]))` (p95 latency)
- a stat panel on `mcp_build_info` to show the running version

## Backups

The DB is a single SQLite file. Preferred method: the built-in WAL-safe
online backup. It uses SQLite's Online Backup API, so you get a consistent
snapshot with no writer blocking and no checkpoint required:

```bash
# Writes <db>.backup-<ISO> next to the DB, or pass --out.
docker compose exec memory-server node dist/index.js backup --out /data/backup-$(date +%Y%m%d).db
docker compose cp memory-server:/data/backup-$(date +%Y%m%d).db /opt/backups/
```

Restore, in this order:

1. Stop the server.
2. Copy the backup file over `MCP_MEMORY_DB_PATH` (`/data/memory.db`).
3. Start the server again.

The backup is a standalone `.db`. No `-wal`/`-shm` sidecars needed.

Equivalent ad-hoc options (no running container):

```bash
# Online backup via sqlite3 CLI inside the container
docker compose exec memory-server sqlite3 /data/memory.db ".backup /data/backup-$(date +%Y%m%d).db"

# Or from the named volume directly
docker run --rm -v mcp-data:/data -v $(pwd):/dump alpine \
  sh -c 'apk add --no-cache sqlite && sqlite3 /data/memory.db ".backup /dump/backup.db"'
```

## Schema operations

### Inspect schema state

```bash
docker compose exec memory-server \
  sqlite3 /data/memory.db "SELECT * FROM schema_meta"
```

Expected output:

```
schema_version|18
embedding_dim|384
```

`schema_version` should read 18 (or higher; migrations are automatic).

### Refusing to start: "missing columns…"

The server detected a partial or legacy schema. The error message lists the
missing columns. Two paths forward:

1. **Restore from backup.** Replace the DB file with the latest backup.
2. **Recreate.** Move the DB aside and let the server initialize a fresh
   one. Use `memory_export` or `sqlite3 .dump` first to preserve content,
   then re-import via `memory_import`. Skipping the export loses the data.

### Refusing to start: "Embedding dimension mismatch"

Either the DB was built with a different `MCP_MEMORY_DIMENSIONS`, or the
configured value drifted. Check the persisted value:

```bash
sqlite3 /data/memory.db "SELECT value FROM schema_meta WHERE key='embedding_dim'"
```

Set `MCP_MEMORY_DIMENSIONS` to that value, or rebuild the DB.

## Incident: duplicate detection looks broken

If two stores of the same content both succeed and `memory_conflicts` does
not grow, that is a regression on C1. Reproduce with:

```bash
docker compose exec memory-server node -e '
  import("/app/dist/testing/test-db.js").then(({createTestDb}) => {
    import("/app/dist/testing/mock-embedder.js").then(({MockEmbeddingProvider}) => {
      import("/app/dist/tools/store.js").then(async ({handleStore}) => {
        const db = createTestDb();
        const e = new MockEmbeddingProvider();
        const r1 = await handleStore(db, e, { content: "test" });
        const r2 = await handleStore(db, e, { content: "test" });
        console.log({r1: r1.stored, r2: r2.stored, conflicts: r2.conflicts?.length});
      });
    });
  });
'
```

Expected: `{ r1: true, r2: false, conflicts: 1 }`. Anything else: ship a
revert and open a CRITICAL bug.

## Rolling back a deploy

```bash
ssh ms01
cd /opt/stacks/mcp-memory-graph
git log --oneline -5         # find the previous good SHA
git checkout <sha>
docker compose up -d --build
curl -fs http://127.0.0.1:3200/health
```

Or use the GitHub Actions UI to re-run a previous successful deploy
workflow.

## Common error envelopes

REST errors use a uniform shape:

```json
{
  "error": "Memory not found",
  "code": "NOT_FOUND",
  "requestId": "9f3a1c…",
  "issues": { "fieldErrors": { "...": [...] } }
}
```

Codes:

- `UNAUTHORIZED`: missing or wrong bearer.
- `RATE_LIMITED`: bucket exhausted. Honor `Retry-After`.
- `INVALID_INPUT`: Zod validation failed. `issues` has details.
- `NOT_FOUND`: the resource ID does not exist.
- `BAD_HOST`: DNS rebinding guard tripped.
- `INTERNAL`: anything else. Includes `requestId` to correlate with logs.

## Where things live on MS-01

- Compose file: `/opt/stacks/mcp-memory-graph/docker-compose.yml`
- DB volume: `mcp-data` (named volume; data at `/var/lib/docker/volumes/mcp-data/_data`)
- Cache volume: `mcp-cache` (HF model cache)
- Cloudflare tunnel config: `/etc/cloudflared/config.yml`

## Bearer Token Rotation

1. Generate a new token: `openssl rand -hex 32`
2. Update `MCP_AUTH_TOKEN` in `/opt/stacks/mcp-memory-graph/.env` on MS-01
3. `docker compose up -d --force-recreate memory-server`
4. Verify: `curl -fs -H "Authorization: Bearer $NEW" http://127.0.0.1:3200/health`
5. Update the token in Claude Code MCP config (`~/.claude/settings.json`) and propagate to team members
6. The previous token is invalidated on container restart. Single-token design, no revocation list needed.

Rotate every 90 days, or immediately on suspected exposure.
