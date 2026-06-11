import { AsyncLocalStorage } from 'node:async_hooks';
import type { AccessLevel } from '../types.js';

/**
 * RBAC v1 §1 — per-request principal context.
 *
 * One running server, N API keys: the auth middleware resolves a bearer token
 * to a {@link PrincipalContext} and runs the rest of the request inside
 * {@link runWithPrincipal}. The tenancy helpers (src/lib/tenancy.ts) read
 * {@link currentPrincipal} FIRST, before the legacy MCP_API_NAMESPACE env pin —
 * the six-battle-hardened enforcement chokepoints stay exactly where they are;
 * only the VALUE they read becomes per-request.
 *
 * This module is a LEAF: tenancy.ts imports it, never the reverse (the only
 * other import is the AccessLevel type). The stdio path and every CLI command
 * never establish a context, so they keep env/no-pin behaviour bit-for-bit.
 */
export interface PrincipalContext {
  /** Human-readable key name, for logs/audit. */
  principal: string;
  /** api_keys.id of the authenticated key. */
  keyId: string;
  /** Permitted namespaces; non-empty, [0] is the per-request default. */
  namespaces: string[];
  /** Egress ceiling (ACCESS_LEVELS ordering); enforced by the §6 read paths. */
  maxAccessLevel: AccessLevel;
}

const als = new AsyncLocalStorage<PrincipalContext>();

/**
 * Run `fn` (sync or async — the store survives await boundaries) under `ctx`.
 * The namespace set is validated here because a malformed context would be a
 * FAIL-OPEN: an empty array (or an empty-string member, which the helpers'
 * truthiness checks read as "unforced") would silently disable scoping for the
 * whole request. Refuse loudly at the boundary instead.
 */
export function runWithPrincipal<T>(ctx: PrincipalContext, fn: () => T): T {
  if (
    !Array.isArray(ctx.namespaces) ||
    ctx.namespaces.length === 0 ||
    ctx.namespaces.some((n) => typeof n !== 'string' || n.length === 0)
  ) {
    throw new Error(
      'PrincipalContext.namespaces must be a non-empty array of non-empty namespace strings',
    );
  }
  return als.run(ctx, fn);
}

/** The active principal, or undefined outside any runWithPrincipal (stdio/CLI/legacy HTTP). */
export function currentPrincipal(): PrincipalContext | undefined {
  return als.getStore();
}
