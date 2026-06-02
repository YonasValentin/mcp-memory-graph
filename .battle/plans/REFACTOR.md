# mcp-memory-server — DRY / Single-Source-of-Truth Refactor Plan

Scope: every duplication / not-one-source-of-truth issue found by reading source under `src/`.
Each item lists the duplication, exact `file:line` sites, the proposed single source (new or existing module + signature),
blast radius (files touched), and risk. Ordered by priority (correctness-affecting first, then surface area, then cosmetics).

Conventions used below:
- "RETIRED" = a memory that is invalidated (`valid_to` set), transaction-expired (`tx_expired` set), or superseded (`superseded_at` set).
- "currently-valid" predicate today = `valid_to IS NULL AND tx_expired IS NULL` (superseded is inconsistently included — see C1).

---

## P0 — Correctness bugs caused by the duplication (fix first)

### C1. RETIRED-row predicate re-implemented inconsistently (and MISSING in export/stats/manifest)
This is the highest-impact issue: the same "is this row live?" SQL is hand-written ~12 ways, the column set
**differs site to site**, and three read surfaces omit it entirely — so retired/superseded rows leak.

Sites (currently-valid, `valid_to IS NULL AND tx_expired IS NULL`, NO superseded check):
- `src/db/repository.ts:347-354` (listMemories `as_of` branch + default)
- `src/search/hybrid.ts:220-231` (adds `expires_at` + `superseded_at IS NULL` + `as_of` 3-way — the most complete variant)
- `src/search/structured-query.ts:52` (`parent_id IS NULL, valid_to IS NULL, tx_expired IS NULL`)
- `src/tools/tiers.ts:38-42`
- `src/tools/reflect.ts:94-98` and `:185-186`
- `src/tools/attribution.ts:30`
- `src/tools/questions.ts:73, 89-90` (aliased `${a}.valid_to`, `l.valid_to`)
- `src/tools/session-note.ts:59`
- `src/tools/consolidate.ts:287-288`
- `src/graph/entity-store.ts:157-158`
- `src/graph/graph-query.ts:287`
- `src/graph/pagerank.ts:379-381` (adds `superseded_at IS NULL` — inconsistent with siblings)
- `src/graph/graph.ts` tool: `src/tools/graph.ts:161` (`superseded_at IS NULL` only)
- `src/hooks/memory-session-start.ts:118, 132` (`parent_id IS NULL AND superseded_at IS NULL` only)
- `src/vault/writer.ts:170`, `src/vault/canvas.ts:98`
- `src/publish/wiki.ts:43-44`

MISSING the predicate (the actual bug — retired rows surface):
- `src/tools/export.ts:14-37` — `memory_export` dumps superseded/invalidated/forgotten rows into backups.
- `src/tools/stats.ts:11-123` — `total_memories`, `by_scope`, `by_department`, `by_document_type`, `total_content_bytes`
  all count RETIRED rows; only `expired_count` filters anything.
- `src/tools/manifest.ts:17-37` — `memory_manifest` indexes RETIRED rows (only filters `parent_id IS NULL`).

Inconsistency to resolve: pagerank/graph/hooks include `superseded_at IS NULL`; everyone else does NOT. Decide one
canonical definition. Recommended: `superseded_at` is redundant with `valid_to` at supersede time, so the canonical
"currently valid" set is `valid_to IS NULL AND tx_expired IS NULL`, and `superseded_at IS NULL` is folded in for safety
(belt-and-suspenders) so the three graph/hook sites don't silently diverge.

**Single source** — new `src/db/predicates.ts`:
```ts
/** Column-qualifying alias, e.g. 'm' → 'm.'. '' for unaliased queries. */
type Alias = string;
const q = (a: Alias) => (a ? `${a}.` : '');

/** Top-level (non-chunk) memories. */
export function topLevel(a: Alias = ''): string;          // `${a}parent_id IS NULL`

/** Currently-valid (not invalidated, tx-expired, or superseded). */
export function currentlyValid(a: Alias = ''): string;    // `${a}valid_to IS NULL AND ${a}tx_expired IS NULL AND ${a}superseded_at IS NULL`

/** Bi-temporal point-in-time variant; returns { clause, params } binding as_of three times. */
export function validAsOf(asOf: string | undefined, a: Alias = ''): { clause: string; params: string[] };

/** Not yet expired (search-time only). */
export function notExpired(a: Alias = ''): string;        // `(${a}expires_at IS NULL OR ${a}expires_at > datetime('now'))`
```
Every site replaces its hand-written string with these calls. `as_of`-aware sites (hybrid, repository.listMemories)
use `validAsOf`.

