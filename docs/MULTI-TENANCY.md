# Multi-tenancy & isolation

## TL;DR

- **Single-user / local (default — `MCP_API_NAMESPACE` unset): supported, hardened.** This is the everyday production mode. One user (or one trusted project) per database file. All recall, privacy (`scope='user'`), and bitemporal guarantees hold, and the entity/knowledge-graph behaves exactly as before v14 (one node per concept, cross-project bridge intact).
- **Shared DB pinned to one namespace via `MCP_API_NAMESPACE` (multi-tenant on a SHARED database): supported (schema v14, per-namespace isolation).** Every request is forced to the pinned namespace and a clean adversarial convergence battle confirmed cross-tenant isolation across the corpus *and* the knowledge graph. A non-alarming startup note points operators at the strongest boundary.
- **Strongest possible boundary → one database file per tenant.** A separate DB file is a hard, structural isolation boundary with no shared state at all. Use it for mutually-distrusting tenants or strict compliance.

## What schema v14 changed

Earlier the knowledge-graph tables were global (no namespace column), so a shared-DB deployment had to re-derive tenancy in every reader — and adversarial battles kept surfacing new consumers that missed it. **Schema v14 makes isolation structural:**

- The five graph tables — `entities`, `entity_aliases`, `entity_relationships`, `memory_links`, `memory_conflicts` — gained a `(scope, namespace)` dimension.
- **Entity identity is keyed by `(normalized_name, namespace)`** (namespace-only partition; scope never partitions). The same concept in two tenants is two separate rows, and `mention_count` is per-tenant for free.
- Write paths stamp the owning memory's namespace (`forcedNamespace() ?? ''`). `createMemoryLink` refuses a cross-namespace edge under forcing; conflict rows stamp the writing memory's partition.
- The v14 migration collapses a pre-v14 graph into the single shared partition (`namespace=''`), merging any duplicate `normalized_name` rows first so the new unique identity index builds.

### The two deployment modes, precisely

- **Single-user (unforced):** all entities live in the shared `''` partition → one row per concept, the global↔project bridge preserved exactly as pre-v14. Behaviour is byte-identical to before v14.
- **Multi-tenant (forced = `T`):** entities live in namespace `T`; cross-tenant content is separate rows; reads filter `namespace = T`, so a migrated pre-v14 graph (in `''`) is **invisible** to a forced tenant and each tenant rebuilds its own graph on fresh writes. Total isolation — a forced tenant surfaces zero of another tenant's id / name / title / content / relationship / community / count.

## Per-key RBAC (schema v16)

The modes above pin **one** namespace per server process (`MCP_API_NAMESPACE`)
or one shared token (`MCP_AUTH_TOKEN`). **Per-key RBAC v1** lets a *single*
running server serve many tenants: one server, **N API keys**, each key pinned
to a *set* of namespaces and an access-level ceiling. "Sales can't see HR"
without one process per tenant. The `api_keys` table (schema v16) lives in the
same DB; the existing `src/lib/tenancy.ts` enforcement boundary is unchanged —
the value it reads is simply per-request (minted from the calling key) instead
of per-process.

### Managing keys — `memory keys`

```sh
# Mint a key — the raw token prints exactly ONCE; store it now.
memory keys create --principal sales-bot --namespaces sales,marketing \
    --max-access-level confidential [--expires 2030-01-01T00:00:00Z]

# Table of every key (live + revoked). NEVER prints token or hash material.
memory keys list

# Revoke a key by id (stamps revoked_at; an original revocation is never restamped).
memory keys revoke <id>
```

- `--max-access-level` defaults to `internal` and must be one of
  `public | internal | confidential | restricted`.
- `--namespaces` is a non-empty comma-separated set; element `[0]` is the key's
  **default** namespace.
- The token is `mcpm_…` (sha256-hashed at rest, shown once at create). Treat it
  like a password; the `mcpm_` prefix lets secret-scanners catch leaks.

### Auth resolution

Auth is *configured* when `MCP_AUTH_TOKEN` is set **or** at least one
non-revoked API key exists — a key-only deployment (no `MCP_AUTH_TOKEN`) is
fully authenticated. On each request:

1. **Legacy single token first** — a `Bearer` value equal to `MCP_AUTH_TOKEN`
   (when that env is set) authenticates in legacy mode with byte-identical
   behavior to today (env-pin or open). No principal context is attached.
2. Otherwise the token is resolved against `api_keys`; a live (non-revoked,
   non-expired) match attaches that key's principal context for the request.
3. Otherwise `401` (unknown key and bad legacy token are indistinguishable in
   the response — no oracle).

The live-key count is consulted on **every request** (no cache — a cached
count was a fail-open window and was removed), so a newly created **or**
revoked key takes effect on the **next request, without a server restart**.

### Namespace semantics

- A multi-namespace key picks its **effective namespace per call**: pass a
  `namespace` the key owns and it is honored; leave it unset and the key's
  **first** namespace (`[0]`) is used.
