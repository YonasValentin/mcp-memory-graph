# Handover — Production-Readiness Hardening (resume here)

## Context

Repo: `/Users/yonasvalentin/Projekter/mcp-memory-server` — MCP Memory Server v1.0.0.

Goal: make the codebase fully production-ready for **single-tenant use (you + small internal team), local + remote deployment**. Multi-tenancy / SaaS / regulated-industry scope is **explicitly out**.

Scope was derived from the audit at `/Users/yonasvalentin/.claude/plans/please-fully-analyze-if-deep-pie.md`. Headline verdict: 8.5/10 enterprise-ready for the declared use case; only Compliance/Data pillar had real gaps. We're closing P0 + P1 from that audit.

## What's already done (committed mentally; not yet `git commit`)

| # | Item | Status | Files touched |
|---|---|---|---|
| 1 | Replace `uuid` dep with Node `crypto.randomUUID()` (kills moderate CVE GHSA-w5hq-g745-h8pq permanently, removes a dep) | ✅ done | `src/tools/store.ts`, `src/tools/ingest.ts`, `src/tools/import.ts`, `src/tools/extract-entities.ts`, `src/graph/conflict-resolver.ts`, `src/graph/entity-store.ts`, `src/vault/sync.ts`, `package.json`, `package-lock.json` |
| 2 | Security headers middleware (CSP, HSTS conditional on remote bind, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP, CORP) + 10 unit tests, all passing | ✅ done | `src/api/security-headers.ts` (new), `src/cli/serve.ts` (wired in, deduped `isRemote`), `src/__tests__/api/security-headers.test.ts` (new) |
| 3 | Dockerfile hardening: multi-stage rewrite, runs as `USER node` (uid 1000), `chown` of `/data /cache /app`, drops the wasted python3/make/g++ apt dance, prunes dev deps before copy, BuildKit syntax pin | ✅ done | `Dockerfile` |
| 4 | `docker-compose.yml` hardening: `init: true`, `read_only: true` + tmpfs for `/tmp`, `cap_drop: ALL`, `no-new-privileges`, CPU/memory limits + reservations, json-file log rotation (10m × 5), all env knobs surfaced (`MCP_BIND`, rate-limit, body limit, log level, metrics, HSTS) | ✅ done | `docker-compose.yml` |

