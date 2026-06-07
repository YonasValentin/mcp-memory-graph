import type Database from 'better-sqlite3';
import path from 'node:path';

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
 * TENANCY-MODE NOTE (battle-v14, schema v14). Single-user / local mode
 * (MCP_API_NAMESPACE unset) is the default, hardened production mode. Pinning a
 * shared DB to one namespace for MULTI-TENANT isolation is now a SUPPORTED mode:
 * schema v14 carries a (scope, namespace) dimension on the five knowledge-graph
 * tables (entities, entity_aliases, entity_relationships, memory_links,
 * memory_conflicts) and entity identity is keyed per-namespace, so isolation is
 * enforced structurally rather than re-derived per reader. An adversarial
 * convergence battle (multiple waves of attackers + refute-verify skeptics)
 * reached a clean 0-confirmed wave on the shared-DB path.
 *
 * Testing proves bugs-found, not bugs-absent, so a SEPARATE database file per
 * tenant remains the strongest possible boundary (no shared state at all). Emit a
 * one-time, non-alarming startup note pointing operators at that strongest option.
 * Called from the server-starting entry points only (not per request, not in
 * tests). No-op when scoping is off.
 */
export function noteTenancyMode(): void {
  const ns = forcedNamespace();
  if (!ns) return;
  // eslint-disable-next-line no-console
  console.error(
    `[mcp-memory] MCP_API_NAMESPACE='${ns}' — shared-DB multi-tenant isolation ` +
      `(schema v14, per-namespace). For the STRONGEST isolation boundary use a ` +
      `SEPARATE database file per tenant (see docs/MULTI-TENANCY.md).`,
  );
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

/**
 * battle-v9 CLASS 2 — vault boundary. The vault tools (vault_sync/status/search)
 * derive their namespace from `basename(vault_path)` and self-scope to
 * scope='project'. On a namespace-forced deployment that lets a caller read or
 * write ANY namespace over POST /mcp by naming a foreign vault path. The only
 * vault a pinned tenant may touch is the one whose basename equals the forced
 * namespace. Returns true (no restriction) when scoping is off. A trailing
 * separator is tolerated so `/v/edc` and `/v/edc/` both resolve to `edc`.
 */
export function vaultPathInForcedNamespace(vaultPath: string): boolean {
  const ns = forcedNamespace();
  if (!ns) return true;
  return path.basename(vaultPath) === ns;
}
