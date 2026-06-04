# Contributing

Thanks for opening this file — a few minutes here will save us both a code-review round trip.

## Setup

```bash
git clone https://github.com/YonasValentin/mcp-memory-server.git
cd mcp-memory-server
npm ci

# Web dashboard (only if you're touching it):
cd web && npm ci && cd ..
```

Node 20+ is required (the CI matrix runs 20 and 22).

## Local loop

```bash
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm test             # vitest run
npx vitest           # vitest watch
npm run lint         # tsc --noEmit
npx vitest run --coverage   # local coverage gate
```

Web dashboard:

```bash
cd web
npm run dev          # vite on :5173, proxies /api → :3100
npm run lint
npm run build
```

The dev server expects a memory server on `http://localhost:3100`. Run that with:

```bash
MCP_AUTH_OPTIONAL=1 node dist/index.js serve
```

## What CI checks

Every PR must pass:

- `npm run build` (server) and `npm run build` (web)
- `tsc --noEmit` (root) and `npm run lint` (web)
- `npx vitest run --coverage` with thresholds: lines 100, statements 100, functions 99, branches 90 (see the documented exclude list in `vitest.config.ts`)
- `npm audit --audit-level=high` for both root and `web/`
- CodeQL (`security-and-quality` query suite)

If a check fails, the PR can't merge. Push fixes; CI re-runs automatically.

## Pull request etiquette

- One change per PR. If the PR description has a bullet list of unrelated items, split it.
- Tests land in the same PR as the code they cover. Regression tests are required for any bug fix.
- Commit subject in imperative present tense (`fix`, `feat`, `docs`, `test`, `refactor`, `chore`). Body explains *why*, not *what*.
- Keep diff scope honest: don't slip a refactor into a "fix typo" PR.

## Conventions

- TypeScript: `strict: true`. No `any` in production code (tests may use `as` for fixtures).
- Errors at HTTP boundaries return `{ error, code, requestId, issues? }` — see `src/api/routes.ts:sendError`.
- Logs go through `src/lib/logger.ts`, not `console.*`. The logger redacts auth/secret keys automatically.
- Database access goes through `src/db/repository.ts` and `src/lib/direct-access.ts`. Don't construct a `better-sqlite3` connection ad hoc.
- Schemas live in `src/schemas/index.ts`. New REST inputs derive from existing MCP schemas via `.pick`/`.partial` rather than defining parallel shapes.
- Use the existing `db.transaction(...)` pattern for multi-statement writes.

## Licensing of contributions

This project is **source-available**, not open source: it's licensed under the
[PolyForm Noncommercial License 1.0.0](./LICENSE) (free for noncommercial use)
and is **also offered under separate paid commercial licenses** (see
[COMMERCIAL.md](./COMMERCIAL.md)).

For that dual model to work, the maintainer must be able to license *all* of the
code — including your contribution — under **both** the noncommercial license and
commercial licenses. So, by submitting a pull request, you:

1. **certify the [Developer Certificate of Origin](https://developercertificate.org/)**
   (that you wrote the contribution or have the right to submit it), and
2. **grant the maintainer (Yonas Valentin Kristensen) a perpetual, irrevocable,
   worldwide license to your contribution, with the right to sublicense and
   relicense it** — including under the PolyForm Noncommercial License and under
   commercial license terms.

You retain copyright in your contribution; this only grants the relicensing right
the dual model needs. Sign off your commits with `git commit -s` (adds the
`Signed-off-by:` DCO line). If you can't agree to this, please open an issue to
discuss before sending code.

## Filing security issues

See [SECURITY.md](./SECURITY.md). Don't open public GitHub issues for vulnerabilities.

## Ground rules

- No force-push to `main` without consensus.
- Don't merge your own PR if the CI status is yellow ("missing required check").
- Don't disable a failing test to land a PR — fix the test or the code.
- Don't bypass the audit gate (`npm audit --audit-level=high`) by adding ignore-list overrides without a written reason in the PR description.
