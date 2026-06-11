# RBAC v1 — per-key principals over one server process (schema v16)

**Goal:** one running server, N API keys, each key pinned to a set of namespaces +
an access-level ceiling. "Sales can't see HR" without one-process-per-tenant.
Legacy single-token mode (`MCP_AUTH_TOKEN`) keeps byte-identical behavior.

**Non-goals (v1):** cross-namespace search for multi-namespace keys (each CALL
operates in exactly one effective namespace — same semantics as today's forced
mode, just per-request); per-key rate limits; key rotation UX; UI.

## Threat model recap (what the existing machinery already guarantees)

Tenancy enforcement is at `server.ts` (withForcedNs/idInForcedNs) + REST
(`forcedApiNamespace`/`assertNamespaceAllowed`), all funneling through
`src/lib/tenancy.ts` which reads process-global `MCP_API_NAMESPACE`. That
boundary is six-battle-waves hardened — DO NOT reimplement it. The entire v1
design is: make the *value* those helpers read **per-request** instead of
per-process, and mint per-request values from API keys.

## 1. Request context (`src/lib/request-context.ts`, new)

```ts
export interface PrincipalContext {
  principal: string;            // human-readable key name, for logs/audit
  keyId: string;                // api_keys.id
  namespaces: string[];         // non-empty; [0] is the default namespace
  maxAccessLevel: AccessLevel;  // egress ceiling (ACCESS_LEVELS ordering)
}
const als = new AsyncLocalStorage<PrincipalContext>();
export function runWithPrincipal<T>(ctx: PrincipalContext, fn: () => T): T;
export function currentPrincipal(): PrincipalContext | undefined;
```

No imports from tenancy.ts (tenancy imports request-context, never the reverse).

## 2. tenancy.ts rework (the security core — smallest possible diff)

`forcedNamespace()` stays THE single source. New resolution order:

1. `currentPrincipal()` set → **principal mode** (see below).
2. else `MCP_API_NAMESPACE` env (legacy pinned mode) — unchanged.
3. else undefined (local single-user) — unchanged.

Principal mode semantics per helper (array-aware):

- `forcedNamespace()`: returns `ctx.namespaces[0]` (the default). Callers that
  need set-awareness use the helpers below — audit in §5.
- `scopeToNamespace(opts)`: if `opts.namespace` ∈ ctx.namespaces → keep it;
  if unset → force `ctx.namespaces[0]`; if set but NOT allowed → **throw
  `Error('Namespace not permitted')`** (explicit deny beats silent redirect;
  silent rewrite of a caller-chosen foreign ns would corrupt writes).
- `scopeFilterToNamespace(opts)`: same rule on `opts.filter.namespace`.
- `idIsInForcedNamespace(db, id)`: row.namespace ∈ ctx.namespaces (membership,
  not equality). Missing row → false (existence non-confirmation preserved).
- `vaultPathInForcedNamespace(p)`: basename(p) ∈ ctx.namespaces.
- `noteTenancyMode()`: unchanged (startup, env only).

Legacy pinned mode (env, no ALS ctx): all helpers behave EXACTLY as today —
regression tests must prove byte-identical behavior (run the existing tenancy
test files unmodified; they must pass with zero edits).

