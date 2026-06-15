# Advanced subsystems

RBAC, multi-tenancy, the dream cycle, webhooks, provenance, and reranker/temporal tuning.
The everyday index is `../SKILL.md`; tools in `tools.md`; CLI in `cli.md`; env/scopes in `config.md`.

## Reranker tradeoffs

`memory_search` runs hybrid (vector+keyword RRF), then an optional **local cross-encoder
rerank** (`Xenova/ms-marco-MiniLM-L-6-v2`) that re-sorts the top candidates by joint
`(query, document)` relevance.

- **Default ON for the MCP surface** (`server.ts` sets `rerank: parsed.rerank ?? true`). It is
  the biggest precision win over the 384-dim MiniLM base embedder; the model lazy-loads on
  first use. Programmatic/REST callers that leave `rerank` unset do **not** rerank.
- **Latency:** roughly a *constant* ~230 ms add (per `docs/BENCHMARKS.md`), independent of corpus
  size — it only re-scores `rerank_top_n` candidates (default 50, max 200).
- **Where it helps:** the harder, longer-context sets. LongMemEval recall@1 60.0% → 92.2%;
  LOCOMO session R@10 lands at 82.2% (the shipping model beat L-12 and jina-turbo in the A/B).
- **Where it can HURT (honest note):** very short, single-message corpora scored by exact-substring
  presence — on ConvoMem's easy `1_evidence` slice rerank dropped overall recall 93.5% → 86.2%
  (−7.3 pts) because semantic reordering can demote the literal evidence message.
- **Per-call lever:** pass `rerank:false` on `memory_search` to skip it; `rerank_top_n:<n>` widens
  coverage (slower). There is no global config toggle — it is per call (default ON at MCP).

## Consolidate (the dream cycle)

`memory_consolidate` (CLI: `mcp-memory-graph consolidate`) runs five stages over one
`(scope, namespace)` partition. **Always run `dry_run:true` first**, inspect the report, then run for real.

1. **Score** — recompute `importance_score`/quality from access patterns (an access-rank multiplier:
   `0.4 * access_count / MAX(access_count)` in the partition).
2. **Expire** — delete memories past `expires_at` (gated by `prune_expired`, default `true`).
3. **Prune** — remove low importance + low confidence rows (gated by `prune_low_quality`, default
   `false`; floor is config `consolidation.min_importance_to_keep`, default `0.1`).
4. **Dedup** — merge near-duplicates above `similarity_threshold` (cosine, default `0.85`, range 0.5–1.0).
5. **Gaps** — surface repeated zero-result queries (from `search_log`) as knowledge gaps.

Tool params: `similarity_threshold` (0.85), `prune_expired` (true), `prune_low_quality` (false),
`dry_run` (false), `max_operations` (100, cap per run), `scope`/`namespace` (limit the run),
`forgetting_floor` (opt-in spaced-repetition prune of weakly-held rows — runs a Decay stage first).

> `min_importance_to_keep` and `prune_after_days` are **config keys** (`consolidation.*` in
> `config.json`), not tool params. See `config.md`.

**Access reinforcement (live, every search hit):** each access bumps the memory
`importance_score + 0.03` (capped at 1.0) and grows its `stability` — so frequently-recalled facts
rise and resist the forgetting-curve prune; rarely-touched ones decay toward eligibility.

## RBAC keys (schema v16)

Per-key RBAC lets ONE running server serve many tenants: N API keys, each pinned to a namespace
*set* and an **access-level ceiling**. Managed by the CLI:

```bash
# Mint a key. The raw token prints EXACTLY ONCE — store it now.
mcp-memory-graph keys create --principal sales-bot --namespaces sales,marketing \
    --max-access-level confidential [--expires 2030-01-01T00:00:00Z]
mcp-memory-graph keys list                    # table of all keys; never prints token/hash
mcp-memory-graph keys revoke <id>             # stamps revoked_at (next request, no restart)
```

