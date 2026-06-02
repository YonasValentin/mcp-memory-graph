# Knowledge-Graph & Agentic-Memory Research

> Survey of techniques that could let an MCP memory server leap ahead of the
> current "hybrid-search vector store" generation. Scope is constrained to what
> is realistically implementable on **local SQLite + sqlite-vec + local
> Transformers.js embeddings, no cloud** — the exact stack this repo already runs.
>
> Date: 2026-05-29 · Author: ML research subagent

---

## 0. Where this codebase stands today (baseline)

The current server is already a strong **hybrid retriever**, not a naive vector
store. Reading the source establishes the baseline so we can be precise about
what is *new* vs. *already present*:

- **Storage:** `better-sqlite3` + `sqlite-vec` `vec0` virtual table
  (`memories_vec`, 384-dim float32), FTS5 (`memories_fts`) for keyword search.
  (`src/db/schema.ts`)
- **Retrieval:** vector + FTS5 candidates fused with **Reciprocal Rank Fusion**
  (K=60), then an importance multiplier, then optional temporal decay, then a
  confidence model. (`src/search/hybrid.ts`)
- **Embeddings:** local `@huggingface/transformers` (all-MiniLM-L6-v2, 384-dim),
  with a cache layer. (`src/embeddings/`)
- **Graph already exists:** `entities`, `entity_aliases`, `entity_relationships`,
  `memory_entities` tables + a regex/heuristic `entity-extractor.ts` and a
  `conflict-resolver.ts`. (`src/graph/`, `src/db/schema.ts:224-285`)
- **Memory lifecycle primitives already exist:** `importance_score`,
  `confidence_score`, `access_count`, `last_accessed_at`, `superseded_at`,
  `condensation_level`, `memory_versions`, `memory_conflicts`, `memory_originals`,
  plus tools `consolidate`, `condense`, `extract-learnings`, `related`, `graph`.

**Takeaway:** the schema is already 70% of the way to a knowledge-graph memory.
The leap-ahead opportunities are mostly in *retrieval algorithms over the graph*
(PPR, graph traversal), *bi-temporal correctness*, *contradiction detection*,
and *self-organizing/agentic write paths* — all of which sit on top of the
tables that already exist. The hard constraint everywhere below is **"no cloud
LLM"**: the techniques that assume an LLM in the write path must either degrade
to a heuristic, or call the *consuming* agent (Claude, via MCP) to do the LLM
work and hand structured results back.

---

## 1. GraphRAG (Microsoft)

**Core idea.** Build an LLM-derived entity knowledge graph from a corpus, run
community detection (Leiden) to get a *hierarchy* of entity clusters, and
pre-generate a natural-language **summary for every community**. Answer "global"
questions ("what are the main themes?") by map-reducing over community summaries
instead of retrieving individual chunks; answer "local" questions by walking the
neighborhood of matched entities.

**Problem it solves.** Plain RAG (and this server today) is good at *local*
"find the chunk that answers X" but blind to *global* "summarize / what patterns
exist across everything." Communities + summaries give a queryable
table-of-contents over the whole memory.

**Local feasibility: PARTIAL (high value, the summary step needs the agent).**
- Community detection is pure graph math — **Leiden/Louvain or label
  propagation runs fine in-process** on the `entity_relationships` edge list
  (thousands of nodes is trivial). No cloud needed.
- Storing community membership + level is a 2-table addition
  (`communities`, `entity_communities`) mirroring the existing graph tables.
- The **community-summary generation is the only LLM step.** With no cloud LLM,
  the realistic pattern is: the server computes communities and exposes a
  `memory_graph_communities` tool; the *MCP client agent* (Claude) writes the
  summary and stores it back via `memory_store`. This is the recurring
  "LLM-in-the-loop lives in the client" pattern that makes most of this report
  buildable without a cloud dependency.
- Map-reduce global search can be done client-side too: server returns the N
  community summaries, agent reduces.

**Verdict:** Implement community detection + a "global search" surface. Defer
auto-summaries to the agent. This is the single biggest "feels magical"
capability gap vs. the current local-only retriever.

