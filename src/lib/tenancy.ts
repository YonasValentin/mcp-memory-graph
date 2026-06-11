import type Database from 'better-sqlite3';
import path from 'node:path';
import { currentPrincipal } from './request-context.js';

/**
 * T1 — single source of truth for namespace tenancy.
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
 *
 * RBAC v1 (§2): each helper resolves in PRIORITY ORDER —
 *   1. a per-request {@link currentPrincipal} context (set by the HTTP auth
 *      middleware for API-key callers) → PRINCIPAL mode: the helper is
 *      namespace-SET-aware (member → keep, unset → default ctx.namespaces[0],
 *      foreign → throw 'Namespace not permitted'; by-id/vault checks are set
 *      membership);
 *   2. else the MCP_API_NAMESPACE env pin (legacy mode) — byte-identical to
 *      the pre-RBAC behaviour;
 *   3. else undefined (local single-user) — unchanged.
 * The explicit-deny throw (never a silent redirect) is deliberate: silently
 * rewriting a caller-chosen foreign namespace would corrupt writes.
 */

/** The deny message principal-mode helpers throw; routes map it to a 403. */
export const NAMESPACE_NOT_PERMITTED = 'Namespace not permitted';

/**
 * The forced namespace, or undefined when scoping is off. Principal mode →
 * ctx.namespaces[0] (the per-request default; set-aware callers use the
 * helpers below). Env value is length-checked so an empty
 * `MCP_API_NAMESPACE=""` is treated as unset (not a literal empty namespace),
 * matching both surfaces' previous behaviour.
 */
export function forcedNamespace(): string | undefined {
  const ctx = currentPrincipal();
  if (ctx) return ctx.namespaces[0];
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
 * Principal mode: a member namespace is KEPT (a multi-namespace key picks its
 * effective namespace per call), unset defaults to ctx.namespaces[0], and a
 * foreign namespace throws — explicit deny, never a silent redirect.
 */
export function scopeToNamespace<T extends { namespace?: string }>(opts: T): T {
  const ctx = currentPrincipal();
  if (ctx) {
    if (opts.namespace === undefined) return { ...opts, namespace: ctx.namespaces[0] };
    if (ctx.namespaces.includes(opts.namespace)) return opts;
    throw new Error(NAMESPACE_NOT_PERMITTED);
  }
  const ns = forcedNamespace();
  return ns ? { ...opts, namespace: ns } : opts;
}

/**
 * Force the namespace nested under `filter` (the memory_query_structured shape
 * carries namespace under `filter`, not top-level). No-op when scoping is off.
 * Principal mode mirrors {@link scopeToNamespace} on `filter.namespace`.
 */
export function scopeFilterToNamespace<T extends { filter?: { namespace?: string } }>(
  opts: T,
): T {
  const ctx = currentPrincipal();
  if (ctx) {
    const requested = opts.filter?.namespace;
    if (requested === undefined) {
      return { ...opts, filter: { ...opts.filter, namespace: ctx.namespaces[0] } };
    }
    if (ctx.namespaces.includes(requested)) return opts;
    throw new Error(NAMESPACE_NOT_PERMITTED);
  }
  const ns = forcedNamespace();
  return ns ? { ...opts, filter: { ...opts.filter, namespace: ns } } : opts;
}

function memoryNamespace(
  db: Database.Database,
  id: string,
): { namespace: string | null } | undefined {
  return db
    .prepare<[string], { namespace: string | null }>('SELECT namespace FROM memories WHERE id = ?')
    .get(id);
}

/**
 * Shared by-id ownership check: returns true when the memory may be served
 * under the current scoping. A scoped instance must not reveal a memory
 * belonging to another namespace by id. Returns true (no restriction) when
 * scoping is off. The REST surface wraps this in its 404-throwing guard.
 * Principal mode: SET membership (row.namespace ∈ ctx.namespaces); a missing
 * row stays false — existence non-confirmation preserved. A NULL-namespace row
 * is never a member of any principal set (the key grants named namespaces only).
 */
export function idIsInForcedNamespace(db: Database.Database, id: string): boolean {
  const ctx = currentPrincipal();
  if (ctx) {
    const row = memoryNamespace(db, id);
    return !!row && row.namespace !== null && ctx.namespaces.includes(row.namespace);
  }
  const ns = forcedNamespace();
  if (!ns) return true;
  const row = memoryNamespace(db, id);
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
 * Principal mode: SET membership — any of the key's namespaces names a vault
 * it may touch.
 */
export function vaultPathInForcedNamespace(vaultPath: string): boolean {
  const ctx = currentPrincipal();
  if (ctx) return ctx.namespaces.includes(path.basename(vaultPath));
  const ns = forcedNamespace();
  if (!ns) return true;
  return path.basename(vaultPath) === ns;
}
