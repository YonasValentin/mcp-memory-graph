# E2E Verification Report — mcp-memory-server v2.0.0

Date: 2026-05-29. Method: real processes, real models, real git — no mocks.
Scripts: `/tmp/mcp-e2e/*.mjs` (bruno-proof, real-models, mcp-roundtrip, http smoke).

## ✅ RESOLUTION (post-fix, re-verified on integrated main)

All findings below were fixed across 5 TDD fix-groups (see `.planning/REVIEW.md`), merged to
local `main` (33 commits, not pushed). Integration gate: **build clean, 827 tests pass (76
files), coverage gate green (100/100/99/90)**. Re-verified end-to-end against the integrated dist:

- 🟢 **Reranker + NLI (was 🔴 dead)** — now use `AutoTokenizer` + `text_pair` + `AutoModelForSequenceClassification`. Real-model proof: reranker relevant `+6.543` vs irrelevant `−11.251`; NLI contradiction `0.999`, no paraphrase false-flag. PASS.
- 🟢 **memory_links graph (was 🟡 empty)** — co-occurrence→memory_links bridge + similarity threshold (L2 0.5→1.0) + AMBIGUOUS band. Store 3 entity-sharing memories → **6 edges** (3 co_occurrence/INFERRED, 2 similarity/INFERRED, 1 similarity/AMBIGUOUS). `memory_questions` verify now has live data. PASS.
- 🟢 **Bruno git-share** — still all-pass + now **tombstone-aware** (deletions no longer resurrect on merge) + quoted driver path. PASS.
- 🟢 **CRITICAL migration brick** — v4-floor DB with no schema_version row now stamps `4` (not `9`) → v5–v9 migrations apply. `migrate` CLI added. Regression-tested.
- 🟢 **Security** — XFF-bypass closed (key on socket peer), /publish rate-limited + side-effect-free, symlink-safe vault confinement, constant-time bearer compare. MIT LICENSE added; README privacy claim qualified.

Original findings (pre-fix) retained below for the record.

---

## Summary

| Area | Verdict | Evidence |
|------|---------|----------|
| Build + unit suite | ✅ PASS | `npm run build` clean; 710/710 tests; 60 files |
| **Bruno git-first sharing** | ✅ **PROVEN** | real `git merge` auto-unions, 0 conflict markers, commutative, deterministic conflict resolution |
| MCP stdio transport | ✅ PASS | 37 tools listed + all respond over protocol |
| Real embedder (semantic) | ✅ PASS | cos(dog,puppy)=0.351 ≫ cos(dog,qcd)=0.029 |
| Bi-temporal versioning | ✅ PASS | update creates version, history returned |
| HTTP REST + /publish + headers | ✅ PASS | /health, /api/stats, /api/graph, /api/manifest 200; CSP + nosniff set; publish 200 |
| Entity extraction (known tools) | ✅ PASS | 4 entities + 6 entity_relationships from tool-rich content |
| **Reranker (real model)** | 🔴 **BROKEN** | every input → `LABEL_0` score `1.0`; ordering destroyed |
| **NLI contradiction (real model)** | 🔴 **BROKEN** | every input → identical scores; contradiction never detected |
| **memory_links graph (live)** | 🟡 **NEAR-EMPTY** | 0 edges for 3 highly-similar memories; `/api/graph` + `memory_get.links` empty in normal use |

## 🔴 CRITICAL — reranker + NLI non-functional with real models

`src/search/reranker.ts` and `src/graph/contradiction.ts` call
`pipeline('text-classification')(​{ text, text_pair })`. **transformers.js text-classification
does NOT support the `{text,text_pair}` sentence-pair form** (that is Python-transformers).
Proven: 3 totally different NLI input pairs returned BYTE-IDENTICAL scores
(`entailment 0.871 / neutral 0.122 / contradiction 0.006`), and reranker returned
`LABEL_0=1.0` for both relevant and irrelevant docs → **model output does not depend on input**.

Impact: Pillar 3 `rerank` opt-in and Pillar 4 `on_conflict:supersede` NLI contradiction
path are dead — they silently no-op / mis-score. Opt-in, so v1 defaults are unaffected,
but the features themselves don't work.

**Fix (verified empirically):** replace pipeline use with explicit
`AutoTokenizer.from_pretrained` + `tokenizer(text, { text_pair })` + `AutoModelForSequenceClassification`
→ logits. With this path:
- NLI: contradiction→`contradiction` (0.999), entailment→`entailment` (0.996). id2label `{0:contradiction,1:entailment,2:neutral}`.
- Reranker: relevant logit `+6.543` vs irrelevant `-11.251` (single-logit relevance regressor).

Pure parts (softmax, id2label map, logit→score) are unit-testable; only model load/inference stays c8-ignored.

## 🟡 IMPORTANT — memory_links knowledge graph stays empty in normal MCP usage

`/api/graph` and `memory_get.links` read the `memory_links` store via `getLinksAmong`.
Live test: 3 memories all about the same Docker/Postgres/Redis stack → `memory_links=0`,
`/api/graph` edges=0. Root causes:
1. **Similarity edges** require cosine distance < 0.5 (`similarity-edges.ts` maxDistance 0.5).
   MiniLM gives related sentences ~0.35 cos = 0.65 dist → threshold rarely met → ~0 edges.
2. **Wikilinks** (`[[Title]]`) in `memory_store` content are NOT parsed — only vault sync
   resolves them. Agent storing Obsidian-style links over MCP gets 0 link edges.
3. **Entity co-occurrence** populates `entity_relationships` (6 rows seen) but does NOT appear
   to feed `memory_links`, so memory↔memory co-occurrence edges are absent from `/api/graph`.

Net: the "knowledge graph / better than Obsidian+graphify" headline is thin on the live
write path. The edge STORE works (F1 fix is real — schema, surfacing, REST all wired) but it
rarely gets populated. Needs: lower/auto-tuned similarity threshold, wikilink parsing on store,
and/or co-occurrence → memory_links bridge. (Cross-check with review p1-graph findings.)

## Test-harness notes (not server bugs)
- `/api/search` param is `q` (not `query`); `mode` (not `search_mode`).
- `/api/memories` returns `{ items, ... }` (handleList shape).
- `/publish/:ns` returns HTML (read once as text, then JSON.parse for /api/*).
