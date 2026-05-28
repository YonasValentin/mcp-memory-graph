# 00 — SYNTHESIS: Making mcp-memory-server Revolutionary

**Author:** Principal product + engineering strategy
**Date:** 2026-05-29
**Inputs:** Reports 01 (graphify), 02 (Obsidian model), 03 (competitive landscape), 04 (KG/agentic-memory research), 05 (current-capabilities audit — verified against source on disk).

> This is a positioning + roadmap document, not a feature dump. It answers one question:
> **What can THIS server be that no one else can?** Everything below is buildable on the
> existing stack — SQLite + sqlite-vec (vec0) + FTS5 + local `@huggingface/transformers`
> embeddings + the existing entity/conflict/version tables — with **zero cloud dependency**,
> using the consuming Claude agent (via MCP tools) as the only LLM.

---

## 1. Where we actually are (current_position)

The server is a **legitimately strong local hybrid-search + memory-hygiene engine** with a
**bolted-on, mostly-inert knowledge graph** and a **read-only, link-blind Obsidian importer**.

What is genuinely good and production-grade (do NOT re-propose these):

- **RRF hybrid search** (`src/search/hybrid.ts`): sqlite-vec + FTS5 fused at K=60, FTS
  sanitizer, importance boost, temporal decay with access-count half-life scaling,
  confidence labels, freshness warnings, metadata filters, `superseded_at IS NULL` gate.
- **On-store conflict/dedup** (`src/graph/conflict-resolver.ts`): vec-KNN + Jaccard buckets
  → duplicate / superseded / contradicted, writes `memory_conflicts`, marks `superseded_at`.
- **6-stage "dream cycle"** (`src/tools/consolidate.ts`): decay → quality → expire → prune →
  dedup-merge → knowledge-gaps, all under operation/embedding/time budgets.
- **Clean v4 schema** with the full graph table set already present: `entities`,
  `entity_aliases`, `entity_relationships`, `memory_entities`, plus `memory_conflicts`,
  `memory_versions`, `memory_originals`, `memory_access_log`, `vault_sync_meta`,
  `ingest_source_tracking`. Three-table atomic insert (memories + vec0 + FTS5).
- **22 MCP tools**, pure handlers shared by MCP + REST, Prometheus metrics, Claude Code
  hooks (SessionStart / PostToolUse / PreCompact / Stop), D3 web dashboard, 452 tests.
- **Privacy-by-architecture**: single-file SQLite, local embedder, zero telemetry/cloud.

The honest weaknesses that define our opening (verified in source):

- **The graph is a bag of nodes with almost no edges.** The auto-store path
  (`entity-extractor.ts`) creates entity *nodes* via regex (a hardcoded 19-tool allowlist),
  but `findOrCreateRelationship` is **only ever called by `memory_extract_entities`** — the
  manual LLM tool. No co-occurrence edges, no wiki-link edges; `strength` is a constant 0.5.
- **The Obsidian link graph is parsed then thrown away.** `[[wiki-links]]` land as a raw
  string array in `metadata.links` (`vault/sync.ts:291`) and are never resolved to memory
  IDs or edges. Vault notes bypass `handleStore`, so they get neither entity extraction nor
  conflict detection — second-class citizens.
- **The web "Knowledge Graph" is a vector-similarity view of memories, not the entity graph.**
  The real graph layer has no UI at all.
- **Only temporal *decay*, not bi-temporal *validity*.** We can boost/penalize by age but
  cannot answer "what was true on date X" or invalidate-without-deleting.
- **Extraction is heuristic, never inline-reconciled.** No ADD/UPDATE/DELETE/NOOP write gate,
  no contradiction detection at write time (only post-hoc dedup).
- **`maturityTier` (draft/validated/core) is computed-able but surfaced nowhere.**
- **Vault is read-only, no watcher** — an importer, not a vault.

**One-line:** we own the *retrieval + hygiene* substrate and already ship the *schema* for a
knowledge graph; we have not yet shipped the *graph algorithms, the temporal model, the
self-correcting write discipline, or the two-way vault* that would make the memory feel alive.

---

## 2. The single unique wedge

> **The local-first, agent-native, vault-backed "second brain" that is simultaneously a
> temporal knowledge graph and an editable Obsidian artifact — with a provable, GDPR-grade
> audit trail — running entirely on-device with no cloud LLM.**

Why no competitor occupies this exact ground (triangulated from reports 01–04):