- Blast radius: ~17 files (all sites above) + 1 new file. Add the predicate to export.ts / stats.ts / manifest.ts.
- Risk: MEDIUM. Adding the predicate to export/stats/manifest CHANGES OUTPUT (counts drop, retired rows vanish) — this is
  the intended fix but will move test fixtures/snapshots; coordinate with their tests. Folding `superseded_at` into the
  canonical predicate changes the 8 sites that omit it (they will now also hide superseded rows — correct, but verify no
  test asserts a superseded row is returned). Low risk for the structural string swap itself.

### C2. `confidence_level` label thresholds diverge between two scorers
`src/search/scoring.ts:62-66` `confidenceLabel`: `>=0.7 high, >=0.4 medium`.
`src/tools/related.ts:66-67` inline: `>=0.8 high, >=0.5 medium`.
Two different cutoffs label the same `confidence_level` field on the same `SearchResult` type — `memory_related`
and `memory_search` disagree on what "high" means.

- Single source: use existing `confidenceLabel(score)` from `src/search/scoring.ts` in related.ts (decide whether the
  intended cutoff is 0.7 or 0.8 — likely 0.7 to match search).
- Blast radius: 1 file (`src/tools/related.ts`).
- Risk: LOW, but it is a behavior change to related.ts labels; confirm against related.ts tests.

---

## P1 — Tenancy / security logic duplicated (one module)

### T1. MCP forced-namespace vs REST forced-namespace are two implementations of one policy
- MCP: `src/server.ts:199` `forcedNs()`, `:200-203` `withForcedNs()`, `:208-215` `idInForcedNs()`,
  plus the special-cased `query_structured` scoping at `:658-661`.
- REST: `src/api/routes.ts:159-162` `forcedApiNamespace()`, `:176-187` `assertNamespaceAllowed()`.

Both read `process.env.MCP_API_NAMESPACE`, both run the identical `SELECT namespace FROM memories WHERE id = ?`
ownership check, both force the namespace into query options. They can drift (e.g. one trims/length-checks the env var,
the other uses `|| undefined`).

**Single source** — new `src/lib/tenancy.ts`:
```ts
export function forcedNamespace(): string | undefined;                 // single env reader (length-checked)
export function scopeToNamespace<T extends { namespace?: string }>(opts: T): T;   // = withForcedNs
export function scopeFilterToNamespace<T extends { filter?: { namespace?: string } }>(opts: T): T; // query_structured case
export function idIsInForcedNamespace(db, id: string): boolean;        // shared ownership check (MCP returns bool)
// REST keeps its 404-throwing wrapper but calls idIsInForcedNamespace underneath.
```
server.ts and routes.ts both import from here; `forcedApiNamespace` becomes a thin re-export (or is replaced) to keep
the existing `web/`/route imports working.

- Blast radius: 3 files (`src/lib/tenancy.ts` new, `src/server.ts`, `src/api/routes.ts`).
- Risk: MEDIUM. This is a security boundary (cross-tenant leakage). Behavior must stay byte-identical; cover with the
  existing MCP-tenancy + REST-tenancy tests before/after. Watch the env-reader difference (`|| undefined` vs
  `length > 0` check) — unify to the length-checked version (handles `MCP_API_NAMESPACE=""`).

---

## P2 — Scope/enum hand-duplication (single source of allowed values)

### E1. Scope enum `['global','project','user','team','department']` duplicated 11x
- `src/types.ts:1` (`MemoryScope` union)
- `src/schemas/index.ts:9, 15` (scopeField / scopeFieldWithDefault), `:459` (query_structured inline),
  `:1201, 1216, 1229` (Api{Search,List,Manifest}QuerySchema inline)
