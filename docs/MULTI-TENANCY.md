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
such corpora (see `docs/ENV.md`). There is no per-user identity or per-request
RBAC — if teammates must not see or affect each other's data, give them
different namespaces or separate DB files.

## Recommendation

| Need | Use |
|---|---|
| One user / one project | Default mode. Nothing to configure. |
| Several teammates sharing recall | Git-shared Obsidian vault (the "Bruno model") — plain `.md` per memory, union-merged. No shared live DB. |
| Many namespaces on one shared DB | `MCP_API_NAMESPACE` per instance — supported; v14 per-namespace isolation covers corpus + graph. |
| Mutually-distrusting tenants / strict compliance | **One database file per tenant** (separate `MCP_MEMORY_DB_PATH` / separate process) — the strongest boundary. |
