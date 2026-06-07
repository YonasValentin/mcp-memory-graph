# Multi-Tenancy v14 Structural Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) + superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the shared knowledge-graph tables tenant-safe by SCHEMA (namespace dimension), so shared-DB multi-tenancy converges in an adversarial battle and the experimental gate can be removed — without regressing single-user.

**Architecture:** Option A + global-shared, total-isolation-under-forcing. Add `scope`/`namespace` columns to the 5 graph tables (`entities`, `entity_aliases`, `entity_relationships`, `memory_links`, `memory_conflicts`). Entity identity becomes `(normalized_name, scope, namespace)`. An entity inherits the owning memory's `(scope, namespace)`: scope='global' memories → entity `(global,'')` (cross-project bridge, single-user); project/user/team → owning ns (isolated). Unforced reads have NO predicate (global view = current single-user behavior, unchanged). Forced reads add `AND namespace = ?` (total isolation; global rows ns='' are NOT matched). `mention_count` becomes per-`(name,scope,ns)` automatically. The existing ~12 per-tool patches stay as belt-and-suspenders + regression oracle.

**Tech Stack:** TypeScript, better-sqlite3, sqlite-vec 0.1.10-alpha.4, vitest. Migration pattern: `columnExists` guard + additive ALTER (matches v12/v13).