- `src/config/loader.ts:12`
- `src/vault/sync.ts:297` (`VALID_SCOPES` Set)
- `src/cli/init-wizard.ts:31` (`SCOPE_CHOICES` array)
- `src/tools/extract-learnings.ts:231` (inline cast `as 'global' | ... | undefined`)

### E2. Other enums duplicated the same way
- access_level `['public','internal','confidential','restricted']`: `src/types.ts:3`, `src/schemas/index.ts:44, 50`.
- search_mode `['hybrid','vector','keyword']`: `src/types.ts:5`, `src/schemas/index.ts:154, 696, 1207`.
- content_type `['text','markdown','code','legal','structured']`: `src/types.ts:9`, `src/schemas/index.ts:387`.
- entity_type `['person','project','tool','concept','organization','file','package','pattern']`:
  `src/types.ts:19`, `src/schemas/index.ts:854, 879`.
- learning categories `['decision','pattern','error_fix','convention']`: `src/types.ts:391` (ExtractedLearning union),
  `src/config/loader.ts:43`, `src/schemas/index.ts:836`, `src/tools/extract-learnings.ts:175` (inline).
- sort fields `['created_at','updated_at','title','importance_score','confidence_score','access_count']`:
  `src/types.ts:11`, `src/schemas/index.ts:349, 1223`, `src/db/repository.ts:359`.

**Single source** — new `src/constants/enums.ts` holding the literal tuples; derive both Zod and TS types:
```ts
export const SCOPES = ['global','project','user','team','department'] as const;
export const ACCESS_LEVELS = ['public','internal','confidential','restricted'] as const;
export const SEARCH_MODES = ['hybrid','vector','keyword'] as const;
export const CONTENT_TYPES = ['text','markdown','code','legal','structured'] as const;
export const ENTITY_TYPES = ['person','project','tool','concept','organization','file','package','pattern'] as const;
export const LEARNING_CATEGORIES = ['decision','pattern','error_fix','convention'] as const;
export const SORT_FIELDS = ['created_at','updated_at','title','importance_score','confidence_score','access_count'] as const;
```
- `src/types.ts`: `export type MemoryScope = (typeof SCOPES)[number];` etc.
- `src/schemas/index.ts`: `z.enum(SCOPES)` in scopeField/scopeFieldWithDefault and the inline Api*/query_structured uses.
- `src/config/loader.ts`, `src/vault/sync.ts` (`new Set(SCOPES)`), `src/cli/init-wizard.ts`, `extract-learnings.ts` all import.

- Blast radius: ~8 files + 1 new. types.ts and schemas/index.ts are the big ones.
- Risk: LOW. Pure value-identity refactor; `z.enum` requires a non-empty readonly tuple, which `as const` gives.
  Verify the sort-field allow-list in repository.ts stays a runtime array (it is used with `.includes`).

---

## P3 — Embedder construction duplicated (one accessor)

### M1. Three identical `new CachedEmbeddingProvider(new TransformersEmbeddingProvider())` singletons
- `src/server.ts:173-184` `getEmbedder()` (memoizes the in-flight promise — the best variant).
- `src/lib/direct-access.ts:47-56` `getEmbedder()` (memoizes the resolved value; has a concurrent-first-use race the
  server version already solved).
- `src/cli/rebuild.ts:61-63` inline (no caching).

**Single source** — make `src/lib/direct-access.ts#getEmbedder()` the one accessor, hardened with the promise-memoization
pattern from server.ts (memoize the in-flight `Promise`, not the resolved value, to dedupe concurrent first calls):
```ts
let embedderPromise: Promise<EmbeddingProvider> | null = null;
export function getEmbedder(): Promise<EmbeddingProvider> { /* promise-memoized */ }
```
- `src/server.ts` `getEmbedder` delegates to it (server may keep its own field, but should call the shared builder so the
  TransformersEmbeddingProvider construction lives in exactly one place).
