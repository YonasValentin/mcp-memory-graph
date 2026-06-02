# mcp-memory-server — Full-Overhaul Structure & Readability Plan

**Scope:** file/folder layout + readability only. **No behavior changes.** Every move is a pure
relocation/re-export; every split preserves the exact runtime graph. This is a structural review,
not a logic review.

**Reviewer note on churn philosophy:** This codebase has an unusually favorable property for
restructuring — **fan-in is tiny**. The 36 `src/tools/*.ts` handlers are imported by only **5**
production files (`server.ts`, `api/routes.ts`, and 3 CLI scripts), but by **69 test files**. The
schemas god-file (`src/schemas/index.ts`, 1268 LOC) is imported by exactly **2** production files.
So the *production* import-churn of any reorg is near-zero, but the *test* import-churn is the real
cost center. Every proposal below is graded primarily by how many test imports it disturbs.

---

## Baseline facts (measured, not assumed)

| Fact | Value |
|---|---|
| Total src LOC (non-test) | 17,362 |
| God-files | `schemas/index.ts` 1268, `server.ts` 689, `db/repository.ts` 572, `cli/serve.ts` 497 |
| Other large files | `vault/sync.ts` 493, `graph/communities.ts` 470, `types.ts` 451, `api/routes.ts` 443, `cli/init.ts` 427 |
| `src/tools/` files | 36 |
| Production files importing a tool handler | **5** (`server.ts`, `api/routes.ts`, `cli/consolidate.ts`, `cli/extract-from-transcript.ts`, `cli/cleanup-extracted.ts`) |
| **Test** files importing a tool handler | **69** |
| Files importing `schemas/index.ts` | **2** (`server.ts`, `api/routes.ts`) |
| Barrel files today | only `src/index.ts` (a CLI dispatcher, not a re-export barrel) and `src/schemas/index.ts` |
| tsconfig path aliases | **none** (relative `.js` imports throughout — ESM/NodeNext) |
| vitest test glob | `src/**/*.test.ts` (co-location already permitted by config) |
| Tests today | 101 files, all in `src/__tests__/` (mirrored subfolders) |
| Tool entrypoint naming | `handleX` everywhere (consistent). 16 async, 24 sync — naming already uniform |
| Cross-tool imports | only 5 total (`store`, `update` reused by `ingest`/`import`/`consolidate`) |

**Two pre-existing naming collisions found:** `communities.ts` exists in both `tools/` and `graph/`;
`canvas.ts` exists in both `tools/` and `vault/`. These are disambiguated only by directory today.
Any flattening must preserve the directory qualifier or rename.

---

## Domain language (ubiquitous language) — adopt before renaming anything

The code already speaks a consistent dialect; the goal is to *document* it, not invent new terms.
Canonical nouns to standardize in folder names, types, and docs:

- **Memory** (the record), **Scope** (`global|project|user|team|department`), **Tier** (maturity),
  **Vault** (Obsidian-markdown mirror), **Graph** (entities/links/communities/pagerank),
  **Cognition** (reflect/consolidate/condense/learnings/questions/attribution — the "thinking" tools),
  **Ingest/Import/Export** (bulk I/O), **CoreMemory** (always-resident block).

Canonical verb for a tool entrypoint: **`handle<Tool>`** (already universal — do **not** churn this).
Canonical verb for a CLI entrypoint: **`run<Command>`** (already universal in `cli/`).

This vocabulary directly drives the `tools/` subfolder grouping below (crud / cognition / graph / vault / io).

---

## PROPOSALS

Each is graded: **SAFE** (mechanical, reversible, low test impact), **MODERATE** (touches many
test imports or introduces a new convention), **DESTABILIZING** (high churn or behavior-risk-adjacent).

---

### P1 — Split `src/schemas/index.ts` (1268 LOC) by domain → `src/schemas/*` + thin barrel
**Risk: SAFE**

The file is a flat list of ~52 Zod schemas plus ~18 private field-factory helpers
(`scopeField`, `tagsField`, `intFromString`, etc.). It cleanly partitions:

```
src/schemas/
  fields.ts        # the 18 shared field factories (scopeField, tagsField, intFromString, csvList…)
  memory.ts        # MemoryStore/Search/Get/Update/Delete/List/Ingest/Related/Query… (the CRUD+query core)
  cognition.ts     # Reflect/Consolidate/Condense/ExtractLearnings/Questions/Attribution/Communities/Restore
  graph.ts         # MemoryGraph/ExtractEntities/UnlinkedMentions/QueryStructured
  vault.ts         # VaultSync/VaultStatus/VaultSearch/ExportVault/Canvas/Manifest/Template/SessionNote
  versions.ts      # Versions/VersionDiff/VersionRestore/History/Forget/Tiers/Stats/Export/Import
  core-memory.ts   # CoreMemoryGet/Append/Replace
  api.ts           # Api*QuerySchema + ApiPatchBodySchema (the 11 REST coercion schemas)
  index.ts         # barrel: `export * from './memory.js'` … (re-exports everything)
```