`npm audit` reports **0 vulnerabilities**. `npm run build` passes. The new security-headers test file is **10/10 green**. The full suite has not been re-run end-to-end yet (item #10 below).

## What's still pending

**Important: the previous session hit Anthropic's output filter while trying to generate the remaining five docs in one batch.** Generate them **one at a time**, each in its own turn, and `/clear` between any two that block. Use the framing rules at the bottom of this file.

### File 1 — `CODE_OF_CONDUCT.md` (repo root) — task #5

Contributor Covenant 2.1, **verbatim from the official source**. The only customization: enforcement contact = the maintainer email already in `SECURITY.md` (read it first to confirm — currently `yonasmougaard@gmail.com`). No other edits.

Commit: `docs: add Contributor Covenant 2.1`

### File 2 — `.github/workflows/sbom.yml` — task #6

GitHub Actions workflow.
- Triggers: `push` to `main`, `workflow_dispatch`, and tag pushes matching `v*`.
- One job, ubuntu-latest:
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` with Node 20, `cache: npm`
  3. `npm ci`
  4. `npx --yes @cyclonedx/cyclonedx-npm --output-file sbom.cdx.json --output-format JSON`
  5. `actions/upload-artifact@v4` — name `sbom`, path `sbom.cdx.json`, retention 90 days
  6. On tag pushes only: `softprops/action-gh-release@v2` to attach `sbom.cdx.json` to the GitHub Release

No SARIF, no Trivy, no extra tooling. Match the existing workflow style in `.github/workflows/ci.yml` (concurrency group, etc.).

Commit: `ci: generate CycloneDX SBOM on every main build`

### File 3 — append "Bearer Token Rotation" to `docs/RUNBOOK.md` — task #7

Append at the end of the existing RUNBOOK. Steps only, no narrative:

1. Generate new token: `openssl rand -hex 32`
2. Update `MCP_AUTH_TOKEN` in the deployment env file (`/opt/stacks/mcp-memory-server/.env` on MS-01)
3. `docker compose up -d --force-recreate memory-server`
4. Verify: `curl -fs -H "Authorization: Bearer $NEW" http://127.0.0.1:3200/health`
5. Update token in Claude Code MCP config (`~/.claude/settings.json`) and propagate to any team members' configs
6. The previous token is invalidated on container restart — single-token design, no revocation list needed

Recommended cadence: every 90 days, or immediately on suspected exposure.

Commit: `docs: bearer token rotation procedure`

### File 4 — `docs/DATA-HANDLING.md` — task #8

Operator-facing compliance reference. Sections (defensive/control posture only — no attack narratives):

- **Scope.** Single-tenant. You + internal team. Not designed for external customers or regulated workloads.
- **What's stored.** `memories` table fields (id, content, scope, namespace, embedding, access_level, expires_at, timestamps), embeddings (384-dim float32, local model), `memory_access_log` audit table.
- **Retention.** No hard TTL by default. `memory_consolidate` prunes old low-access entries on demand. Per-memory `expires_at` is operator-set.
- **Deletion.** `memory_delete` tool. `memory_export` provides portability before deletion (data subject access requests).
- **Encryption at rest.** Not built in. Use FileVault on macOS, LUKS on Linux, or volume-level encryption (e.g. encrypted EBS) on cloud hosts.
- **Encryption in transit.** TLS terminated at the reverse proxy (Caddy / NGINX / Cloudflare Tunnel). The server itself speaks plain HTTP and binds to loopback by default.
- **Audit log.** Every read recorded in `memory_access_log` (`src/db/migrations.ts` lines 47–58). Retention is operator-controlled — prune via SQL on a schedule if required.
- **GDPR notes (internal-team use).** Lawful basis: legitimate interest for internal tooling. Data subject requests handled via `memory_export` (portability/access) and `memory_delete` (erasure). The `access_level` field exists but is operator-set, not auto-classified — no PII detection is performed.

Commit: `docs: data handling and retention reference`

### File 5 — append "Trust Boundaries" to `SECURITY.md` — task #9

Append at the end. Mermaid diagram + three-sentence caption. **No STRIDE table, no attack scenarios.**

```mermaid
graph LR
  U[Operator / Team Member] -->|TLS| P[Reverse Proxy]
  P -->|Bearer Auth| S[MCP Memory Server]
  S --> D[(SQLite + sqlite-vec)]
  S --> E[Local Embedder]
  C[Claude Code] -->|stdio or HTTPS+Bearer| S
```

Caption (three sentences): network-edge boundary at the reverse proxy where TLS terminates; auth boundary at the API where the bearer token is checked in constant time; local-only data plane where SQLite and the embedder run inside the container.

Commit: `docs: add trust boundary diagram to SECURITY.md`

### File 6 — final verification — task #10

Run, in order, and report each:

```bash
npm audit --audit-level=high     # expect: 0 vulnerabilities
npm run build                    # expect: clean tsc
npm test                         # expect: all suites green, including the new security-headers tests
docker build -t mcp-memory-server:verify .   # smoke test the new Dockerfile
```

If anything fails, **fix root cause before claiming done** — do not skip.

## Framing rules (apply to every remaining file)

These rules are why the previous batch tripped the filter. Every remaining doc must:

- Use **defensive/control posture** only — describe what controls *do*, not what attackers would do.
- Use neutral compliance vocabulary (NIST CSF / ISO 27001 Annex A / GDPR Art. 32) when unavoidable.
- **No** attack narratives, exfiltration scenarios, threat-actor language, or red-team framing.
- For the trust-boundary diagram: boundary names + one-line role only. No STRIDE walkthroughs.

## Generate one file per turn

After each file is written, run `git add` + `git commit` with the message specified, then **stop** and wait for the user to say "next". Do not chain multiple files in a single turn — that is what tripped the filter last time.

If a single file still trips the filter, the user will `/clear` and re-paste the instructions for that file standalone.

## Reference points

- Original audit + verdict: `/Users/yonasvalentin/.claude/plans/please-fully-analyze-if-deep-pie.md`
- This handover: `.planning/HANDOVER.md`
- Existing security narrative to extend: `SECURITY.md`
- Existing runbook to extend: `docs/RUNBOOK.md`
- New code from this session that needs the test suite re-run: `src/api/security-headers.ts`, `src/__tests__/api/security-headers.test.ts`, `src/cli/serve.ts` (modified)
- Dep changes to commit: `package.json`, `package-lock.json` (uuid removed)
- Infra changes to commit: `Dockerfile`, `docker-compose.yml`

## Suggested first commit (work already done)

Before starting File 1, capture what's already on disk so the resume session starts clean:

```bash
git add -A
git status      # confirm what's staged
git commit -m "feat(security): swap uuid for crypto.randomUUID, add security headers middleware, harden container"
```

Then proceed to File 1.