- `src/cli/rebuild.ts` calls `getEmbedder()` instead of constructing inline.

- Blast radius: 3 files.
- Risk: LOW. Note `direct-access.getEmbedder` is `/* c8 ignore */` (real model). Keep server.ts's per-instance lifecycle
  if needed for the McpServer scope, but centralize the construction. Confirm no test depends on `direct-access` returning
  a fresh provider per process.

---

## P4 — Threshold / magic-number constants (one named constant each)

### D1. Duplicate-detection similarity threshold `0.85` hard-coded in 4 places
- `src/tools/consolidate.ts:135` (`?? 0.85` default)
- `src/config/loader.ts:27` (`similarity_threshold ... .default(0.85)`)
- `src/cli/init-wizard.ts:141` (writes `similarity_threshold: 0.85`)
- `src/schemas/index.ts:770` (`MemoryConsolidateSchema ... .default(0.85)`)

### D2. Other dedup magic numbers, scattered with bespoke comments
- `src/tools/store.ts:97` raw L2 `0.7` (NLI supersede shortlist max-distance) — a magic L2 number, not expressed via
  `l2FromCosineSim`.
- `src/tools/extract-learnings.ts:111` `DEDUP_DISTANCE_THRESHOLD = (1 - 0.85) * 2` — uses the OLD linear `1 - d/2`
  approximation, NOT the corrected `l2FromCosineSim` (`sqrt(2(1-cos))`). So extract-learnings' "0.85 similarity" dedup
  is mis-calibrated relative to consolidate's, which DOES use `l2FromCosineSim(0.85)`. This is a latent correctness bug.
- `src/tools/consolidate.ts:237` `confidence_score < 0.3` (low-quality prune cutoff).
- `src/tools/store.ts:212`, `src/vault/rebuild.ts:120` default `confidence_score: 0.7`.
- `src/graph/conflict-resolver.ts:89, 96` overlap `0.85` / `0.75`; `src/search/content-signals.ts:24` importance `0.85`
  (different concept — do NOT merge with dedup threshold; just name them locally).

**Single source** — new `src/constants/thresholds.ts`:
```ts
/** Default cosine-similarity cutoff for "near-duplicate" detection. */
export const DEDUP_COSINE_SIMILARITY = 0.85;
/** Default confidence assigned to auto/derived memories. */
export const DEFAULT_CONFIDENCE_SCORE = 0.7;
/** Low-quality prune confidence floor. */
export const LOW_QUALITY_CONFIDENCE = 0.3;
```
All "0.85 similarity" sites import `DEDUP_COSINE_SIMILARITY`. extract-learnings.ts replaces its hand-rolled
`(1-0.85)*2` with `l2FromCosineSim(DEDUP_COSINE_SIMILARITY)` (fixes D2's mis-calibration — this is also a correctness fix,
could promote to P0 if the regression matters). store.ts's `0.7` NLI shortlist distance stays a NAMED local
(`NLI_SHORTLIST_MAX_L2 = 0.7`) since it is a deliberately-wider L2 net, distinct from the cosine threshold.

- Blast radius: ~6 files + 1 new.
- Risk: LOW for the value-extraction; MEDIUM for the extract-learnings recalibration (it changes which memories dedup —
  intended, but moves behavior; cover with extract-learnings dedup tests).

---

## P5 — Repeated SQL/value-builder helpers (one helper each)

### S1. scope/namespace/department WHERE-clause builder duplicated ~11x
Identical `if (x !== undefined) { conditions.push('x = ?'); params.push(x); }` blocks:
- `src/tools/stats.ts:14-25`, `src/tools/export.ts:17-28`, `src/tools/manifest.ts:20-35`,
  `src/tools/reflect.ts:101-108`, `src/tools/attribution.ts:33-40`, `src/tools/tiers.ts:45-52`,
  `src/tools/consolidate.ts:44-62` (`buildFilterClause`), `src/db/repository.ts:212-217` (deleteByFilter region),
  `:329-344` (listMemories), `src/search/hybrid.ts:176-210` (superset: also document_type/access_level/language/tags/dates),
  `src/vault/writer.ts:170-180`, `src/vault/canvas.ts:98-108`.