**Why safe:** only 2 production importers and they import *named* symbols from the barrel path
`schemas/index.js`. Keep `index.ts` as a `export *` barrel and **both importers change zero lines**.
Tests importing schemas (a handful) likewise unaffected. The `fields.ts` extraction is the single
highest-readability win in the repo — those private factories are why the file is 1268 lines of
dense `z.object` noise.

**Churn:** ~0 import edits (barrel preserves the path). Risk is only mechanical (a schema landing in
the wrong sub-file). Validate with `npm run typecheck` + the schema test suite.

---

### P2 — Split `src/server.ts` (689 LOC) into a registry + per-domain registration modules
**Risk: MODERATE**

535 of the 689 lines are 41 repetitive `server.tool(name, schema.shape, handler)` blocks. The file
mixes: (a) helpers (`formatResult`, `formatError`, `instrument`), (b) DB/embedder bootstrap, (c) the
41-call registration wall.

```
src/server/
  index.ts            # createServer() — bootstrap + calls the register* functions (was server.ts)
  format.ts           # formatResult, formatError  (also imported by tools? verify — likely server-only)
  instrument.ts       # instrument<I>() wrapper + metrics wiring
  registry/
    crud.ts           # registerCrudTools(server, deps)  — store/search/get/update/delete/list…
    cognition.ts      # registerCognitionTools(...)
    graph.ts          # registerGraphTools(...)
    vault.ts          # registerVaultTools(...)
    io.ts             # registerIoTools(...) — ingest/import/export/export-vault
```

**Why moderate, not safe:** `createServer` is imported by `cli/serve.ts` and `src/index.ts` default
path; moving `server.ts` → `server/index.ts` keeps the import specifier `./server.js` identical
(Node resolves the dir index), so production importers are unchanged. **But** `formatResult` and
`instrument` are `export`ed from `server.ts` today — grep shows `formatResult` is exported, so it
may be imported elsewhere (tests). Those importers would need path updates. This is the only real
churn. Mechanical, but touch-count must be measured before committing.

**Behavior risk:** the registration order and the `instrument` wrapping must be preserved *exactly*
(metrics labels, error formatting). This is the one proposal where a careless move could alter
observable output (error envelope, metric names). Mark each `register*` extraction as a verbatim
cut-paste, then diff the emitted tool list + a metrics snapshot test before/after.

---

### P3 — Split `src/db/repository.ts` (572 LOC) by aggregate
**Risk: SAFE**

17 exported free functions over 3 concerns: memory lifecycle, access/quality scoring, and ingest-source
bookkeeping. They share `rowToMemory` and the `MemoryRow` type.

```
src/db/repository/
  memory.ts        # insert/update/delete/deleteByFilter/invalidate/getById/getRowid/list/rowToMemory
  scoring.ts       # recordAccess, updateQualityScores, findNearDuplicates, STABILITY_INCREMENT
  ingest-source.ts # upsertIngestSource, getIngestSourceByPath, IngestSourceRecord glue
  index.ts         # barrel re-export
```

**Why safe:** these are pure free functions (no class). Barrel at `repository/index.ts` keeps
`db/repository.js` resolving unchanged → **zero production/test import edits**. `rowToMemory` is the
shared dependency; it stays in `memory.ts` and is re-exported. Validate via db test suite.

---

### P4 — Split `src/cli/serve.ts` (497 LOC) into transport / middleware / app-builder
**Risk: MODERATE**

`buildApp` spans lines 173–459 (≈286 lines) and bundles CORS, bearer auth, request-id, host
validation, body-limit, and route mounting. Extractable:

```
src/cli/serve/
  index.ts        # runServe() + the exported buildApp() composition (path stays ./cli/serve.js)
  middleware.ts   # corsMiddleware, bearerMiddleware, requestIdMiddleware, localhostHostValidation, timingSafeStrEqual
  config.ts       # parseAllowedOrigins, bindHost, bodyLimit, bearerToken
```

**Why moderate:** `timingSafeStrEqual` and `buildApp`/`BuildAppDeps`/`BuiltApp` are exported and
exercised directly by auth/api tests. Moving them changes those test import paths unless `serve/index.ts`
re-exports them (it should). With a re-export barrel this drops toward SAFE, but security-sensitive
helpers (`timingSafeStrEqual`, `bearerMiddleware`, `localhostHostValidation`) mean any accidental edit
is a security regression — hence not graded SAFE. Cut-paste verbatim, no logic touch.

---

### P5 — Group `src/tools/` (36 files) into `crud/ cognition/ graph/ vault/ io/` subfolders
**Risk: DESTABILIZING**

Proposed grouping (using the ubiquitous language from the top):