**Non-negotiables:** TDD red→green every step. Full `npm test` + `npm run smoke` + `npm run bench` (HOLD P@1 .813/MRR .867) + coverage floors 96/95/95/86 between phases. Real-runtime: every `scripts/battle/*` + a NEW `sim-multitenant.mjs`. Battle waves loop until one CONVERGES (0 confirmed). Branch `multitenancy-v14-structural`, PR at end, NO merge to main.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/db/schema.ts` | DDL + `CURRENT_SCHEMA_VERSION` | Add scope/ns cols to 5 tables; bump 13→14; rebuild unique indexes |
| `src/db/migrations.ts` | Versioned migration | `migrateToV14`: ALTER+backfill+index rebuild, columnExists-guarded |
| `src/graph/entity-store.ts` | Entity/relationship write + mention_count | Plumb partition; key identity on (name,scope,ns); stamp on insert; scope reads under forcing |
| `src/graph/memory-links.ts` | Edge write/read | Stamp scope/ns from source memory; refuse/skip cross-ns edges |
| `src/graph/conflict-resolver.ts` | Conflict record | Stamp scope/ns from new memory |
| `src/tools/extract-entities.ts` | Alias insert | Stamp scope/ns; plumb memory partition |
| `src/tools/store.ts` | store→extract call | Pass `row.{scope,namespace}` into storeExtractedEntities |
| `src/vault/rebuild.ts` | vault rebuild→extract call | Pass `parsed.{scope,namespace}` |
| `src/tools/graph.ts`, `communities.ts`, `src/graph/communities.ts`, `pagerank.ts` | Unpartitioned entity reads | Add direct `namespace=?` predicate under forcing |
| `scripts/battle/sim-multitenant.mjs` | NEW real-MCP 2-tenant shared-DB leak sim | Create (template: sim-longterm.mjs) |
| `src/lib/tenancy.ts`, `src/index.ts` | Gate | Remove `warnIfExperimentalTenancy` after convergence |
| `docs/MULTI-TENANCY.md` | Doc | Rewrite "experimental"→"supported (shared-DB via schema-v14)" |

---

## Phase 1 — Schema v14 + migration

### Task 1: Add scope/namespace columns to graph tables (schema.ts)

**Files:** Modify `src/db/schema.ts:346-407`; Test `src/__tests__/db/schema-v14.test.ts`

- [ ] **Step 1** Write failing test: fresh DB → assert `entities`, `entity_aliases`, `entity_relationships`, `memory_links`, `memory_conflicts` each have `scope` (NOT NULL default 'global') and `namespace` (NOT NULL default '') via `PRAGMA table_info`. Assert `CURRENT_SCHEMA_VERSION === 14`. Assert UNIQUE index on `entities(normalized_name,scope,namespace)` and `entity_aliases(normalized_alias,scope,namespace)` exist (via `PRAGMA index_list`).
- [ ] **Step 2** Run `npx vitest run src/__tests__/db/schema-v14.test.ts` → FAIL.
- [ ] **Step 3** Edit schema.ts: add `scope TEXT NOT NULL DEFAULT 'global'`, `namespace TEXT NOT NULL DEFAULT ''` to the 5 tables. Replace `idx_alias_normalized` with `UNIQUE(normalized_alias,scope,namespace)`. Add `CREATE UNIQUE INDEX idx_entities_identity ON entities(normalized_name,scope,namespace)`. Add `idx_*_ns` covering indexes on `(scope,namespace)` for entities + relationships. Bump `CURRENT_SCHEMA_VERSION = 14`. (memory_links DDL is also in `MEMORY_LINKS_DDL` const used by migrations — update both.)
- [ ] **Step 4** Run test → PASS.
- [ ] **Step 5** Commit `feat(schema): v14 add scope/namespace to graph tables + identity indexes`.

### Task 2: migrateToV14 — ALTER + backfill + index rebuild (migrations.ts)

**Files:** Modify `src/db/migrations.ts`; Test `src/__tests__/db/migrate-v14.test.ts`

- [ ] **Step 1** Write failing tests on a v13 DB seeded with: entities (no scope/ns), memory_links between two `ns='projA'` memories, a cross-ns link projA↔projB, memory_conflicts. After `migrateDatabase`: (a) every graph row has scope/ns columns; (b) pre-existing entities default `(global,'')`; (c) memory_links backfilled ns from source memory (projA link → ns 'projA'); (d) idempotent (run twice, no throw); (e) from-0 path (fresh init then migrate) works.
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Implement `migrateToV14(db)`: for each table, `if (!columnExists(...))` ALTER ADD scope/ns. Backfill `memory_links.namespace`/`scope` from `(SELECT namespace,scope FROM memories WHERE id=source_memory_id)`; same for `memory_conflicts` from `new_memory_id`. entities/aliases/relationships keep DEFAULT (global,''). DROP+CREATE the rebuilt unique indexes (guard: only if old shape present). Wire into `migrateDatabase` version ladder (13→14). Guard the legacy from-0 path like v12/v13.
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5** Run FULL `npm test` → all green (no regression). Commit `feat(migrations): v14 backfill graph-table tenancy from owning memories`.

### Task 3: Migrate a populated real-shape DB (safety)

**Files:** reuse `.battle/migrate-populated-v11.mjs` pattern (gitignored helper)

- [ ] **Step 1** Copy the user's NEVER — use a throwaway: build a populated v13 DB via `sim-longterm` style seed, snapshot row counts, run v14 migration, assert 0 row loss + all graph rows scoped. (Real DB is never touched; agents use /tmp.)
- [ ] **Step 2** Commit nothing (gitignored) — record result in plan notes.

---

## Phase 2 — Write path: stamp scope/namespace

### Task 4: Plumb partition into storeExtractedEntities + findOrCreateEntity

**Files:** Modify `src/graph/entity-store.ts`; Test `src/__tests__/graph/entity-store-tenancy.test.ts`

- [ ] **Step 1** Failing test: `storeExtractedEntities(db, memId, ents, 'regex', {scope:'project',namespace:'projA'})` → entity rows have scope='project', ns='projA'. Same name under `{global,''}` → SEPARATE row. Same name+scope+ns → SAME row, mention_count increments. mention_count is per-(name,scope,ns).
- [ ] **Step 2** Run → FAIL (signature lacks partition).
- [ ] **Step 3** Add optional `partition?: {scope:string;namespace:string}` (default `{scope:'global',namespace:''}`) to `storeExtractedEntities`, `findOrCreateEntity`, `findOrCreateRelationship`, `buildCooccurrenceEdges`, `buildMemoryCooccurrenceLinks`. SELECT in findOrCreateEntity keys on `normalized_name AND scope=? AND namespace=?`; INSERT stamps them. Relationship insert stamps partition. `mentionCount()` reads the specific entity row (already by id → inherently scoped). 
- [ ] **Step 4** Run → PASS.
- [ ] **Step 5** Commit `feat(graph): entity identity = (name,scope,namespace); per-tenant mention_count`.

### Task 5: Pass owning memory partition from store + vault rebuild

**Files:** Modify `src/tools/store.ts:338`, `src/vault/rebuild.ts:185`; Test extend entity-store-tenancy

- [ ] **Step 1** Failing test: `handleStore({content, scope:'project', namespace:'projA'})` → extracted entities are `(project,projA)`. Forced-ns store (withForcedNs already applied upstream) → entities carry forced ns.
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** store.ts: `storeExtractedEntities(db, row.id, entities, 'regex', {scope: row.scope, namespace: row.namespace})`. rebuild.ts likewise from `parsed`.
- [ ] **Step 4** Run → PASS. Commit `feat(store): stamp owning-memory partition onto extracted graph`.

### Task 6: Stamp memory_links + memory_conflicts; refuse cross-ns edges

**Files:** Modify `src/graph/memory-links.ts:40`, `src/graph/conflict-resolver.ts:171`; Test extend

- [ ] **Step 1** Failing test: `createMemoryLink` between two projA memories → link ns='projA'. A cross-ns link (projA→projB) is SKIPPED (or stamped source-ns + never traversed cross-ns). recordConflicts stamps new memory's ns.
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** createMemoryLink: read source memory's (scope,ns), stamp the edge; if target ns differs, skip the auto-edge (co-occurrence never crosses tenants). recordConflicts: stamp from new memory.
- [ ] **Step 4** Run → PASS. Commit `feat(graph): stamp + same-tenant constraint on links/conflicts`.

### Task 7: Stamp entity_aliases

**Files:** Modify `src/tools/extract-entities.ts:74`; Test extend

- [ ] **Step 1** Failing test: alias insert under partition → alias row carries scope/ns; two tenants may both alias "pg"→PostgreSQL (UNIQUE now includes scope/ns).
- [ ] **Step 2-4** Implement, run, commit `feat(graph): stamp entity_aliases partition`.

---

## Phase 3 — Read path: direct namespace predicate under forcing

### Task 8: Scope unpartitioned entity reads (graph.ts, communities, pagerank, entity-store strength)

**Files:** Modify `src/tools/graph.ts:116`, `src/graph/communities.ts:120/137`, `src/graph/pagerank.ts:168`, `src/graph/entity-store.ts:296` (mentionCount/edgeStrength); Test `src/__tests__/graph/read-tenancy-structural.test.ts`

- [ ] **Step 1** Failing test: forced ns='projA' → `handleGraph` entity selection returns NO entity that exists only in projB; relationship strength uses projA mention_count only; communities build over projA entities only. Unforced → sees all (unchanged).
- [ ] **Step 2** Run → FAIL.
- [ ] **Step 3** Add `AND namespace = ?` (and bind forced ns) to the raw entity/relationship SELECTs when forcing is on. The existing memory-join patches stay (belt-and-suspenders). Total isolation: global rows (ns='') NOT matched under forcing — that is intended.
- [ ] **Step 4** Run → PASS + FULL `npm test` green. Commit `feat(graph): structural namespace predicate on entity/relationship reads`.

### Task 9: Re-confirm all 15 oracle test files still green; remove now-redundant comments

- [ ] **Step 1** Run the full oracle: `npx vitest run src/__tests__/tools/{class3,class4,class5,rebattle,rebattle2,rebattle3,rebattle4}*-* src/__tests__/lib/tenancy*` → ALL green.
- [ ] **Step 2** Commit if any test helper needed an update (should not).

---

## Phase 4 — Real-runtime gates + NEW multi-tenant sim

### Task 10: sim-multitenant.mjs (2 tenants, one shared DB, forced ns, ZERO leak)

**Files:** Create `scripts/battle/sim-multitenant.mjs` (template: `sim-longterm.mjs`)

- [ ] **Step 1** Write the sim: one DB; tenant A (`MCP_API_NAMESPACE`-style forced 'tenant-a') and tenant B ('tenant-b') each store overlapping-concept memories (shared entity names like "PostgreSQL", "auth"), build graph, run EVERY read tool (search, query, graph, communities, questions, insights, health, related, attribution, revalidate, unlinked_mentions, canvas, export). Assert: NO result from A contains any B id/title/content/entity/count, and vice-versa. Integrity ledger per tenant (no lost/leaked rows). Run with real embedder.
- [ ] **Step 2** Run `node scripts/battle/sim-multitenant.mjs` → must report ZERO cross-tenant leakage. Fix any leak TDD (add oracle test first).
- [ ] **Step 3** Commit `test(battle): sim-multitenant 2-tenant shared-DB zero-leak gate`.

### Task 11: Full gate sweep

- [ ] Run, in order, and record output: `npm test`; `npm run smoke`; `npm run bench` (assert P@1 .813/MRR .867 held); `npx vitest run --coverage` (floors 96/95/95/86); `node scripts/battle/{verify-e2e-hardening,verify-stress,verify-load,verify-scale,verify-nli,verify-hooks,sim-solo,sim-team,sim-longterm,sim-multitenant}.mjs`. Any failure → TDD fix → re-run.

---

## Phase 5 — Adversarial battle to CONVERGENCE

### Task 12: Battle wave (Workflow): attackers → 3-skeptic refute-verify → completeness critic

- [ ] **Step 1** Run a Workflow: N attacker agents (shared-table sweep, fixed-k sweep, write-path partition sweep, REST-surface sweep, completeness critic) attacking BOTH single-user and multi-tenant on throwaway /tmp DBs. Each candidate → 3 skeptics (default refuted) → confirmed = ≥2/3 reproduce.
- [ ] **Step 2** For each confirmed: add a RED oracle test, fix GREEN, commit. Re-run full gates.
- [ ] **Step 3** Repeat waves until ONE CONVERGES (0 confirmed). Record each wave's count (expect decreasing → 0).

### Task 13: Remove gate + rewrite docs (ONLY after convergence)

**Files:** `src/lib/tenancy.ts` (remove `warnIfExperimentalTenancy`), `src/index.ts:13-14`, `docs/MULTI-TENANCY.md`

- [ ] **Step 1** Remove the gate fn + its call. Update the gate's tenancy.test if it asserts the warning.
- [ ] **Step 2** Rewrite MULTI-TENANCY.md: shared-DB is SUPPORTED via schema-v14 namespace dimension; document the global-shared + total-isolation-under-forcing model; keep one-DB-per-tenant as the strongest boundary.
- [ ] **Step 3** Final full gate sweep. Commit `feat(tenancy): graduate shared-DB multi-tenancy to supported (schema v14)`.

### Task 14: Push branch + open PR (NO merge)

- [ ] `git push -u origin multitenancy-v14-structural`; `gh pr create` with the convergence evidence (wave counts, gate outputs, bench-held, coverage). STOP for user review.