**Single source** — add to the new `src/db/predicates.ts`:
```ts
export interface CorpusFilter {
  scope?: string; namespace?: string; department?: string;
  document_type?: string; access_level?: string; language?: string;
}
/** Returns { conditions: string[], params: unknown[] } for the equality filters present. */
export function corpusFilterClauses(f: CorpusFilter, alias?: string): { conditions: string[]; params: unknown[] };
```
Callers append `corpusFilterClauses(...)` to their condition list (combine with `currentlyValid()`/`topLevel()` from C1).
hybrid.ts can use it for the equality subset and keep its tag/date logic local (or extend the helper with tags/dates).

- Blast radius: ~11 files (overlaps heavily with C1 — do C1 and S1 in the same pass per file).
- Risk: LOW-MEDIUM. Mechanical; main risk is alias handling (questions.ts uses table aliases). Keep the SQL byte-identical.

### S2. `dbPath` default resolution duplicated 7x
`process.env.MCP_MEMORY_DB_PATH ?? path.join(os.homedir(), '.mcp-memory', 'memory.db')`:
- `src/db/connection.ts:16-18`, `src/api/routes.ts:59`, `src/tools/stats.ts:104-106`, `src/cli/backup.ts:29`,
  `src/cli/rebuild.ts:45`, `src/cli/init-wizard.ts:36`, `src/hooks/memory-session-start.ts:30`.

### S3. config-path default duplicated 6x
`process.env.MCP_MEMORY_CONFIG_PATH || join(homedir(), '.mcp-memory', 'config.json')`:
- `src/config/loader.ts:84-88` (`resolveConfigPath`, the canonical one), `src/hooks/memory-post-search.ts:26`,
  `src/hooks/memory-stop.ts:46`, `src/hooks/memory-pre-compact.ts:33`, `src/hooks/memory-session-start.ts:60`.
- Plus the bare `.mcp-memory` dir: `src/hooks/memory-post-search.ts:56`, `src/tools/consolidate.ts:71`
  (`search-log.jsonl`), `src/cli/init.ts:222`.

**Single source** — new `src/lib/paths.ts`:
```ts
export function memoryHome(): string;        // join(homedir(), '.mcp-memory')
export function defaultDbPath(): string;     // env MCP_MEMORY_DB_PATH ?? join(memoryHome(), 'memory.db')
export function defaultConfigPath(): string; // env MCP_MEMORY_CONFIG_PATH ?? join(memoryHome(), 'config.json')
export function searchLogPath(): string;     // join(memoryHome(), 'search-log.jsonl')
```
`config/loader.ts#resolveConfigPath` becomes `defaultConfigPath`; `db/connection.ts` uses `defaultDbPath`. Everyone imports.

- Blast radius: ~10 files + 1 new (S2 + S3 share the module).
- Risk: LOW. Tests set `MCP_MEMORY_DB_PATH`/`MCP_MEMORY_CONFIG_PATH` env — preserve the exact env-precedence (`??` vs `||`
  differ in handling empty string; today both are used — unify to `||`/length-check so an empty env doesn't point at a
  literal empty path). Note hooks are standalone scripts; ensure the import doesn't pull the whole server graph in.

### S4. tags-JSON parse-and-filter duplicated
`JSON.parse(row.tags)` → `parsed.filter((t): t is string => typeof t === 'string')`:
- `src/db/repository.ts:382-392` (inside `rowToMemory`), `src/tools/manifest.ts:58-68`.
- Single source: export a `parseTags(raw: string | null): string[]` from `src/db/repository.ts` (or a small
  `src/db/serialization.ts`); manifest.ts imports it. metadata-parse in `rowToMemory:394-404` is a similar candidate
  (`parseMetadata`).
- Blast radius: 2 files. Risk: LOW.

