# Battle-Test Report — mcp-memory-server v1.0.0

Date: 2026-05-29. Local repo (16 commits ahead of origin/main). Build clean, 452/452 tests pass (23 files, 1.93s).

## Method
- `npm run build` (tsc) → clean.
- `npm test` (vitest + coverage) → 452 passing.
- Custom in-process stress harness (`/tmp/mcp-stress/stress.mjs`) against `dist/`, MockEmbeddingProvider for scale, file-backed SQLite, 5000 memories.

## Performance (5000 memories, single process, M-class mac)

| Metric | Result |
|--------|--------|
| Store throughput | **424/sec** (2.36 ms/store incl. embed + conflict scan + entity extract + insert) |
| Bulk store 5000 | 11.8 s |
| DB size | 17.3 MB |
| Search hybrid | p50 **2.24 ms** · p95 3.25 ms · p99 9.05 ms |
| Search vector | p50 2.10 ms · p95 2.72 ms |
| Search keyword | p50 0.11 ms · p95 1.10 ms |
| 100 parallel hybrid searches | 940 ms total |
| Memory footprint | RSS 148 MB · heap 7.3 MB (no leak) |
| Consolidate (dream cycle) dry-run on 5000 | 7.3 s, scored 5003, found+merged 2 dups |

Verdict: **fast and stable at scale.** Sub-3ms hybrid search at 5k rows; linear store throughput; flat heap.

## Correctness / robustness wins
- **Dedup**: 50 identical stores → 49 deduped to one canonical row (exact-duplicate detection works).
- **FTS injection**: `"; DROP TABLE memories; --` query → 10 hits, table intact. Sanitizer holds.
- **Empty query**: handled gracefully (returns results, no throw).
- **1 MB content**: stored ok.
- **Unicode + SQL-ish content**: stored ok.

## 🔴 Findings

### F1 (HIGH) — Knowledge graph is edgeless on the automatic path
- After 5000 memories: 53 entities, 17,667 `memory_entities` links, **0 `entity_relationships`**.
- Root cause: `storeExtractedEntities()` (src/graph/entity-store.ts:84) creates entity nodes + memory links but never calls `findOrCreateRelationship()`. The only caller of `findOrCreateRelationship` is `handleExtractEntities` (the LLM `memory_extract_entities` tool), which only fires when the caller hand-supplies a `relationships[]` array. The regex extractor (`extractEntitiesRegex`) emits entities but no relationships.
- Effect: the D3 graph view, entity `path`, and "related via graph" are hollow by default — nodes float with no edges. The graph is really an entity *index*, not a graph.
- This is the single biggest lever for a "graphify-like" revolution: materialize co-occurrence (and typed semantic) edges automatically on store.

### F2 (LOW) — `handleStats` has a non-defensive signature
- `handleStats(db, input)` reads `input.scope` with no `input ?? {}` guard; called with no input it throws `Cannot read properties of undefined (reading 'scope')`. The MCP/zod layer supplies `{}` in production, so this is not a live bug — but a one-line guard would make it safe for direct/programmatic callers.

### F3 (INFO) — Regex entity extraction is shallow + noisy
- Only 53 distinct entities from 5000 memories; dominated by the `\w+Service`/`\w+Pattern` regex (e.g. `VitestService`, `ReactService` as `pattern` type). Precision/recall both low. Fine as a zero-cost baseline, but not a real NER — an opt-in better extractor (or co-occurrence + alias resolution) would raise graph quality a lot.

## Live HTTP server smoke (real `node dist/index.js serve`, port 3199, scratch DB)
- `/live` ok; `/health` → `db_ok:true, schema_version:4`; `/ready` warmed the **real** embedder in **0.78 s** (model `Xenova/all-MiniLM-L6-v2`, 384-dim, cached).
- Security headers all present on every response: CSP (locked-down), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP, CORP, `X-Request-Id`.
- **DNS-rebind guard works**: `Host: evil.com` → `403 BAD_HOST`.
- `/metrics` Prometheus exposition live (gated behind `MCP_METRICS_ENABLED=1`).
- REST `/api/stats`, `/api/search`, `/api/graph`, `/api/memories` all return correct shapes (empty store → empty arrays, no errors). Confirms F2 is only the no-arg direct-call case.

## Real-embedder latency (in-process, TransformersEmbeddingProvider, N=60)
- init 291 ms (cached model). Store p50 **5.13 ms** / p95 15.74 ms / max 30 ms (incl. real embed + conflict scan + entity extract + insert). Search p50 **2.37 ms** / p95 4.54 ms.
- Local embeddings are cheap here — no cloud needed, sub-6ms stores.

## Obsidian vault sync round-trip (3 interlinked notes, real `handleVaultSync`)
- Imported 3 `.md` notes correctly: titles from frontmatter, tags from frontmatter + inline `#tags`, content chunked, 16 ms.
- **F1 escalation — wikilinks discarded as graph signal**: `[[JWT]]`, `[[Auth]]`, `[[Middleware]]` are parsed (`parser.ts` `extractLinks`) and then stored only as opaque `metadata.links` JSON (`sync.ts:291`). They are **never resolved to target memory IDs, never materialized as edges, and invisible to `/api/graph` and the D3 view**. Result after sync: `entities: []`, `entity_relationships: 0`, and **no memory↔memory link table exists at all**.
- Net: importing an Obsidian vault — whose entire value is its hand-curated link graph — throws the link graph away. The richest human edge signal is lost.

## The graph gap, fully characterized (F1)
The graph layer ignores the two richest edge signals and has no persistent edge store:
1. **Human wikilinks** (vault) → saved as dead `metadata.links` JSON, never resolved into edges.
2. **Entity co-occurrence** (store) → `memory_entities` is populated (17k links at 5k scale) but `findOrCreateRelationship` is never called on this path, so `entity_relationships` stays empty.
3. **No memory↔memory edge table** exists.
4. `/api/graph` synthesizes edges from **vector KNN at render time only** — ephemeral, ignoring (1), (2), and any typed/semantic relationships.

**The wedge**: a true, persistent, multi-signal memory graph that fuses human wikilinks + entity co-occurrence + typed semantic relationships + vector similarity, each edge confidence-tagged (graphify's EXTRACTED / INFERRED / AMBIGUOUS), with edge resolution on store/sync — replacing the current edgeless/ephemeral state. Everything needed (`entity_relationships`, `findOrCreateRelationship`, `memory_entities` co-occurrence, parsed wikilinks) already exists; it is wiring + one new resolved-link table away.

## Headline verdict
Production-solid core: fast, leak-free, injection-safe, well-secured. The one structural gap is **F1 — the auto knowledge graph has no edges**. Everything needed to fix it already exists (`findOrCreateRelationship`, `entity_relationships` table, `memory_entities` co-occurrence data) — it is simply never wired into the store path. That gap is also the clearest runway to "revolutionary."