- **crud/**: store, search, get, update, delete, list, query, related, stats, tiers, history
- **cognition/**: reflect, consolidate, condense, extract-learnings, questions, attribution, communities, core-memory
- **graph/**: graph, extract-entities, unlinked-mentions, versions, version-history
- **vault/**: vault-sync, vault-status, vault-search, export-vault, canvas, manifest, templates, session-note
- **io/**: ingest, import, export, forget

**Honest cost:** this is the single most churny proposal. **69 test files** import tool handlers via
relative paths like `../../tools/store.js`. Regrouping changes 36 file locations and forces a path
rewrite in every one of those 69 test files (often multiple imports each → easily 150+ edited import
lines). Production cost is small (5 files), but the test blast radius is large and pure noise in
`git blame`/review.

**Two extra hazards:**
1. The pre-existing collisions (`tools/communities.ts` vs `graph/communities.ts`, `tools/canvas.ts`
   vs `vault/canvas.ts`) get *worse* if you name the new tool subfolder `graph/`/`vault/` — you'd
   have `tools/graph/communities.ts` next to `graph/communities.ts`. Confusing.
2. There is **no payoff in reuse**: only 5 intra-`tools/` imports exist, so subfoldering does not
   reduce coupling — it's purely cosmetic categorization.

**Recommendation: DEFER / do not do as part of the overhaul.** If pursued anyway, gate it behind a
re-export shim: keep `src/tools/<name>.ts` as one-line `export * from './crud/<name>.js'` re-exports
so the 69 test imports stay valid, then migrate tests opportunistically. That shim turns it from
DESTABILIZING to MODERATE but leaves 36 dead-thin stub files — ugly. Better to leave `tools/` flat;
36 flat files with a consistent `handleX` export is *more* readable than 5 folders you must `cd` into.

---

### P6 — Co-locate tests (`src/__tests__/**` → next to source as `*.test.ts`)
**Risk: DESTABILIZING**

vitest is already configured for `src/**/*.test.ts`, so co-location is *mechanically* supported with
zero config change. Moving 101 test files next to their subjects improves discoverability and shortens
their relative import paths (`../../tools/store.js` → `./store.js`).

**Honest cost:** every one of the 101 files gets a new location *and* a rewritten import block
(the relative depth changes for nearly every import, not just the subject). That's the largest single
diff in the entire plan and it collides head-on with P5 if both are attempted. It also moves test
fixtures (`src/__tests__/...helpers`) that are shared across suites — those become awkward when tests
scatter.

**Recommendation: DEFER.** The current mirrored `src/__tests__/` tree is a legitimate, coherent
convention. Co-location is a taste call, not a defect. If done, do it in **one** dedicated mechanical
commit, never mixed with P1–P4, and never together with P5.

---

### P7 — Establish barrel-export consistency (the rule, not just more barrels)
**Risk: SAFE**

Today there are effectively zero re-export barrels (`schemas/index.ts` is a flat module, not a barrel;
`src/index.ts` is a CLI dispatcher). P1/P3 introduce per-domain barrels. **Adopt one explicit rule and
write it into `CONTRIBUTING.md`:**

> A folder gets an `index.ts` barrel **only** when it is consumed as a unit through a stable public
> path (e.g. `schemas/`, `db/repository/`). Leaf modules with a single well-known consumer
> (`tools/`, `cli/`, `hooks/`) stay **barrel-free** and are imported by direct path.

**Why safe & valuable:** prevents the common failure mode of "barrel everything," which in NodeNext
ESM creates import cycles and defeats tree-shaking. It also resolves the *inconsistency* the task
flags: the rule makes the presence/absence of `index.ts` meaningful rather than accidental. Pure
documentation + the two barrels from P1/P3.

---

### P8 — Naming consistency pass (low-churn renames)
**Risk: SAFE (docs) / MODERATE (the rename itself)**

Findings: tool entrypoints (`handleX`) and CLI entrypoints (`runX`) are **already consistent** — do
not touch them. The only genuine inconsistencies are the two cross-directory file collisions
(`communities.ts`, `canvas.ts`). Lowest-risk fix is to **not rename files** (renames break the 69 test
imports for those two) but instead document in the domain glossary that the tool-layer file is the
*adapter* (`handleCommunities` → wraps `graph/communities.ts` `detectCommunities`). I.e. resolve the
confusion with a one-line module header comment + glossary entry, **not** a rename.

**Recommendation:** ship the glossary (SAFE). Skip physical renames (MODERATE, no payoff).

---

## Sequencing & guardrails

1. **Phase 1 (SAFE, do now):** P1 schemas split, P3 repository split, P7 barrel rule, P8 glossary.
   Each is a barrel-preserving relocation → ~0 import edits. One commit each. Verify with
   `npm run typecheck && npm test` between commits.
2. **Phase 2 (MODERATE, do deliberately):** P2 server split, P4 serve split — verbatim cut-paste,
   re-export the previously-exported helpers, snapshot tool-list + metrics before/after.
3. **Phase 3 (DESTABILIZING, defer / explicit approval):** P5 tools subfoldering, P6 test co-location.
   Never combine; one mechanical commit each if approved; expect 100–150+ edited import lines apiece.

**Non-negotiable invariant:** zero behavior change. Tool names, registration order, error envelopes,
metric labels, auth helpers, and the emitted MCP tool list must be byte-identical. Any proposal that
cannot guarantee that (none here, if cut-paste discipline holds) is rejected.

---

## Risk tally

| Risk level | Proposals | Count |
|---|---|---|
| SAFE | P1, P3, P7, P8 | **4** |
| MODERATE | P2, P4 | **2** |
| DESTABILIZING | P5, P6 | **2** |
| **Total** | | **8** |
