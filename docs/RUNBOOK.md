# Operational runbook

How to operate the MCP Memory Server in production. The reference deployment
is a single Docker container on MS-01 fronted by Cloudflare Access at
`mcp.yonasvalentin.dk`, with the SQLite database mounted on a host volume.

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
cd /opt/stacks/mcp-memory-server

docker compose up -d
docker compose down
docker compose restart memory-server
docker compose logs --tail=200 -f memory-server
```

The CI deploy workflow (`.github/workflows/deploy.yml`) does the equivalent
on every push to `main`: rsync workspace → `docker compose up -d --build` →
poll `/health`.

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

- `server_listening` — process startup, includes `host` and `port`.
- `auth_disabled` — emitted when `MCP_AUTH_TOKEN` is unset.
- `http_request` — every API request: `{requestId, route, method, status, duration_ms}`.
- `tool_call` — every MCP tool invocation: `{tool, outcome, duration_ms}`.
- `conflict_detect_failed`, `conflict_record_failed`, `entity_extract_failed` — store-path soft failures.
- `embedder_init_failed` — `/ready` couldn't load the model.
- `stop_hook_spawn_failed` — Stop hook couldn't spawn the headless reviewer.

### Metrics

```bash
curl -s -H "Authorization: Bearer $MCP_AUTH_TOKEN" http://127.0.0.1:3200/metrics
```

Counters: `mcp_tool_calls_total{tool,outcome}`, `api_requests_total{route,method,status}`.
Histograms: `mcp_tool_latency_seconds`, `api_request_latency_seconds`.

Wire into Grafana on MS-01 for production dashboards.

## Backups

The DB is a single SQLite file. Use the online backup API:

```bash
docker compose exec memory-server \
  sqlite3 /data/memory.db ".backup /data/backup-$(date +%Y%m%d).db"

docker compose cp memory-server:/data/backup-$(date +%Y%m%d).db /opt/backups/
```

Or via the host volume (volumes are mounted from named volume `mcp-data`):

```bash
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
schema_version|4
embedding_dim|384
```

### Refusing to start: "missing columns…"

The server detected a partial / legacy schema. The error message lists the
missing columns. Two paths forward:

1. **Restore from backup.** Replace the DB file with the latest backup.
2. **Recreate.** Move the DB aside and let the server initialize a fresh
   one. Use `memory_export` or `sqlite3 .dump` first to preserve content,
   then re-import via `memory_import`.

### Refusing to start: "Embedding dimension mismatch"

Either the DB was built with a different `MCP_MEMORY_DIMENSIONS`, or the
configured value drifted. Check the persisted value:

```bash
sqlite3 /data/memory.db "SELECT value FROM schema_meta WHERE key='embedding_dim'"
```

Set `MCP_MEMORY_DIMENSIONS` to that value, or rebuild the DB.

## Incident: duplicate detection looks broken

If two stores of the same content both succeed and `memory_conflicts` doesn't
grow, regression on C1. Reproduce with:

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

Expected: `{ r1: true, r2: false, conflicts: 1 }`. Anything else, ship a
revert and open a CRITICAL bug.

## Rolling back a deploy

```bash
ssh ms01
cd /opt/stacks/mcp-memory-server
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

- `UNAUTHORIZED` — missing or wrong bearer.
- `RATE_LIMITED` — bucket exhausted; honor `Retry-After`.
- `INVALID_INPUT` — Zod validation failed; `issues` has details.
- `NOT_FOUND` — the resource ID doesn't exist.
- `BAD_HOST` — DNS rebinding guard tripped.
- `INTERNAL` — anything else. Includes `requestId` to correlate with logs.

## Where things live on MS-01

- Compose file: `/opt/stacks/mcp-memory-server/docker-compose.yml`
- DB volume: `mcp-data` (named volume; data at `/var/lib/docker/volumes/mcp-data/_data`)
- Cache volume: `mcp-cache` (HF model cache)
- Cloudflare tunnel config: `/etc/cloudflared/config.yml`