### S5. `age_days` + `freshness_warning` computation duplicated
- age_days `Math.floor((Date.now() - new Date(x).getTime()) / 86_400_000)`: `src/search/hybrid.ts:31-33` (`memoryAgeDays`),
  `src/tools/manifest.ts:70-73`, `src/tools/related.ts:69`. (`86_400_000` also in `src/search/temporal.ts:37`,
  `src/search/tiers.ts:25` `MS_PER_DAY`, `src/tools/consolidate.ts:171, 295` — these are a shared `MS_PER_DAY` const.)
- freshness_warning string + 90/30-day thresholds: `src/search/hybrid.ts:35-39` (`freshnessWarning`) vs the inline
  copy in `src/tools/related.ts:78-83` (byte-identical messages).

**Single source** — export `memoryAgeDays(iso: string): number` and `freshnessWarning(ageDays: number): string | null`
from `src/search/hybrid.ts` (or a small `src/search/freshness.ts`), and a `MS_PER_DAY` const from one place
(e.g. `src/search/tiers.ts` already has it — promote to a shared `src/constants/time.ts`).
- Blast radius: 3-5 files. Risk: LOW (related.ts output already identical; manifest gains the helper).

---

## P6 — `types.ts` as a manual mirror of Zod schemas (infer where feasible)

### Y1. Hand-written TS interfaces duplicate the Zod schema shapes
`src/types.ts` declares `MemoryInput`, `MemoryUpdate`, and the enum unions by hand while `src/schemas/index.ts`
declares the same shapes in Zod. They are kept in sync manually (e.g. `on_conflict`, `agent_id` exist in both).
Feasible `z.infer` conversions:
- enum unions (`MemoryScope`, `AccessLevel`, `SearchMode`, `ContentType`, `EntityType`, `SortField`) → derive from the
  shared tuples in E1/E2 (cleanest), OR `z.infer` of the field schemas.
- `MemoryInput` ≈ `z.infer<typeof MemoryStoreSchema>` (modulo `confidence_score`, which is in `MemoryInput` but not the
  store schema — reconcile), `MemoryUpdate` ≈ `z.infer<typeof MemoryUpdateSchema>`,
  `IngestOptions` ≈ `z.infer<typeof MemoryIngestSchema>`.

NOT feasible / leave as hand-written: `Memory`, `MemoryRow` (DB row vs domain object — DB-shaped, no schema),
`SearchResult`, `MemoryStats`, vault/graph result types (server output contracts, no input schema).

- Single source: schemas in `src/schemas/index.ts` (+ tuples from E1/E2) become the source for input-shaped types;
  `types.ts` re-exports `z.infer` aliases. Keep DB/output types in `types.ts`.
- Blast radius: `src/types.ts`, `src/schemas/index.ts`, and any importer that relied on a slightly-wider hand type
  (e.g. extract-learnings.ts inline scope cast — fixed by E1 anyway).
- Risk: MEDIUM. `z.infer` of a schema with `.default()` makes the field non-optional in the OUTPUT type but optional in
  the INPUT type — pick `z.input<>` vs `z.infer<>` deliberately per field, or the handler signatures shift. Do this
  LAST, after E1/E2 land, and only for the clearly-1:1 input types. Highest churn-to-value ratio of the set.

---

## Suggested execution order
1. C1 + S1 (+ S4 tags) together, per file — they touch the same WHERE-clauses. Fixes the export/stats/manifest leak.
2. C2 (1-line label fix), D2 extract-learnings recalibration (correctness).
3. T1 tenancy module (security boundary, isolated).
4. E1 + E2 enum tuples → then Y1 type inference on top.
5. M1 embedder accessor, S2/S3 paths, D1 threshold, S5 freshness — independent, low-risk cleanups.

## New modules introduced (single sources)
- `src/db/predicates.ts` — retired-row predicate + corpus filter clauses (C1, S1).
- `src/lib/tenancy.ts` — forced-namespace policy (T1).
- `src/constants/enums.ts` — enum tuples (E1, E2; feeds Y1).
- `src/constants/thresholds.ts` — dedup/confidence constants (D1, D2).
- `src/lib/paths.ts` — db/config/log path resolution (S2, S3).
- (optional) `src/search/freshness.ts` or reuse hybrid.ts exports + `src/constants/time.ts` for `MS_PER_DAY` (S5).