- `--principal <name>` and `--namespaces <a,b,c>` are required; element `[0]` is the key's **default**
  namespace. `--max-access-level` is one of `public|internal|confidential|restricted` (default `internal`).
  `--expires <ISO8601>` optional.
- The token is `mcpm_…` (sha256-hashed at rest, shown once; the prefix lets secret-scanners catch leaks).
- **Auth resolution:** a `Bearer` equal to the legacy `MCP_AUTH_TOKEN` is checked **first** (legacy
  single-token mode, no principal). Otherwise the token is resolved against `api_keys`; a live match
  attaches that key's principal. Otherwise `401`. The live-key count is read on every request (no cache).
- **Namespace:** a foreign namespace is **`403 NAMESPACE_NOT_PERMITTED`**, never silently redirected.
- **Ceiling (egress):** `public < internal < confidential < restricted`. Rows above the key's ceiling are
  invisible in search/list/get/related/query/export. A by-id read of an over-ceiling **or** foreign row
  returns **404** (no existence oracle), not 403.
- **v1 scope:** the ceiling covers the corpus read surface; **graph/vault/insights ceilings are deferred
  to v2** — until then those are bounded by namespace isolation only.

## Multi-tenancy

Three deployment shapes, weakest → strongest isolation (full detail: `docs/MULTI-TENANCY.md`):

- **Single user, local** (default, `MCP_API_NAMESPACE` unset) — one trusted person/project per DB file.
- **Shared DB, one namespace pinned** via `MCP_API_NAMESPACE` (schema v14) — every read/write is forced
  to the pinned namespace; per-namespace isolation covers corpus *and* the five graph tables
  (entities, aliases, relationships, links, conflicts). Entity identity is keyed `(normalized_name, namespace)`.
- **Per-key RBAC** (schema v16) — many tenants on one process, one key each (above).
- **One DB file per tenant** — the strongest boundary: no shared state to reason about. Use for
  mutually-distrusting tenants / strict compliance.

`scope` (`global|project|user|team|department`) isolates *within* one DB; `namespace` groups *within* a
scope and is the multi-tenant wall. Inside one namespace there is **no per-user identity**: `author` is
honor-system, teammates can edit/delete each other's rows (recorded in `changed_by`), and `scope:'user'`
only hides a row from *unscoped* search. If teammates must not affect each other's data, give them
different namespaces (per-key) or separate DB files.

## Webhooks / event bus

Off by default — the first network egress in this local-first server. Enable with `MCP_WEBHOOKS=1`
(or `true`). Then mutations enqueue deliveries to registered targets. Driven by `memory_webhook`:

```jsonc
// register a target (URL is SSRF-validated: public http(s) only)
memory_webhook { action: "register", url: "https://hooks.example.com/mem",
                 secret: "shared-hmac-secret",
                 events: "memory.created,memory.superseded",   // or "*" for all
                 namespace: "eng" }                            // optional scope/namespace filter
memory_webhook { action: "list" }
memory_webhook { action: "delete", id: "<target id>" }
memory_webhook { action: "dispatch" }                          // drain the queue now
```

- **`action`** = `register | list | delete | dispatch` (default `list`); `url`, `secret`, `events`,
  `scope`, `namespace`, `id`.
- **Event types:** `memory.created`, `memory.updated`, `memory.superseded`, `memory.deleted`,
  `memory.forgotten`. The payload carries metadata only (`id`, `scope`, `namespace`, `document_type`,
  `access_level`, `agent_id`, `version`) — **never content or title**; a sink fetches the body over the
  authenticated REST API by id.
- **SSRF guard:** targets must be public http(s); private/loopback/link-local (incl. `169.254.169.254`
  metadata) are refused at register time AND at send time (resolved IP re-validated, connection pinned to
  that IP — no DNS-rebinding window, no redirects followed).