| Competitor | What they have | What they structurally cannot be |
|---|---|---|
| **graphify** | Best-in-class code→graph, no-embedding clustering, committable graph, agent-first traversal | **No temporal model** (its own issue #152 wants "agentmemory temporal + graphify structural"); code-centric; not a human-editable vault |
| **Zep / Graphiti** | Bi-temporal KG, fact invalidation | Cloud/server platform; not local-first; not vault-native; no human-editable surface |
| **mem0 / supermemory** | Benchmark-leading extraction, managed API | Cloud-first; privacy punted to app layer; no vault; not on-device |
| **Obsidian** | The beloved local vault, links, graph, Canvas, Publish | **Human-driven** — cannot auto-link, cannot reason temporally, has no agent memory semantics |
| **basic-memory / claude-mem** | Local MCP, markdown, auto-capture | No typed-relation graph, no bi-temporal validity, no graph algorithms |
| **Letta / MemoryOS** | Self-editing tiers, OS-style memory | Framework/runtime, not a vault; not local-first SQLite; no Obsidian round-trip |

**Nobody fuses all four axes at once:** (1) local-first/on-device + GDPR-grade audit,
(2) a real *temporal* knowledge graph, (3) graphify-class *structural* graph + agent-first
traversal, (4) a *human-editable Obsidian vault* round-trip. That four-way intersection is
empty white-space, and our existing stack is unusually well-positioned to fill it.

**Positioning line (Obsidian's "Writing is telepathy" frame):**
> *Give your agents telepathy across time — a local brain that links itself, remembers when
> things were true, and lives inside your Obsidian vault.*

---

## 3. Revolutionary candidates

Each builds on an existing module. Effort: S (<1d) / M (~2–4d) / L (~1–2wk) / XL (multi-wk).
Impact: low / medium / high / game-changing.

| # | Title | Effort | Impact | Builds on | Why novel |
|---|---|---|---|---|---|
| C1 | **Self-weaving graph** (auto-edges from co-occurrence + wiki-links + PPR) | M | game-changing | `entity-extractor.ts`, `entity-store.ts`, `vault/sync.ts`, `hybrid.ts` | Obsidian can't auto-link; graphify needs LLM for semantics; combine co-occurrence + resolved wiki-links + IDF-weighted strength + HippoRAG PPR as a 3rd ranker |
| C2 | **Bi-temporal memory** (valid-time + tx-time, invalidate-don't-delete) | M | game-changing | schema + `conflict-resolver.ts` + `consolidate.ts` | Only Zep/Graphiti have it, and they are cloud. First local-first vault memory that answers "what was true on date X" |
| C3 | **Self-correcting write gate** (ADD/UPDATE/DELETE/NOOP + local NLI) | L | high | `store.ts` + `conflict-resolver.ts` | mem0 has it via cloud LLM; we do it locally with a small NLI cross-encoder over the similarity shortlist, escalating only ambiguous cases to the agent |
| C4 | **Two-way Obsidian vault** (write-back + watcher + Canvas + Publish) | L | game-changing | `vault/sync.ts`, `vault/parser.ts`, web dashboard | Memory becomes a real `.md`/`.canvas` artifact editable in the user's actual Obsidian; basic-memory only writes flat notes, nobody emits JSON Canvas with typed edges |
| C5 | **Confidence/provenance + auto-verify questions** (EXTRACTED/INFERRED/AMBIGUOUS) | S | high | existing `provenance`/`confidence_score` columns + `consolidate.ts` | graphify's honest audit trail, but on a *temporal* store; AMBIGUOUS + stale facts auto-generate a "verify this" digest for the agent |
| C6 | **Reflection / sleep-time insight synthesis** (agent-as-LLM via MCP) | M | high | `consolidate.ts` (dream cycle) + hooks | Generative-Agents reflection + A-MEM evolution, but the consuming Claude agent supplies generation through a `memory_reflect` tool — no cloud |
| C7 | **Pinned core-memory tier + self-edit** (MemGPT-native over MCP) | S | high | `condensation_level`/`maturityTier` + new tool | An MCP memory server already IS the archival tier; add a pinned working set the agent reads each session and edits — nearly free, reframes us from "search box" to "agent OS memory" |
| C8 | **GDPR-grade compliant-memory layer** (consent / retention / right-to-forget / audit) | M | high | `access_level`/`department` + `memory_access_log` + delete | The unclaimed white-space: every cloud platform punts privacy to the app layer; we are already 100% local and audit-trailed |
| C9 | **Shareable read-only memory wiki** (Obsidian Publish-style, behind tunnel) | M | medium | web dashboard + `access_level` + `/api/graph` | A public "digital garden" over a chosen namespace: pages, backlinks, graph, search — gated by `access_level`, deployed behind the existing Cloudflare Tunnel |
| C10 | **Local cross-encoder reranker** (precision fix for weak MiniLM) | S | medium | `hybrid.ts` final stage | Anthropic measured reranking dropping failure 2.9%→1.9%; biggest precision-per-line win for the weak all-MiniLM base, fully local via `@huggingface/transformers` |
| C11 | **GraphRAG community summaries + global search** ("what do I know about X overall") | M | medium | `entity_relationships` + `consolidate.ts` + agent tool | Leiden/Louvain is local graph math; only per-community summaries need the agent. Adds a "summarize everything" capability the retriever entirely lacks |
| C12 | **Unified, time-lapse-able graph dashboard** (entity graph + temporal replay) | M | medium | `web/KnowledgeGraph.tsx` + `/api/graph` | Fix the mislabeled UI: show the *real* entity graph, color by maturity/provenance, replay by valid-time ("when did the agent learn X?") |

### Candidate detail (pitch / inspiration / novelty)

**C1 — Self-weaving graph.** *Pitch:* every write and every vault sync silently grows real,
weighted, typed edges — so the graph becomes dense and traversable with zero manual effort.
Three free edge sources: (a) **entity co-occurrence** within a memory (the audit confirms
nodes are created but `findOrCreateRelationship` is never called from the store path — wire it
in); (b) **resolved `[[wiki-links]]`** → memory-ID edges (already parsed in `vault/sync.ts`,
just discarded); (c) **vector-KNN "unlinked mentions"** surfaced at read/write time. Set
`strength` by IDF-weighted co-occurrence frequency instead of a constant 0.5, then add
**HippoRAG Personalized PageRank** (~80 LOC of power-iteration TS) as a 3rd ranker fused into
`hybrid.ts` for genuine multi-hop recall. *Inspired by:* graphify (structure-as-index),
Obsidian (automated unlinked mentions), HippoRAG (PPR), A-MEM (auto-linking). *Novel because:*
Obsidian's unlinked mentions are manual string matches; graphify needs an LLM for semantic
edges; nobody combines co-occurrence + resolved wiki-links + KNN + PPR locally with no cloud.

**C2 — Bi-temporal memory.** *Pitch:* add `valid_from`/`valid_to` (world truth) alongside the
existing `created_at`/`superseded_at` (system truth) on memories and `entity_relationships`;
contradictions set `valid_to` instead of deleting. Retrieval defaults to currently-valid facts;
a `as_of` parameter answers point-in-time queries. *Inspired by:* Zep/Graphiti. *Novel because:*
this is *the* capability vector stores can't do and the most-cited 2026 differentiator — and it
exists only in cloud platforms today. We'd be the first local-first, vault-backed one.

**C3 — Self-correcting write gate.** *Pitch:* on each write, retrieve the similarity shortlist
(already computed by `conflict-resolver.ts`), run a small **local NLI cross-encoder** over it to
classify entailment/contradiction, and choose ADD / UPDATE / DELETE / NOOP; contradictions
trigger C2 invalidation, not overwrite. Ambiguous cases escalate to the agent via a tool.
*Inspired by:* mem0 (ops), Anthropic/NLI contradiction detection, Zep (invalidate). *Novel
because:* mem0 needs a cloud LLM per write; we do the common case fully locally and only
escalate the hard cases — cheaper, private, and self-consistent.

**C4 — Two-way Obsidian vault.** *Pitch:* (1) **write-back**: route vault content through
`handleStore` and emit memories back as frontmattered `.md` so the vault round-trips losslessly;
(2) **watcher**: `fs.watch`/chokidar for live sync; (3) **JSON Canvas export/import**: a
`memory_canvas` tool emits a valid `.canvas` (tiny 1.0 spec) from a query — the agent's memory
opens as a spatial, *editable* map inside the user's real Obsidian, with typed/directional edges
(`depends-on`, `supersedes`) richer than Obsidian's untyped links; arranging cards teaches the
graph back. *Inspired by:* Obsidian (vault, Canvas, Sync). *Novel because:* basic-memory writes
flat notes; nobody emits JSON Canvas with typed edges as a first-class output the human edits.

**C5 — Confidence/provenance + auto-verify.** *Pitch:* adopt graphify's discrete
EXTRACTED/INFERRED/AMBIGUOUS rubric on the existing `provenance`/`confidence_score` columns,
expose `maturityTier` (draft/validated/core), and have `consolidate.ts` emit an "open
questions / verify-this" digest from AMBIGUOUS edges + stale (C2-invalidated) facts. *Inspired
by:* graphify (honest audit), Obsidian (unresolved links = knowledge gaps). *Novel because:* a
*self-auditing temporal* memory — the agent always knows what's fact vs guess vs expired.

**C6 — Reflection / sleep-time synthesis.** *Pitch:* extend the dream cycle with a
`memory_reflect` step that hands the agent a cluster of high-importance memories and asks it to
synthesize an insight note (stored as a `provenance='reflection'` memory linked to its sources).
Runs on the Stop/idle hook. *Inspired by:* Generative Agents (reflection), A-MEM (evolution),
GraphRAG (summaries). *Novel because:* the generation is delegated to the consuming agent over
MCP — a "sleep-time compute" loop with no cloud and no API key.

**C7 — Pinned core-memory tier.** *Pitch:* a small reserved namespace the agent loads every
session (via the SessionStart hook) and edits with `core_memory_append`/`replace`; map hot/cold
onto existing `access_count`/`condensation_level`. *Inspired by:* MemGPT/Letta. *Novel because:*
an MCP server already IS the archival/recall tier, so self-editing core memory is nearly free
here and expensive everywhere else.

**C8 — GDPR-grade compliant memory.** *Pitch:* formalize consent tags, retention windows
(extend `expires_at`), verifiable right-to-be-forgotten (cascade delete + tombstone in the
audit log), and an exportable access trail from `memory_access_log`. *Inspired by:* report 03's
white-space finding. *Novel because:* every cloud platform punts privacy to the app layer; a
100% local, audit-trailed server can make "compliant memory" a provable, demoable moat —
especially with the existing `department`/`access_level` model for legal/finance/HR.

**C9 — Shareable memory wiki / C10 — reranker / C11 — GraphRAG global / C12 — unified graph UI**
are the supporting cast: each is individually modest but together they make the wedge *felt* and
*demoable*. (Details in the table above.)

---

## 4. Recommended direction — the "Living Vault" v1

Build these **five candidates first**; together they form one coherent revolutionary story and
each unlocks the next. Everything below reuses existing tables/modules and needs no cloud.

1. **C1 Self-weaving graph** — the foundation. Turns the inert node-bag into a real, dense,
   traversable, weighted graph using signals we already capture (co-occurrence + wiki-links) plus
   PPR. *Without this, the "knowledge graph" pitch is hollow.* Builds on `entity-store.ts`,
   `vault/sync.ts`, `hybrid.ts`.

2. **C2 Bi-temporal memory** — the moat. Layers "what was true when" + invalidate-don't-delete on
   top of the now-real graph. The single most-cited 2026 differentiator, and the first time it's
   local + vault-backed. Builds on the schema + `conflict-resolver.ts`.

3. **C3 Self-correcting write gate** — makes #1 and #2 trustworthy. Local NLI + ADD/UPDATE/DELETE/
   NOOP + bi-temporal invalidation turns the append-only store into a self-consistent one, with
   the agent escalated only for ambiguity. Builds on `store.ts` + `conflict-resolver.ts`.

4. **C4 Two-way Obsidian vault** — the soul + the demo. Write-back + watcher + JSON Canvas make
   the memory a living, editable artifact inside the user's real Obsidian. This is what makes it
   *feel* like a brain, not a database, and is the most viral, screenshot-able surface. Builds on
   `vault/*` + the web dashboard.

5. **C5 Confidence/provenance + auto-verify** — the honesty layer that ties it together. Cheap
   (mostly column + digest work), and it makes every other feature trustworthy: the agent knows
   what's fact vs inferred vs expired and is handed a "verify this" queue. Builds on existing
   `provenance`/`confidence_score` + `consolidate.ts`.

**Sequencing rationale:** C1 makes the graph real → C2 makes it temporal → C3 makes it correct →
C4 makes it visible/editable/owned → C5 makes it honest. The result is a memory that
**links itself, knows when things were true, never silently serves a stale fact, lives in your
Obsidian vault, and can always tell you what it's unsure about** — all on-device.

Defer C6–C7 (self-organizing/agentic depth) and C8–C12 (compliance + UX polish) to v2 once the
Living Vault core lands. C10 (reranker) and C12 (unified graph UI) are cheap enough to slot in
opportunistically whenever they unblock a demo.

**The wedge restated for the README:** *The only memory layer that is at once a local-first
temporal knowledge graph and an editable Obsidian vault — your agents' second brain, on your
machine, that links itself and remembers when things were true.*
