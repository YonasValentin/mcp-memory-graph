# ADR-0002: Bearer auth + Cloudflare Access as the security boundary

- **Status:** Accepted
- **Date:** 2026-04-28

## Context

The HTTP surface (`/api/*`, `/mcp/*`) needs an authentication story that
fits both deployments:

1. Local-only: a process on a developer's laptop bound to `127.0.0.1`.
2. Remote homelab: a Docker container fronted by Cloudflare Access on a
   public hostname.

Pre-Phase-2, only `/mcp` had a bearer-token check, and `/api` was wide
open. CORS was `*` and the bind was `0.0.0.0` by default — meaning a
laptop on a coffee-shop Wi-Fi could be probed by anyone on the LAN.

## Decision

- **Loopback by default.** `MCP_BIND` defaults to `127.0.0.1`. Anything
  else requires either `MCP_AUTH_TOKEN` or an explicit
  `MCP_AUTH_OPTIONAL=1` opt-in. The startup code refuses otherwise
  (`src/cli/serve.ts:buildApp`).
- **Bearer token gates both `/api` and `/mcp`.** Constant-time
  comparison via `Buffer.compare` to avoid timing attacks. The same
  middleware applies to both prefixes.
- **CORS is allowlist-only.** `MCP_ALLOWED_ORIGINS` (comma-separated).
  Origins not in the list receive no `Access-Control-Allow-Origin`
  header. `Vary: Origin` is always set.
- **Cloudflare Access is the recommended public deployment.** The
  bearer token serves as a defense-in-depth layer behind Access. Access
  enforces identity (email OTP / SSO); the bearer prevents accidental
  leaks if the tunnel is misconfigured.

We deliberately do **not** ship multi-tenant authentication. The single
shared bearer token is the security primitive.

## Consequences

- **Pros.** Operators who follow the defaults can't accidentally ship an
  open server. The threat model is simple to reason about.
- **Cons.** No per-user audit trail or per-scope authorization. If those
  become required, a future ADR will introduce them — likely via OIDC
  (delegating identity to Cloudflare Access claims) without changing
  the wire shape.
- **Migration.** Existing local-only deployments inherit a tightened
  default. The bind change (`0.0.0.0` → `127.0.0.1`) is documented in
  the changelog.