Sources:
- arXiv 2404.16130 — *From Local to Global: A Graph RAG Approach to QFS*
  (https://arxiv.org/abs/2404.16130)
- Microsoft Research blog — dynamic community selection
  (https://www.microsoft.com/en-us/research/blog/graphrag-improving-global-search-via-dynamic-community-selection/)

---

## 2. Bi-temporal knowledge graphs (Graphiti / Zep)

**Core idea.** Every fact (graph edge) carries **two independent time axes**:
*valid time* `t_valid / t_invalid` (when the fact was true in the world) and
*ingestion/transaction time* `t_created / t_expired` (when the system learned /
unlearned it). When a new fact contradicts an existing one over an overlapping
valid-time window, you don't delete the old edge — you set its `t_invalid` to
the new fact's `t_valid`. Nothing is ever lost; you can query "what did we
believe on date D" and "what was actually true on date D" separately.

**Problem it solves.** Agent memory is full of facts that *change*: "user works
at X" → later "user works at Y." A single-timestamp store either overwrites
(losing history) or accumulates contradictions. Bi-temporal modeling makes
"supersession" first-class and auditable, and lets retrieval filter to
*currently-valid* facts by default.

**Local feasibility: YES — this is the highest ROI / lowest risk item.**
- It is **pure schema design**, no ML. The repo already has `superseded_at` and
  a `memory_conflicts` table — this generalizes it.
- Add to `entity_relationships` (and optionally `memories`): `valid_from`,
  `valid_to`, `tx_created` (already have `created_at`), `tx_expired`. Default
  retrieval predicate becomes `valid_to IS NULL AND tx_expired IS NULL`.
- "Invalidate, don't delete" is a single `UPDATE ... SET valid_to = ?` on
  contradiction — far better than the current hard supersede.
- Zep's own bench beat MemGPT on the DMR metric (94.8% vs 93.4%) largely on the
  strength of this temporal correctness, so it's not just tidy — it moves the
  needle.

**Verdict:** Do this first. It is the schema substrate that contradiction
detection (§13), forgetting (§11), and "currently true vs. historically true"
retrieval all build on. There is a TypeScript port of the Zep paper
(`aexy-io/graphzep`) to crib the schema from.

Sources:
- arXiv 2501.13956 — *Zep: A Temporal Knowledge Graph Architecture for Agent
  Memory* (https://arxiv.org/abs/2501.13956)
- Graphiti GitHub (https://github.com/getzep/graphiti)
- GraphZep TS port (https://github.com/aexy-io/graphzep)

---

## 3. HippoRAG — Personalized PageRank retrieval

**Core idea.** Build a schemaless KG (noun-phrase nodes, OpenIE relation edges)
plus *synonymy edges* between nodes whose embeddings are very similar (τ≈0.8).
At query time: extract the query's named entities, link them to KG nodes
(highest cosine), seed **Personalized PageRank** from those nodes (with a
restart/damping of ~0.5), weight seeds by *node specificity* (an IDF-analog:
`1/|passages containing the node|`), let PPR diffuse importance across the
graph, then **rank passages by summing the PPR scores of the nodes they
contain**. One PPR pass replaces expensive iterative multi-hop retrieval.

**Problem it solves.** Multi-hop / associative recall: "the thing connected to
the thing I asked about." Pure vector search retrieves what's *similar to the
query*, not what's *reachable from the query's entities*. PPR is single-shot,
cheap, and gives multi-hop reasoning that the current RRF fusion cannot. Paper
reports up to **+20% on multi-hop QA**, 6-13× faster and 10-20× cheaper than
iterative retrieval.

**Local feasibility: YES — fully local at this scale, this is the standout
algorithmic upgrade.**
- The graph already exists (`entity_relationships`, `memory_entities` links
  nodes→passages). Add synonymy edges by thresholding cosine over the
  *entity* embeddings (compute entity embeddings once with the local model).
- **PPR on a few-thousand-node graph is milliseconds** — implement as power
  iteration over an adjacency list in TS (no native dep). The paper itself ran
  PPR on ~90K nodes / ~350K edges as the *cheap* path; our graphs are smaller.
- Node specificity = `1/COUNT(memory_entities WHERE entity_id=?)` — a single
  SQL aggregate, computable/cacheable.
- Query NER without an LLM: reuse the existing regex/heuristic entity extractor;
  even crude entity linking + embedding match to KG nodes is enough to seed PPR.
- Fuse PPR passage scores into the existing RRF as a *third ranker* alongside
  vector + FTS5 — no architecture change, just one more rank list into the
  fusion at `src/search/hybrid.ts`.

**Verdict:** Best "smartness per line of code" win. PPR is ~80 lines of TS over
tables that already exist, and it gives genuine associative/multi-hop recall
that no amount of vector tuning provides.

Sources:
- arXiv 2405.14831 — *HippoRAG* (NeurIPS'24)
  (https://arxiv.org/abs/2405.14831)
- HippoRAG GitHub (https://github.com/OSU-NLP-Group/HippoRAG)

---

## 4. Agentic memory — A-MEM (Zettelkasten)

**Core idea.** Each new memory becomes a structured *note*: the LLM generates
**keywords, tags, and a one-sentence context** alongside the raw content. **Link
generation:** retrieve top-k embedding-similar existing notes, then let the LLM
decide which deserve real links. **Memory evolution:** adding a note can
*rewrite* its linked neighbors' context/tags so the network keeps re-organizing
itself as it grows (Zettelkasten "slip-box" dynamics).

**Problem it solves.** Static memories rot: a note written six months ago has no
awareness of everything learned since. A-MEM makes memory *self-organizing* —
links and descriptions evolve, so retrieval keeps improving without manual
curation.

**Local feasibility: PARTIAL (structure local, generation via the agent).**
- The repo already has `tags`, `metadata`, `entity_relationships` (links),
  `extract-learnings.ts`. The *graph substrate* for notes-with-links exists.
- Link generation's "top-k by embedding, then LLM picks" maps cleanly: server
  does the top-k (it already can), the MCP agent picks links. Or a **no-LLM
  fallback**: auto-link above a cosine threshold (cheap, noisier).
- "Memory evolution" (rewriting neighbor context/tags) is the part that
  genuinely needs an LLM. With no cloud, expose it as an agent-driven tool:
  `memory_evolve(note_id)` returns neighbors + lets the client rewrite them.
- Keyword/tag/context generation: a local model can't reliably do this; punt to
  the client agent or a heuristic keyword extractor (RAKE/YAKE-style, pure TS).

**Verdict:** Adopt the *data model* (notes + typed links + evolving context) and
the agent-in-the-loop write path. Don't try to do the generative parts with the
384-dim local model — it's not strong enough.

Sources:
- arXiv 2502.12110 — *A-MEM: Agentic Memory for LLM Agents* (NeurIPS 2025)
  (https://arxiv.org/abs/2502.12110)
- GitHub (https://github.com/agiresearch/a-mem)

---

## 5. Mem0 — extract / update memory operations

**Core idea.** Two-phase pipeline. **Extraction:** from a new message pair (+ a
running conversation summary + recent window), pull out salient candidate facts.
**Update:** for each candidate, retrieve semantically similar existing memories
and let an LLM choose one of four operations via tool-call — **ADD** (novel),
**UPDATE** (augment an existing memory), **DELETE** (new info contradicts old),
or **NOOP** (redundant). A graph variant (Mem0g) additionally stores
entity-relationship triples.

**Problem it solves.** Naive memory just appends, creating duplicates and stale
contradictions. The ADD/UPDATE/DELETE/NOOP gate keeps the store **deduplicated
and self-consistent at write time**, which is why Mem0 reports ~26% better
answer quality with 90%+ lower token cost / p95 latency than full-context.

**Local feasibility: YES (the decision logic is the value, and it's portable).**
- The "retrieve similar, then decide ADD/UPDATE/DELETE/NOOP" loop is exactly the
  right write-path discipline for this server, which currently mostly ADDs.
- The retrieval half is already built (hybrid search). The *decision* can be:
  (a) **agent-driven** — server returns the similar memories + candidate, MCP
  client returns the operation; or (b) **heuristic** — cosine > 0.95 ⇒ NOOP,
  0.85–0.95 + same entities ⇒ UPDATE/merge candidate, contradiction signal
  (§13) ⇒ DELETE/supersede, else ADD. The heuristic path is fully local.
- This formalizes and upgrades the existing `consolidate`/`conflict-resolver`
  logic into a principled write gate.

**Verdict:** Adopt the four-operation write gate as the canonical store path.
Pair the heuristic version with the agent-driven version (MCP makes the latter
natural). High value, low risk.

Sources:
- arXiv 2504.19413 — *Mem0: Building Production-Ready AI Agents with Scalable
  Long-Term Memory* (https://arxiv.org/abs/2504.19413)
- GitHub (https://github.com/mem0ai/mem0)

---

## 6. Generative Agents — reflection, importance, recency

**Core idea.** A "memory stream" of observations is scored at retrieval by a
weighted sum of three signals: **recency** (exponential decay since last
access), **importance** (an LLM-assigned 1–10 "how significant"), and
**relevance** (embedding similarity to the query). Periodically, when
accumulated importance crosses a threshold, the agent **reflects**: synthesizes
recent memories into higher-level insight memories that re-enter the stream.

**Problem it solves.** Flat similarity search ignores *salience* and *time*.
Reflection turns a pile of raw observations into reusable abstractions ("the
user prefers terse answers") that retrieve better than any single observation.

**Local feasibility: MOSTLY YES (it's already half-built here).**
- The recency+importance+relevance triad is **already approximated** in
  `hybrid.ts` (RRF relevance × importance boost × temporal decay). Tightening it
  to the explicit `α·recency + α·importance + α·relevance` form is a small
  scoring refactor in `src/search/scoring.ts` + `temporal.ts`.
- Recency decay and importance storage: already present (`last_accessed_at`,
  `importance_score`, `temporal_decay`).
- **Importance assignment** without an LLM is the weak spot — current default is
  a flat 0.5. Options: agent supplies importance on store, or a local heuristic
  (length, entity density, explicit "remember this" markers, access frequency
  feedback). The existing `extract-learnings.ts` is a reflection seed.
- **Reflection** (synthesizing insights) is an LLM task → agent-driven, exposed
  as a `memory_reflect` tool that hands recent high-importance memories to the
  client and stores the returned insight as a new memory with
  `provenance='reflection'`.

**Verdict:** Mostly a refinement of existing scoring + an explicit reflection
tool. Cheap, and it's the original blueprint the other systems descend from.

Sources:
- arXiv 2304.03442 — *Generative Agents: Interactive Simulacra of Human
  Behavior* (https://arxiv.org/abs/2304.03442)

---

## 7. MemGPT / Letta — self-editing memory + memory tiers

**Core idea.** Treat the LLM context window like OS virtual memory. Three tiers:
**core memory** (small, always in-context — like RAM), **recall memory**
(searchable recent history — like a disk cache), **archival memory** (large
cold store, queried by tool call). The agent **self-edits**: it calls functions
(`core_memory_append`, `archival_memory_search`, …) to page facts between tiers
during its own reasoning loop.

**Problem it solves.** Finite context vs. unbounded history. Tiering + self-edit
lets an agent maintain a curated, always-present "who am I talking to / what
matters now" block while everything else stays paged out but retrievable.

**Local feasibility: YES (this is the most MCP-native idea of all).**
- An MCP memory server **is literally the archival+recall tier** for a Claude
  agent. The missing piece is an explicit, small, pinned **core-memory block**:
  a `core_memory` table (or a reserved namespace) the agent reads on every
  session and edits via `core_memory_append` / `core_memory_replace` tools.
- Tiering maps to existing fields: `condensation_level` and `access_count`
  already differentiate hot vs. cold; promote frequently-accessed memories to a
  "recall" view, keep the rest "archival."
- Self-editing is exactly what MCP tools are for — no cloud needed, the
  *consuming* Claude agent does the editing through the tools you expose.

**Verdict:** Add a bounded, pinned core-memory block + explicit edit tools. This
turns the server from "search box" into "OS memory for the agent" and is almost
free given the MCP transport already exists.

Sources:
- MemGPT / Letta (arXiv 2310.08560; https://www.letta.com)
- Letta/MemGPT patterns
  (https://github.com/NirDiamant/Agent_Memory_Techniques)

---

## 8. Reflection & self-organizing memory (cross-cutting)

**Core idea.** Memory shouldn't only grow — it should periodically
*re-organize*: cluster related items, write summaries, promote insights, prune
noise, re-link. This is the union of A-MEM evolution (§4), Generative-Agents
reflection (§6), GraphRAG communities (§1), and Mem0 consolidation (§5).

**Problem it solves.** Entropy. Without periodic compaction, a memory store
degrades into a swamp of near-duplicates and stale facts that *hurt* retrieval.

**Local feasibility: YES (mostly orchestration over building blocks above).**
- The repo already ships `consolidate.ts` and `condense.ts`. Make them run on a
  schedule/threshold (the "importance budget" trigger from Generative Agents)
  rather than only on demand.
- Re-clustering = re-run community detection (§1). Re-linking = re-run synonymy
  edges (§3). Summaries/insights = agent-driven (§1/§6).
- Pure-local maintenance jobs (no LLM): merge cosine-near-duplicates, decay
  importance, archive cold low-importance memories, recompute node specificity.

**Verdict:** A "maintenance loop" that periodically fires the local jobs and
surfaces agent-driven summary/reflection opportunities. Ties the whole system
together.

---

## 9. Entity resolution / coreference for dedup

**Core idea.** Decide when two entity mentions ("J. Park", "Joon Park", "the
author") are the *same* entity. Pipeline: **blocking** (cheaply group plausible
matches — by normalized name, or by embedding LSH/ANN), **matching** (pairwise
score within blocks — string similarity + embedding cosine, optionally an LLM
adjudicator), **clustering** (connected components / correlation clustering over
SAME_AS edges → one cluster = one resolved entity).

**Problem it solves.** Without resolution, the graph fragments — "PureGate",
"Pure Gate", "the PureGate project" become three nodes, and PPR / graph
traversal / dedup all break. This is the quiet prerequisite for every graph
technique above.

**Local feasibility: YES — and the schema already anticipates it.**
- `entities.normalized_name`, `entity_aliases`, and the unique alias index are
  already there. The current `entity-store.ts` does normalization-based merge.
- Upgrade path, all local: **embedding-based blocking** (entity embeddings,
  cosine threshold) + **string similarity** (Jaro-Winkler/Levenshtein, pure TS)
  + **connected-components clustering** (trivial union-find in TS). The
  "cascade" rule → ML → LLM from the literature degrades gracefully: do rule +
  embedding locally, escalate genuinely ambiguous pairs to the agent.
- A dependency-based / non-LLM extraction path reportedly hits ~94% of LLM
  extraction quality (61.9% vs 65.8%) — good enough that the local heuristic
  extractor + good resolution is viable without a cloud LLM.

**Verdict:** Strengthen the existing resolver with embedding blocking +
fuzzy-string matching + union-find clustering. Pure-local, and it unblocks the
quality of §1/§3.

Sources:
- *Entity Resolution at Scale* (blocking→matching→clustering overview)
  (https://medium.com/@shereshevsky/entity-resolution-at-scale-deduplication-strategies-for-knowledge-graph-construction-7499a60a97c3)
- arXiv 2504.05767 — Cross-Document Contextual Coreference in KGs
  (https://arxiv.org/pdf/2504.05767)

---

## 10. Late interaction / ColBERT & hybrid reranking

**Core idea.** Instead of one vector per document, **ColBERT** stores one vector
per *token*, and scores a query–doc pair with **MaxSim**: for each query token,
take its max cosine over all doc tokens, then sum. This "late interaction"
keeps fine-grained token matching that single-vector embeddings lose. **PLAID**
makes it fast (centroid pruning + residual compression). Separately, **hybrid
reranking** = retrieve broad with cheap methods, then re-score the top-N with a
stronger (cross-encoder or ColBERT) model — Anthropic's numbers (§12) show
reranking alone takes failure rate from 2.9% → 1.9%.

**Problem it solves.** all-MiniLM-L6-v2 (this server's model) is a weak
single-vector encoder; it loses precise term-level matches. A reranking stage
recovers much of that precision cheaply, since it only runs on ~top-50–150.

**Local feasibility: SPLIT.**
- **Full ColBERT/PLAID: NO (not worth it locally).** sqlite-vec stores one
  vector per row; token-level multi-vector indexing + MaxSim + PLAID's pruning
  is a different storage engine. High effort, high disk, marginal gain at this
  scale.
- **Cross-encoder reranking: YES, and high value.** Run a small local
  cross-encoder (e.g. `Xenova/ms-marco-MiniLM-L-6-v2`, already compatible with
  the installed `@huggingface/transformers`) over the top-50 RRF candidates
  before returning top-K. This is the single most reliable retrieval-quality
  win after PPR, and it slots cleanly after fusion in `hybrid.ts`. CPU cost is
  bounded because it only sees the shortlist.

**Verdict:** Skip ColBERT/PLAID. **Add a local cross-encoder reranker** as the
final stage. Anthropic-measured +large reduction in retrieval failures, fully
local, ~50 candidates × one small model = acceptable latency.

Sources:
- arXiv 2205.09707 — *PLAID: An Efficient Engine for Late Interaction Retrieval*
  (https://arxiv.org/abs/2205.09707)
- Weaviate — late interaction overview (ColBERT/ColPali/ColQwen)
  (https://weaviate.io/blog/late-interaction-overview)

---

## 11. Contextual retrieval (Anthropic)

**Core idea.** Before embedding/indexing a chunk, **prepend a 50–100 token,
LLM-generated blurb that situates the chunk in its parent document** ("This chunk
is from ACME Corp's Q2 2023 filing; it discusses revenue…"). Index the
*contextualized* chunk in both the embedding store ("Contextual Embeddings") and
BM25 ("Contextual BM25"). Measured: failure rate 5.7% → 3.7% (embeddings only,
−35%), → 2.9% (+ contextual BM25, −49%), → 1.9% (+ reranking, −67%). One-time
cost ~$1.02 per 1M tokens via prompt caching.

**Problem it solves.** Chunks lose their context when split — "it grew 3%" is
useless without "revenue, Q2 2023." Embeddings of bare chunks under-retrieve.
This is the cheapest large retrieval-quality lever in the literature.

**Local feasibility: PARTIAL (concept yes, generation needs an LLM).**
- The *indexing-time-contextualization* idea is directly applicable: this server
  already chunks (`src/chunking/`) and dual-indexes (vec + FTS5). Storing a
  `context_prefix` per chunk and indexing `prefix + content` is trivial schema.
- The blurb generation needs an LLM. Local options without a cloud:
  (a) **cheap deterministic context** — prepend parent doc title + section
  headers + nearby metadata (no model, captures most of the gain for
  structured docs); (b) **agent-generated** — at ingest, the MCP client writes
  the blurb. The repo's `ingest.ts` already tracks parent/section structure, so
  the deterministic path is low-hanging.

**Verdict:** Implement contextual indexing with a **deterministic
title/section/metadata prefix** as the local default, with an optional
agent-generated blurb. Combined with the reranker (§10) this mirrors Anthropic's
full stack — minus the cloud LLM, plus a heuristic prefix.

Sources:
- Anthropic — *Introducing Contextual Retrieval*
  (https://www.anthropic.com/news/contextual-retrieval)
- Claude cookbook — contextual embeddings guide
  (https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide)

---

## 12. KG construction from text: with-LLM vs without-LLM

**Core idea.** Two paradigms for turning text into (subject, relation, object)
triples. **Without LLM:** OpenIE over dependency parses (Stanford CoreNLP-style)
— a classifier walks the parse tree, splits clauses, emits confidence-scored
triples; fast, cheap, schemaless, but noisy. **With LLM:** prompt a model to
extract entities + typed relations; cleaner and schema-aware but expensive and
needs a model. **Hybrid:** OpenIE/dependency extraction + noun-phrase cleaning +
optional LLM *validation* of candidate triples gets most of the quality at a
fraction of cost (one study: dependency-based ≈ 94% of LLM quality, 61.9% vs
65.8%).

**Problem it solves.** It's the front door to *every* graph technique above (§1,
§3, §9). The question is purely: how good a graph can we build with no cloud LLM?

**Local feasibility: YES (heuristic path is good enough; LLM path via agent).**
- The repo's `entity-extractor.ts` is already a regex/heuristic extractor — the
  no-LLM end of the spectrum. Upgrade toward OpenIE-lite: noun-phrase chunking +
  simple SVO patterns + the synonymy edges from §3 to repair fragmentation.
- A small local model (spaCy-style NER ported, or a tiny HF token-classification
  model via the installed transformers lib) raises entity quality without a
  cloud.
- The "validation" tier (filter bad triples) is where the MCP agent helps:
  extract locally (cheap, high-recall), let the client validate the ambiguous
  ones (high-precision). Cascade rule→embedding→agent.

**Verdict:** Keep extraction **local and high-recall**, add embedding-based
synonymy + entity resolution (§9) to clean it, and reserve the agent only for
adjudicating ambiguous triples. No cloud dependency for the common path.

Sources:
- arXiv 2502.09956 — *KGGen: Extracting KGs from Plain Text with LMs*
  (https://arxiv.org/html/2502.09956v1)
- arXiv 2507.03226 — *Towards Practical GraphRAG: Efficient KG Construction*
  (https://arxiv.org/pdf/2507.03226)
- arXiv 2510.23341 — *LightKGG: Simple & Efficient KG Generation*
  (https://arxiv.org/html/2510.23341v1)

---

## 13. Forgetting curves & memory decay models

**Core idea.** Human retention follows an exponential forgetting curve
`R = e^(−t/S)` (R=retention, t=time, S=stability). Each successful recall
*increases stability S* (spaced repetition), so frequently-used memories decay
slower. Applied to agent memory: every memory has a decaying "retention" score;
access bumps stability; memories below a floor get archived/pruned.

**Problem it solves.** A store that never forgets drowns in stale trivia, which
*degrades* retrieval (the swamp problem from §8). Principled decay keeps the hot
set small and relevant while letting cold facts gracefully age out — without
hard TTLs that delete things you might still need.

**Local feasibility: YES — partly built, easy to complete.**
- `temporal.ts` already does temporal decay using `created_at` + `access_count`.
  The upgrade is to make it a **proper stability model**: store a per-memory
  `stability` that increments on each access (`last_accessed_at` + `access_count`
  exist), and compute retention `e^(−Δt/S)` as a retrieval multiplier and a
  pruning signal.
- Pure arithmetic, no ML, no cloud. Fits the existing `consolidate` job: prune
  where `retention < floor AND importance < floor AND access_count low`.
- Pairs naturally with bi-temporal (§2): "forgotten" ≠ "deleted" — set
  `tx_expired` so it's archived/auditable, not gone.

**Verdict:** Generalize the existing decay into a stability-based forgetting
curve and wire it into both ranking and the maintenance loop. Low effort,
directly attacks store rot.

Sources:
- Wikipedia — Forgetting curve (R=e^(−t/S), spaced repetition)
  (https://en.wikipedia.org/wiki/Forgetting_curve)

---

## 14. Contradiction / conflict detection between memories

**Core idea.** Detect when a new fact *contradicts* a stored one. Best practice
is **NLI** (Natural Language Inference): classify a (premise, hypothesis) pair as
entailment / neutral / **contradiction**. Pipelines first filter to
semantically-similar candidate pairs (embedding cosine), then run an
NLI/cross-encoder model (or LLM judge) on that shortlist; decomposing into
*atomic facts* before comparison improves precision. On a hit, resolve via the
bi-temporal invalidation from §2 (set old edge's `valid_to`).

**Problem it solves.** Silent contradictions are the worst memory failure —
the agent confidently retrieves a fact that's been superseded. Detection +
bi-temporal invalidation makes the store *self-correcting*.

**Local feasibility: YES (a small local NLI model is the right tool here).**
- The repo already has `conflict-resolver.ts` and a `memory_conflicts` table —
  this is the upgrade target, currently heuristic/string-based.
- The candidate-filtering half is free (hybrid search finds similar memories).
- The contradiction classifier: run a **small local NLI cross-encoder** (e.g. a
  MiniLM/DeBERTa MNLI model via the installed `@huggingface/transformers`) over
  the shortlist of similar memories at write time. This is CPU-bounded because
  it only sees a handful of candidates per write. No cloud.
- On detection → drive the Mem0 DELETE/UPDATE op (§5) + the bi-temporal
  invalidation (§2). The three techniques compose into one self-consistent
  write gate. The agent can adjudicate genuinely ambiguous contradictions.

**Verdict:** Add a local NLI check at write time over the similarity shortlist,
feeding the bi-temporal supersession path. This + §2 + §5 is the "self-correcting
memory" trifecta and is the most differentiating reliability feature.

Sources:
- arXiv 2504.00180 — *Contradiction Detection in RAG Systems* (LLMs as context
  validators) (https://arxiv.org/html/2504.00180v1)
- arXiv 2410.04068 — *ECon: Detection and Resolution of Evidence Conflicts*
  (https://arxiv.org/pdf/2410.04068)
- *Natural Language Inference (NLI)* overview
  (https://www.emergentmind.com/topics/natural-language-inference-nli)

---

## Synthesis: prioritized roadmap (all local-feasible)

Ranked by **(impact × differentiation) / effort**, given what the schema
already provides:

| Tier | Technique | Why now | Local cost |
|------|-----------|---------|-----------|
| **1 — substrate** | Bi-temporal KG (§2) | Schema-only; unblocks §13, §11, "current vs historical" retrieval | Low (migration) |
| **1 — substrate** | Entity resolution upgrade (§9) | Embedding-blocking + union-find; unblocks §1/§3 quality | Low–Med |
| **2 — retrieval leap** | HippoRAG PPR (§3) | True multi-hop/associative recall; ~80 LOC over existing tables | Low–Med |
| **2 — retrieval leap** | Cross-encoder reranker (§10) | Biggest precision win for a weak base embedder; bounded cost | Low |
| **2 — retrieval leap** | Contextual indexing, deterministic prefix (§11) | Cheap, measured −35–49% failure; uses existing chunk structure | Low |
| **3 — write discipline** | Mem0 ADD/UPDATE/DELETE/NOOP gate (§5) | Stops dup/contradiction at write; upgrades `consolidate` | Med |
| **3 — write discipline** | Local NLI contradiction detection (§13) | Self-correcting memory; small local model on shortlist | Med |
| **3 — write discipline** | Forgetting curve / stability (§13/11) | Fights store rot; generalizes existing decay | Low |
| **4 — global/agentic** | GraphRAG communities + global search (§1) | "Summarize everything" capability; Leiden local, summaries via agent | Med |
| **4 — global/agentic** | MemGPT core-memory tier + self-edit tools (§7) | Most MCP-native; turns server into agent OS-memory | Low–Med |
| **4 — global/agentic** | Reflection + A-MEM evolution (§4/§6/§8) | Self-organizing insights; orchestration over the above | Med |
| **skip** | Full ColBERT/PLAID (§10) | Different storage engine; marginal at this scale | — (not worth) |

**The unifying architectural insight:** with no cloud LLM, every "LLM-in-the-
write-path" technique here has the same escape hatch — **the consuming Claude
agent IS the LLM, reachable through MCP tools.** The server does the cheap,
deterministic, local work (graph math, embeddings, NLI on a shortlist, decay,
clustering) and exposes agent-driven tools for the genuinely generative steps
(summaries, reflection, ambiguous adjudication). That division is what makes an
ambitious GraphRAG/Zep/HippoRAG-class memory server realistic on
SQLite + sqlite-vec + local embeddings.