- A **foreign** namespace (one the key does not own) is **denied with `403`
  `NAMESPACE_NOT_PERMITTED`** — never silently redirected. (Silently rewriting a
  caller-chosen namespace would corrupt writes.)

### Access-level ceiling (egress)

`ACCESS_LEVELS = public < internal < confidential < restricted`. A key never
receives a row **above** its `max_access_level`: such rows are simply invisible
in search / list / get / related / query / export (the same allow-list cap the
dataset export already uses). A **by-id read** of a row that is over-ceiling
**or** in a foreign namespace returns **not-found (404)**, not a `403` — this
deliberately avoids an existence oracle (you cannot probe whether a hidden id
exists).

### MCP session binding

An `mcp-session-id` is **owned by the principal that created it**. Replaying
another principal's session id returns **`403` `SESSION_PRINCIPAL_MISMATCH`**
and never touches the transport, so a valid key cannot ride another principal's
session. `/metrics` stays operator-only (env-token only — it is not a tenant
surface).

### v1 scope & what is deferred to v2

The access ceiling is enforced on the corpus read surface: `memory_search`,
`memory_get`, `memory_list`, `memory_query`, `memory_query_structured`,
`memory_related`, `memory_export`, `memory_export_dataset`, and the REST
equivalents. **Graph / vault / insights access-level ceilings are deferred to
v2** — for now those surfaces are bounded by **namespace isolation** (a key only
sees its own namespaces' graph/vault), which is the same structural boundary
the v14 work hardened. Cross-namespace search for multi-namespace keys, per-key
rate limits, and key rotation UX are also out of v1 scope.

> **Still the strongest boundary → one database file per tenant.** Per-key RBAC
> shares one DB and one process; it is the right tool for many cooperating
> tenants under one operator. For mutually-distrusting tenants or strict
> compliance, a **separate DB file per tenant** remains the only boundary with
> no shared state to reason about.

## Verification

`MCP_API_NAMESPACE` isolation is enforced in one place (`src/lib/tenancy.ts`): force the namespace into corpus queries, refuse by-id reads/mutations of another namespace's memory, and (v14) scope the graph tables structurally. It is exercised by:

- `scripts/battle/sim-multitenant.mjs` — 3 tenants on one shared DB with overlapping entity names: **0 cross-tenant leaks** across 10 read tools, write isolation held, `collision_exercised: true`.
- A multi-wave adversarial **convergence battle** (attackers across read-leak / write-partition / single-user-regression / migration / aggregate-side-channel / bitemporal-by-id-REST lenses, each candidate refuted-or-confirmed by 3 independent skeptics) that reached a **clean 0-confirmed wave**.
- The full real-runtime suite: `sim-solo`, `sim-team`, `sim-longterm` (1400+ writes, cross-ns isolation held), `verify-e2e-hardening` (foreign-id reads/mutations rejected over real `POST /mcp` dispatch), plus build / 1500+ unit tests / bench / coverage.

> **Honest caveat:** testing proves *bugs-found*, not *bugs-absent*. v14 makes shared-DB isolation structural and battle-converged, but a separate DB file per tenant is still the only boundary with *no shared state to reason about*. Choose it when the cost of a single missed reader outweighs the convenience of one DB.

## Inside one namespace: a single trust boundary

Isolation is **between** namespaces, not between teammates inside one. A shared
DB + shared namespace means: `scope='user'` hides a memory from *unscoped
search only* (any teammate can read it with an explicit `scope:'user'` search
or by id); `author` is honor-system; teammates can update or delete each
other's memories (revisions record `changed_by`). One write-path consequence
worth knowing: the self-correcting NLI write-gate runs on every store, so a
teammate storing a near-twin of your note *can* auto-retire yours when the
model reads the pair as a bidirectional contradiction — heavily templated
notes (shared boilerplate, one variable changed) are the false-positive risk.
Every auto-retire is audited in `memory_conflicts` and recoverable
(`memory_history`, `as_of`); set `MCP_NLI_DISABLED=1` to turn the gate off for
such corpora (see `docs/ENV.md`). Inside one namespace there is no per-user
identity — if teammates must not see or affect each other's data, give them
different namespaces (now enforceable per API key — see **Per-key RBAC** below)
or separate DB files.

## Recommendation

| Need | Use |
|---|---|
| One user / one project | Default mode. Nothing to configure. |
| Several teammates sharing recall | Git-shared Obsidian vault (the "Bruno model") — plain `.md` per memory, union-merged. No shared live DB. |
| Many namespaces on one shared DB | `MCP_API_NAMESPACE` per instance — supported; v14 per-namespace isolation covers corpus + graph. |
| Many tenants on **one** server process | **Per-key RBAC** (schema v16) — `memory keys create` one key per tenant, each pinned to a namespace set + access ceiling. |
| Mutually-distrusting tenants / strict compliance | **One database file per tenant** (separate `MCP_MEMORY_DB_PATH` / separate process) — the strongest boundary. |