## 3. api_keys (schema v16 + `src/db/api-keys.ts`, new)

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,                -- randomUUID
  principal TEXT NOT NULL,            -- display name, unique-ish (not enforced)
  token_hash TEXT NOT NULL UNIQUE,    -- sha256 hex of the full token string
  namespaces TEXT NOT NULL,           -- JSON array, non-empty, validated on write
  max_access_level TEXT NOT NULL DEFAULT 'internal',
  expires_at TEXT,                    -- ISO-Z or NULL
  created_at TEXT NOT NULL,           -- ISO-Z
  revoked_at TEXT,                    -- ISO-Z or NULL
  last_used_at TEXT                   -- ISO-Z, throttled update (≥60s apart)
);
```

- Migration `version: 16` follows the existing pattern (`CREATE TABLE IF NOT
  EXISTS` — idempotent); bump `CURRENT_SCHEMA_VERSION` to 16 in schema.ts AND
  add the DDL to the fresh-create path so new DBs match migrated ones (check
  how webhook_targets does this — mirror it).
- **Timestamps: ISO-Z via the existing `NOW_ISO_SQL` constant / `new Date().toISOString()`**
  — never `datetime('now')` (collation invariant, gotchas §5).
- Token format: `mcpm_` + 43 chars base64url (32 random bytes) — prefix makes
  secret-scanners catch leaks. Stored ONLY as sha256 hex. Shown ONCE at create.
- Module API: `createApiKey(db, {principal, namespaces, maxAccessLevel?, expiresAt?})
  → {id, token}` (only place the raw token exists), `findApiKeyByToken(db, token)
  → row | undefined` (sha256 then lookup; **reject revoked/expired here**, not in
  callers), `listApiKeys(db)` (NO hashes in output), `revokeApiKey(db, id)`,
  `touchLastUsed(db, id)` (no-op if last_used_at within 60s).
- expiry compare: `expires_at <= now` lexical on ISO-Z (collation-safe).

## 4. HTTP wiring (serve.ts)

Replace `bearerMiddleware(token)` with `authMiddleware(getDb, token?)`:

1. No Authorization header → 401 (when any auth configured).
2. Header matches `Bearer ${MCP_AUTH_TOKEN}` (timingSafeStrEqual, only when env
   set) → legacy mode: call `next()` WITHOUT an ALS context (env-pin or no-pin
   applies — today's exact behavior).
3. Else extract `<token>` after `Bearer `, `findApiKeyByToken`. Found →
   build PrincipalContext, `touchLastUsed`, and `runWithPrincipal(ctx, next)`.
   ALS context propagates through Express's downstream sync/async chain
   including the `/mcp` transport dispatch and REST handlers.
4. Else 401 (same JSON envelope; do NOT distinguish unknown-key vs bad-legacy
   token in the response).

Auth activation rule: auth is configured when `MCP_AUTH_TOKEN` set OR ≥1
non-revoked api_key exists (cache the count, refresh every 30s — a key created
while serving must take effect without restart; document the ≤30s window). The
existing "remote bind without auth" startup error gains the api-key clause.

**MCP session binding:** an `mcp-session-id` minted under principal P (or under
legacy mode) is bound to that identity: store `sessionOwner[sid] = keyId |
'__legacy__'` at initialize; on every subsequent /mcp request compare against
the authenticated identity → mismatch = 403 + do not touch the transport.
Cleanup with the transport's onclose. (Without this, any valid key can ride
another principal's session transport.)

**/metrics** keeps env-token-only (operator surface, not tenant surface).

stdio path (`createServer` over stdio, no HTTP): never has ALS ctx → env/no-pin
behavior unchanged.

## 5. Direct `forcedNamespace()` caller audit (do during implementation)

`rg -n "forcedNamespace\(" src/ --type ts -g '!__tests__'` and for EACH caller
decide: default-ns OK (forcedNamespace() = ctx.namespaces[0]) or needs
set-membership (switch to a helper). Known ones: server.ts handleImport remap
(default-ns is correct — import remaps INTO the caller's default), routes.ts
`forcedApiNamespace() ?? q.namespace` sites (must become: q.namespace ∈ allowed
→ q.namespace, else default; REUSE scopeToNamespace instead of ad-hoc ??),
emitter/webhooks namespace gates (membership), vault sidecar/rebuild (basename
membership), stats/communities/graph (default or membership — judge per
read-path, write down the decision per site in the commit message).

The not-permitted throw must surface as a clean MCP tool error / REST 403 (map
in routes' error handler: message 'Namespace not permitted' → 403 JSON).

## 6. Access-level ceiling (egress)

`ACCESS_LEVELS = ['public','internal','confidential','restricted']` (ordered).
Ceiling = index(row.access_level) ≤ index(ctx.maxAccessLevel) — rows above the
ceiling are invisible: filtered in search/list/get/related/query/export the same
way the export-dataset cap works (see `src/tools/export-dataset.ts` allowed-list
pattern). Implementation: a `principalAccessCeiling()` helper in tenancy.ts
returning the allowed-levels array or undefined (no ceiling in legacy/local
modes); thread it into the read predicates at the SAME chokepoints the
namespace forcing already passes through (server.ts withForcedNs wrap + REST) —
NOT per-handler scatter. If a chokepoint can't express it (by-id get), apply the
same membership treatment as idIsInForcedNamespace (404, non-confirmation).
v1 scope: memory_search, memory_get, memory_list, memory_query,
memory_query_structured, memory_related, memory_export, memory_export_dataset,
REST equivalents. Graph/vault/insights ceilings: document as v2 (note in
MULTI-TENANCY.md) — namespace isolation already bounds them per-tenant.

## 7. CLI (`memory keys …`)

- `memory keys create --principal <name> --namespaces a,b[,c] [--max-access-level internal] [--expires <ISO>]`
  → prints id + the token ONCE with a "store it now" warning.
- `memory keys list` → table: id, principal, namespaces, level, created, expires, revoked, last_used. NO hashes.
- `memory keys revoke <id>` → stamps revoked_at.
- argv.ts: `keys` entry in COMMAND_USAGE (the `--help` gate is mandatory — see
  F-INIT-HELP comment); src/index.ts dispatch follows existing command pattern.
- Uses getReadWriteDb (migrations run); `keys list/revoke` on a fresh DB must
  not crash.

## 8. Tests (TDD, red→green per module)

- api-keys module: create/find/expiry/revoke/hash-not-token/list-redaction/touch throttle.
- tenancy principal mode: each helper × (in-set, out-of-set→throw, unset→default,
  legacy-env unchanged, no-ctx unchanged). The EXISTING tenancy/forced-ns test
  files must pass UNMODIFIED.
- request-context: ALS propagation across await boundaries; nested runs.
- serve auth: legacy token still works; api-key auth works; revoked/expired 401;
  unknown 401; session-binding 403 on principal mismatch; /metrics env-only;
  auth-activation rule (key-only deployment, no MCP_AUTH_TOKEN).
- E2E-ish (buildApp + raw http, mirroring existing api tests): two keys, two
  namespaces — A stores, B cannot read it by search/get/list/graph/export; B's
  store lands in B's ns; A's by-id of B's row = 404; explicit foreign ns param =
  403; multi-ns key switches namespaces per call; ceiling hides confidential
  from an 'internal' key.
- access ceiling unit tests at each v1 surface.
- Coverage thresholds (100/100/99/90) hold — `npm test` enforces.

## 9. Order of work

1. api-keys module + migration v16 (pure, no wiring) — commit.
2. request-context + tenancy principal mode + audit §5 — commit.
3. serve.ts auth middleware + session binding + REST alignment — commit.
4. access ceiling — commit.
5. CLI keys + docs (MULTI-TENANCY.md "Per-key RBAC" section, ENV.md, README one-liner) — commit.

Each step: build clean + full suite green before commit. Conventional commits.

## 10. Verification gates (after all steps)

- `npm run build` + `npm test` (1730+) + `npm run smoke` (Node 22 PATH).
- `npm run bench` floor: rerank P@1 .813 / MRR .867 UNCHANGED (RBAC must not
  touch ranking — if this moves, something leaked into the search path).
- sim-multitenant 0-leak (existing script) still green in legacy env mode.
- New: a 2-principal live REST probe script (store/search/get/export across
  keys) — add under scripts/battle/ as verify-rbac.mjs (natural drain, mock-free).
- Then the MANDATORY adversarial battle wave (cross-principal read/write/graph/
  export/REST/session-riding probes) — separate task, not the implementer.