- **Delivery:** HMAC-SHA256 signed (`X-Memory-Signature: sha256=<hex>` when a `secret` is set), crash-durable
  queue with atomic claim, exponential-backoff retry (up to 6 attempts), per-target circuit breaker, and
  dead-lettering. A slow/dead sink never blocks a memory write (enqueue is the write path; HTTP send is the
  dispatcher's job). Health rolls up in `memory_health`.

## Provenance / verify

Off by default. `MCP_SIGN_MEMORIES=1` attaches a signed provenance envelope to every new memory: an
**ed25519** signature over `content_hash + agent_id + scope + namespace + valid_from + created_at`
(`provenance` is intentionally excluded so post-insert stamping doesn't false-flag tampering).

`memory_verify` recomputes each hash and ed25519-checks the signature against **this machine's** trust
root. Verify one by `id` or a batch by `scope`/`namespace`. Per-memory status:

- `verified` — hash matches and the signature verifies under a trusted key.
- `unsigned` — no signature (signing was off when stored).
- `tampered` — signed but content was edited (content_mismatch) or the signature was forged (bad_signature).
- `untrusted` — validly signed, but by a key that is not this machine's trust root (e.g. a teammate on a
  synced vault) — distinct from `tampered`.

Trust other machines' keys via `MCP_TRUSTED_PUBKEYS` (`:`- or `,`-separated FILE PATHS to teammate SPKI
PEM public keys) or pass `trusted_pubkeys` (inline PEM array) on the `memory_verify` call — a teammate's
valid signature then reads `verified` instead of `untrusted`.

## Temporal decay

`memory_search` accepts `temporal_decay` to favor recent memories. Shapes:

```jsonc
memory_search { query: "...", temporal_decay: { type: "exponential", half_life_days: 30 } }
memory_search { query: "...", temporal_decay: { type: "linear",      max_age_days: 90 } }
```

`type` is `exponential` (needs `half_life_days`), `linear` (needs `max_age_days`), `none`, or
`forgetting` (Ebbinghaus spaced-repetition curve). Pair with `min_groundedness` to also demand
well-sourced (high-provenance, recent) results.

## Worked examples

### Org-wide brain (one self-hosted server, a key per employee)

One shared server over one DB file; mint a scoped key per person; declare the org chart as a graph
(full recipe: `docs/ENTERPRISE-BRAIN.md`).

```bash
# 1. run the shared server behind your TLS proxy (defaults: MCP_PORT=3100, MCP_BIND=127.0.0.1)
mcp-memory-graph serve

# 2. mint one key per employee, pinned to namespaces + an access ceiling
mcp-memory-graph keys create --principal alice --namespaces eng     --max-access-level internal
mcp-memory-graph keys create --principal carol --namespaces hr,eng  --max-access-level confidential

# 3. wire each employee's MCP client at onboarding
npx mcp-memory-graph init --remote https://memory.example.com --token-env MEMORY_MCP_TOKEN
```

Then declare the org graph so it is traversable — `memory_store` a profile per person, then
`memory_extract_entities` with typed entities (`person`/`team`/`project`/`sop`/`tool`) and relationships
(`manages`/`works_on`/`follows`/`uses`). Query with `memory_graph { entity: "Dana Kim", depth: 2 }` or
blend graph proximity into recall with `memory_search { use_graph: true }`. Sales physically cannot read
HR (namespace wall + 404 non-confirmation); revoke a leaver with `mcp-memory-graph keys revoke <id>`.

### Set up and dispatch a webhook

```bash
mcp-memory-graph serve                          # with MCP_WEBHOOKS=1 in the environment
```
```jsonc
memory_webhook { action: "register", url: "https://hooks.example.com/mem",
                 secret: "s3cret", events: "memory.created,memory.forgotten" }
memory_webhook { action: "dispatch" }           // drain the durable queue immediately
```

### Mint and scope an RBAC key

```bash
mcp-memory-graph keys create --principal cfo-bot --namespaces finance,sales \
    --max-access-level restricted --expires 2030-01-01T00:00:00Z
# token prints once → store it; use it as: Authorization: Bearer <token>
mcp-memory-graph keys list
mcp-memory-graph keys revoke <id>
```
