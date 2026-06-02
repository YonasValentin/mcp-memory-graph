import type Database from 'better-sqlite3';

/**
 * T1 — single source of truth for MCP_API_NAMESPACE tenancy.
 *
 * A shared/remote instance can be pinned to exactly one namespace via the
 * MCP_API_NAMESPACE env var. When set, BOTH surfaces (the MCP stdio tools in
 * server.ts and the REST read API in api/routes.ts) must:
 *   1. force that namespace into every corpus query (overriding any caller
 *      value), and
 *   2. refuse to serve a by-id read of a memory belonging to another namespace.
 *
 * Previously each surface re-implemented this policy independently (server.ts:
 * forcedNs/withForcedNs/idInForcedNs; routes.ts: forcedApiNamespace/
 * assertNamespaceAllowed) and could drift. They now both call these helpers, so
 * the behaviour is provably identical and the security boundary lives in one
 * place. Unset (the local stdio default) → no scoping; single-user setups are
 * unchanged.
 */

/**
 * The forced namespace, or undefined when scoping is off. Length-checked so an
 * empty `MCP_API_NAMESPACE=""` is treated as unset (not a literal empty
 * namespace), matching both surfaces' previous behaviour.
 */
export function forcedNamespace(): string | undefined {
  const ns = process.env.MCP_API_NAMESPACE;
  return ns && ns.length > 0 ? ns : undefined;
}

/**
 * Force the top-level `namespace` option to the configured namespace (the MCP
 * read/query tools carry namespace at the top level). No-op when scoping is off.
 */
export function scopeToNamespace<T extends { namespace?: string }>(opts: T): T {
  const ns = forcedNamespace();
  return ns ? { ...opts, namespace: ns } : opts;
}

/**
 * Force the namespace nested under `filter` (the memory_query_structured shape
 * carries namespace under `filter`, not top-level). No-op when scoping is off.
 */
export function scopeFilterToNamespace<T extends { filter?: { namespace?: string } }>(
  opts: T,
): T {
  const ns = forcedNamespace();
  return ns ? { ...opts, filter: { ...opts.filter, namespace: ns } } : opts;
}

/**
 * Shared by-id ownership check: returns true when the memory may be served
 * under the current scoping. A scoped instance must not reveal a memory
 * belonging to another namespace by id. Returns true (no restriction) when
 * scoping is off. The REST surface wraps this in its 404-throwing guard.
 */
export function idIsInForcedNamespace(db: Database.Database, id: string): boolean {
  const ns = forcedNamespace();
  if (!ns) return true;
  const row = db
    .prepare<[string], { namespace: string | null }>('SELECT namespace FROM memories WHERE id = ?')
    .get(id);
  return !!row && row.namespace === ns;
}
