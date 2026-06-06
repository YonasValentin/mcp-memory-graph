# Multi-tenancy & isolation

## TL;DR

- **Single-user / local (default — `MCP_API_NAMESPACE` unset): SUPPORTED, hardened.** This is the production mode. One user (or one trusted project) per database file. All recall, privacy (`scope='user'`), and bitemporal guarantees hold.
- **Multiple isolated tenants → one database file per tenant.** A separate DB file is a hard, structural isolation boundary with no shared state. This is the recommended way to serve multiple tenants.
- **Shared DB pinned to one namespace via `MCP_API_NAMESPACE` (multi-tenant on a SHARED database): EXPERIMENTAL — not hardened for adversarial cross-tenant isolation.** A startup warning is emitted when it is enabled.

## Why shared-DB multi-tenancy is experimental

`MCP_API_NAMESPACE` pins every request on a shared instance to one namespace and is enforced as a single policy (`src/lib/tenancy.ts`): force the namespace into corpus queries, and refuse by-id reads of another namespace's memory. For the **memory rows themselves** (the `memories` table, which carries `scope`/`namespace`) this is robust and battle-tested.

The gap is the **knowledge-graph layer**. These tables are GLOBAL — they have no `namespace` column by design (an entity like "PostgreSQL" is one node shared across all content):

- `entities`, `entity_relationships`, `entity_aliases`
- `memory_links`
- `memory_conflicts`
- communities (computed on demand over the entity graph)

Because the graph is shared, every tool that reads it under a forced namespace must re-derive tenancy per-consumer (scope the entity set to the tenant's memories, filter joins on `namespace`, avoid emitting a global aggregate count, gate a graph walk to the tenant's partition). Four adversarial "battle" waves (session 10, 2026) hardened the known consumers — `memory_search`, `memory_graph`, `memory_communities`, `memory_questions`, `memory_health`, `memory_insights`, `memory_related`, `memory_unlinked_mentions`, `memory_query`, `memory_revalidate`, `memory_canvas`, the vault export surfaces — but the waves did **not** fully converge: per-tool fixes keep surfacing more consumers because the invariant is not enforced structurally.

**The durable fix is architectural** (a planned milestone): add a `namespace`/`scope` dimension to the shared graph tables (or partition the entity graph per tenant) so isolation is enforced by the schema, not re-implemented in every reader. Until that ships, treat shared-DB `MCP_API_NAMESPACE` as experimental.

## Known residual classes when `MCP_API_NAMESPACE` is forced on a shared DB

1. **Shared-table reads** — a newly added read tool that joins a global graph table without per-namespace scoping can surface another tenant's entity name / memory id / title / relationship.
2. **Global-aggregate side-channels** — emitting a global counter from a shared table (`entities.mention_count`, conflict counts) can disclose another tenant's *activity volume* even when names are scoped.

Both are mitigated in the shipped consumers; the risk is regressions/new consumers until the schema carries namespace.

## Recommendation

| Need | Use |
|---|---|
| One user / one project | Default mode. Nothing to configure. |
| Several teammates sharing recall | Git-shared Obsidian vault (the "Bruno model") — plain `.md` per memory, union-merged. No shared live DB. |
| Hard isolation between distinct tenants | **One database file per tenant** (separate `MCP_MEMORY_DB` path / separate process). |
| Single shared DB, many namespaces, mutually trusting | `MCP_API_NAMESPACE` is fine — the corpus-row isolation holds; the graph side-channels matter only against an *adversarial* co-tenant. |
| Single shared DB, mutually distrusting tenants | **Not yet supported** — wait for the architectural fix, or use one DB per tenant. |
