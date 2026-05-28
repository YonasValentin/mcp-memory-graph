# Competitive Landscape: AI Agent Memory Systems & Memory MCP Servers (2026)

> Research date: 2026-05-29
> Author: competitive-intelligence pass for `mcp-memory-server`
> Scope: SOTA memory layers, frameworks, research systems, and MCP memory servers as of mid-2026.

## TL;DR

The 2026 memory market has split into four camps:

1. **Managed memory APIs / platforms** (mem0, Zep, supermemory, Memori Cloud, Letta Cloud) — hosted, benchmark-chasing, vector+graph+temporal hybrids that compete on LoCoMo / LongMemEval / BEAM scores.
2. **Local-first MCP memory servers** (basic-memory, claude-mem, byterover, the official `@modelcontextprotocol/server-memory`, **our `mcp-memory-server`**) — run on the developer's machine, plug into Claude Code / Cursor / Codex via MCP.
3. **Knowledge engines / graph builders** (Cognee, Microsoft GraphRAG, txtai, HippoRAG) — turn document corpora into queryable graphs; memory is a use case, not the only one.
4. **Research systems** (A-MEM, MemoryOS, HippoRAG 2, APEX-MEM, MemMachine) — define the architectures the platforms will ship in 12 months.

The single biggest 2026 shift: **temporal reasoning + entity linking are no longer differentiators — they are table stakes.** The frontier has moved to (a) bi-temporal "what was true on date X" queries, (b) contradiction / staleness handling, (c) multi-agent shared memory with actor attribution, and (d) privacy/consent + GDPR-grade deletion. Our server's privacy-by-architecture (100% local, single SQLite file, no telemetry) and enterprise metadata model are genuine strengths; our biggest gaps are graph relationships, bi-temporal validity windows, and LLM-grade fact extraction/conflict resolution.

---

## Where `mcp-memory-server` stands today (baseline for comparison)

What we have: hybrid search (sqlite-vec + FTS5 BM25 fused with **RRF**), local Transformers.js embeddings (no cloud, no Python), multi-scope isolation (global/project/user/team/department), rich enterprise metadata (department, access_level, document_type, language, source, author), version history, temporal *decay* (recency weighting), confidence scoring, expiration, structure-aware chunking (text/markdown/code/legal), access tracking + quality scoring, a "dream cycle" consolidation (score/expire/prune/dedup/gaps), knowledge-gap detection, Obsidian vault sync, Claude Code hooks (incl. headless `claude -p` learning extraction at session end), a web dashboard with a D3 knowledge-graph *visualization*, and a 9-endpoint REST API. ~17 MCP tools. MIT-licensed.

Key structural facts that shape the gap analysis below:
- We store **memories**, not a typed entity/relation **graph**. The "knowledge graph" is a vector-similarity visualization, not a queryable graph with traversal/multi-hop.
- We have temporal **decay** (recency scoring) but not **bi-temporal validity** (valid-time vs transaction-time; "what was true in March").
- Learning extraction is **heuristic pattern matching** by default; the LLM path is an opt-in `claude -p` Stop hook, not an inline ADD/UPDATE/DELETE reconciliation engine.
- We have no automatic **conflict / contradiction resolution** (no fact invalidation when a memory becomes stale).
- We scale to **~100K vectors** (sqlite-vec local limit), vs. the platforms targeting 1M–10M token corpora.

---

## Comparison table

| System | Type | Storage / Retrieval | Temporal | Best at | Key thing we lack |
|---|---|---|---|---|---|
| **mem0 / OpenMemory** | Managed API + OSS + local MCP | Hybrid: vector + graph + key-value; ADD-only single-pass extraction; multi-signal fusion (semantic + BM25 + entity) | Temporal reasoning (time-aware ranking) | LLM fact extraction + accuracy/token efficiency (LoCoMo 91.6, LongMemEval 94.8, Apr 2026) | LLM-driven fact extraction & entity linking; benchmark-grade retrieval |
| **Letta (MemGPT)** | Stateful-agent platform (OSS + cloud) | Tiered memory: in-context "core memory blocks" (RAM) + archival/recall (disk); agent self-edits memory via tools | Recall by date; no bi-temporal graph | "LLM-as-OS" self-managed memory; agents that edit their own memory | Agent-managed memory blocks; self-editing memory tools; full agent runtime |
| **Zep + Graphiti** | Memory platform on temporal KG (OSS engine) | **Bi-temporal knowledge graph** (Neo4j/FalkorDB); hybrid semantic + BM25 + graph traversal; fact invalidation | **Bi-temporal** (valid-time + transaction-time); point-in-time queries | "What was true on date X" + change-over-time reasoning; most architecturally sophisticated | Real typed graph + bi-temporal validity windows + fact invalidation |
| **basic-memory** | Local-first MCP server | Markdown files as source of truth; SQLite index; semantic search + wiki-link graph | Last-modified; no validity windows | Human+AI co-editing the *same* Markdown files; Obsidian-native graph | True bidirectional file write-back (we read vaults, don't write `.md` back); observation/relation note model |
| **Cognee** | AI memory engine / graph builder (OSS + cloud) | **ECL pipeline** (Extract-Cognify-Load): 38+ sources → KG + embeddings + ontology; vector + graph | Some via ontology | Turning heterogeneous data (PDF/SQL/API) into an ontology-grounded graph in ~6 lines | Multi-source ingestion pipeline; ontology grounding; graph + provenance |
| **byterover** | Agent-native coding-memory MCP (local-first) | **No vectors**: hierarchical Markdown "Context Tree" + MiniSearch full-text + tiered fuzzy→LLM search | Implicit via tree recency | Curated, human-readable hierarchical coding memory; LoCoMo 92.2% (ByteRover 2.0) | LLM-curated hierarchical context tree; tiered fuzzy→LLM retrieval |
| **supermemory** | Universal memory API (cloud + on-prem/air-gap) | Hybrid: vector + memory graph + user profiles; multi-modal extractors (PDF/img/video/code AST) | Temporal awareness on vector recall | Single-API "context stack": memory + RAG + connectors; #1 on LongMemEval/LoCoMo/ConvoMem | Auto user-profile maintenance; connectors (Drive/Gmail/Notion); multi-modal extraction |
| **txtai** | Embeddings database / AI framework (OSS) | Unified embeddings DB: dense+sparse vectors + **graph network** + relational (SQL over vectors) | None native | All-in-one local embeddings DB with SQL + graph + multimodal pipelines | Graph network over embeddings; SQL query over vectors; multimodal (audio/video/image) |
| **Memori (GibsonAI)** | SQL-native memory engine (OSS + cloud) | **No vector DB**: standard SQL (SQLite/Postgres/MySQL) + FTS; 3-agent capture/analyze/inject | Versioning; no bi-temporal | Cheap, transparent, SQL-native memory (claims 80–90% lower cost, 10–50ms) than vector DBs | Multi-agent capture→analyze→inject loop; full SQL transparency/portability |
| **claude-mem** | Claude Code memory plugin (local) | Auto-captures every tool call → AI compresses (agent-SDK) → SQLite + FTS; 3-layer retrieval | Session recency | **Zero-effort** automatic capture+compression of coding sessions (~10x token efficiency); 72K★ | Automatic session capture (no manual store); AI compression of tool I/O |
| **Pieces** | OS-level memory product (local, PiecesOS) | Captures context across *all* apps/browser/IDE at OS level; local store; MCP-exposed | Up to 9 months timeline | **OS-level** capture across every app (not just one tool) + timeline navigation | OS-wide cross-app capture; timeline roll-ups |
| **MemoryOS** | Research system (EMNLP'25, OSS) | 3-tier hierarchical (short→mid→long) + heat-based promotion; FIFO + segmented-page updates | Dialogue-chain ordering | Hierarchical memory paging/promotion (+49% F1 on LoCoMo vs baselines) | Heat-based tier promotion; OS-style paging between tiers |
| **A-MEM** | Research system (arXiv 2502.12110, OSS) | **Zettelkasten** memory notes; auto-generated descriptors; bidirectional links; **memory evolution** (notes update each other) | Implicit via links | Self-organizing, evolving note network without fixed memory ops | Auto-linking + memory *evolution* (new notes revise old ones) |
| **Microsoft GraphRAG** | Graph-RAG framework (OSS) | KG extraction → Leiden communities → hierarchical community summaries; local + **global** search | None | **Global** sensemaking ("what are the themes across the whole corpus?") via community summaries | Hierarchical community detection + summary-based global queries |
| **HippoRAG / HippoRAG 2** | Research RAG framework (NeurIPS'24, OSS) | KG over entities+passages + **Personalized PageRank** (hippocampal indexing); single-step multi-hop | None | Cheap/fast multi-hop retrieval (+20% multi-hop, 10–20x cheaper than iterative) | Personalized-PageRank multi-hop retrieval over an entity graph |
| **`@modelcontextprotocol/server-memory`** (official) | Official MCP memory server | In-memory/JSON **knowledge graph**: entities + relations + observations; no embeddings | None | Being the canonical/default; dead-simple typed graph for solo use | (We're broader, but lack their clean entity/relation/observation primitive) |
| **APEX-MEM / MemMachine / Hindsight** | 2026 research frontier | Agentic semi-structured memory + temporal reasoning; ground-truth-preserving | Strong temporal | Pushing reflect/recall/retain + ground-truth preservation | Reflection loops; ground-truth preservation |
| **`mcp-memory-server` (ours)** | Local-first MCP memory server | Hybrid sqlite-vec + FTS5 **RRF**; local Transformers.js; SQLite single file | Temporal **decay** (recency), expiration | Privacy-by-architecture + enterprise metadata + self-improving dream cycle, all local | — (this is the baseline) |

---

## Per-system detail (one-line + storage/retrieval + #1 strength + what we lack)

### mem0 / OpenMemory
- **What it is:** The most-adopted open memory layer (41K★, AWS Agent SDK's exclusive memory provider); OpenMemory is its local/MCP-friendly variant.
- **Storage/retrieval:** Hybrid graph + vector + key-value. April 2026 algorithm went **ADD-only single-pass extraction** (one LLM call, memories accumulate), with **entity linking** and **multi-signal retrieval** (semantic + BM25 + entity fused).
- **Best at:** LLM-grade fact extraction with extreme token efficiency — LoCoMo 71.4→91.6, LongMemEval 67.8→94.8 (Apr 2026), ~7K tokens, ~1s p50.
- **We lack:** Any LLM-driven extraction/entity-linking inline; our extraction is heuristic + opt-in `claude -p`.

### Letta (formerly MemGPT)
- **What it is:** Platform for **stateful agents**; "LLM-as-an-operating-system."
- **Storage/retrieval:** Tiered — always-in-context **core memory blocks** (persona/human) + **archival** + **recall** memory on disk; the agent edits its own memory via tools (`memory_replace`, `memory_insert`, `archival_memory_search`, `conversation_search`).
- **Best at:** Agents that **self-manage** memory (decide what to promote/evict) inside a full agent runtime.
- **We lack:** Agent-editable memory blocks and self-editing tools; we're a passive store the agent queries.

### Zep + Graphiti
- **What it is:** Context-engineering platform built on **Graphiti**, an OSS **temporal knowledge graph** engine; Graphiti MCP server v1.0 shipped Nov 2025.
- **Storage/retrieval:** Bi-temporal KG (Neo4j/FalkorDB) + hybrid semantic/BM25/graph traversal. Every fact carries **valid-time** (true in the world) and **transaction-time** (ingested). Stale facts are **invalidated, not deleted**.
- **Best at:** Point-in-time / change-over-time reasoning ("What was the contract status in March?") — the canonical thing pure vector stores cannot do. Widely cited as most architecturally sophisticated (~24.5K★).
- **We lack:** A real typed graph, bi-temporal validity windows, and fact invalidation. (Our temporal feature is recency *decay*, not validity.)

### basic-memory (basicmachines-co)
- **What it is:** Local-first MCP knowledge system; persistent semantic graph from AI conversations, stored as plain **Markdown** files, **Obsidian-native**.
- **Storage/retrieval:** Markdown is the source of truth; SQLite index for semantic search; wiki-links + observations form a real graph in Obsidian's graph view. 15+ tools.
- **Best at:** **Humans and AI editing the same Markdown files** — you read/write/sync the same notes the agent does.
- **We lack:** True **bidirectional write-back** — we *read* Obsidian vaults (vault_sync) but don't write memories back as `.md` Obsidian can edit (it's on our roadmap). Also their observation/relation note model.

### Cognee (topoteretes)
- **What it is:** "Memory control plane for AI agents in 6 lines"; an AI memory engine that builds self-improving graphs (raised $7.5M seed; ~70+ companies incl. Bayer).
- **Storage/retrieval:** **ECL pipeline** (Extract-Cognify-Load): ingests 38+ source types → LLM-extracted entities/relations → embeddings + **ontology** → vector store + graph edges, with page-level provenance.
- **Best at:** Converting messy heterogeneous corpora (PDF/SQL/API/tables) into an ontology-grounded, provenance-tracked knowledge graph.
- **We lack:** Multi-source ingestion connectors, ontology grounding, and provenance at the graph-edge level.

### byterover
- **What it is:** Agent-native memory management for coding agents (Cursor/Windsurf/Cline/Claude Code) via MCP; ByteRover 2.0 tops the LoCoMo leaderboard (92.2%).
- **Storage/retrieval:** **Deliberately vector-free** — a hierarchical Markdown **Context Tree** + **MiniSearch** full-text index + tiered retrieval (fuzzy text → deeper LLM-driven search). Local-first, no external DB.
- **Best at:** LLM-**curated**, human-readable hierarchical coding memory that both agents and humans can reason about and edit.
- **We lack:** The curated hierarchical tree structure and the cheap-to-precise tiered retrieval escalation.

### supermemory
- **What it is:** "Universal memory layer" API; #1 on LongMemEval, LoCoMo, and ConvoMem simultaneously; 10K+ devs, 70+ YC cos.
- **Storage/retrieval:** Hybrid vector + **memory graph** + auto **user profiles**; multi-modal extractors (PDF/OCR/video transcription/AST-aware code chunking); **connectors** (Drive/Gmail/Notion/OneDrive/GitHub) with webhook sync. <300ms, 100B+ tokens/mo. Runs cloud, on-prem, or air-gapped.
- **Best at:** One API for the **entire context stack** — memory + RAG + connectors + user profiles + compliance.
- **We lack:** Auto-maintained user profiles, first-party connectors, and multi-modal extraction.

### txtai (NeuML)
- **What it is:** All-in-one OSS AI framework; the core is an embeddings database.
- **Storage/retrieval:** A **union of sparse+dense vector indexes, a graph network, and a relational DB** — you can run **SQL over vectors**, do topic modeling, and embed text/audio/image/video.
- **Best at:** A single local embeddings DB that natively combines vectors **+ graph + SQL + multimodal** with LLM pipelines/workflows.
- **We lack:** A graph network layer over embeddings, SQL-over-vectors querying, and multimodal embedding.

### Memori (GibsonAI / Memori Labs)
- **What it is:** OSS **SQL-native** memory engine; positions explicitly *against* costly vector DBs (Memori Cloud launched Mar 2026).
- **Storage/retrieval:** Standard SQL (SQLite/Postgres/MySQL) + full-text search + versioning — **no vector DB**. A **3-agent** loop captures conversations, analyzes them, and injects the most relevant memory back into the LLM. Claims 80–90% lower cost, 10–50ms (2–4x faster than vector similarity).
- **Best at:** Transparent, portable, cheap memory using infrastructure teams already run (plain SQL).
- **We lack:** The capture→analyze→inject multi-agent loop and full SQL transparency (we use sqlite-vec/FTS5, less portable than vanilla SQL).

### claude-mem (thedotmack)
- **What it is:** The breakout Claude Code memory **plugin** (72K★, v12.6.4 May 2026); works across Claude Code, Codex, Gemini, OpenCode, Copilot.
- **Storage/retrieval:** **5 hooks** (SessionStart/PostToolUse/Stop/UserPromptSubmit/SessionEnd) auto-capture every tool invocation → compress with Claude's **Agent SDK** → SQLite + FTS; 3-layer retrieval, ~10x token efficiency.
- **Best at:** **Zero-effort** automatic capture + AI compression — the user never manually stores anything.
- **We lack:** Automatic capture of all tool I/O and AI-based compression of it. (Our hooks track searches and run an opt-in session-end review, but we don't auto-compress every tool call.)

### Pieces
- **What it is:** OS-level "infinite memory" product for developers; LTM-2 agent.
- **Storage/retrieval:** Captures context at the **OS level across all apps/browsers/IDEs**; up to **9 months** of workflow history; stored locally via PiecesOS; exposed via MCP. Timeline/roll-up navigation.
- **Best at:** Capturing context **outside** any single tool — the whole desktop workflow.
- **We lack:** Cross-app OS-level capture and timeline roll-ups. (Ours is scoped to MCP-client sessions.)

### MemoryOS (BAI-LAB, EMNLP 2025 Oral)
- **What it is:** A memory **operating system** for personalized agents.
- **Storage/retrieval:** Three tiers — short / mid / long-term personal memory — with **heat-based promotion**; short→mid via dialogue-chain FIFO, mid→long via segmented-page strategy. +49% F1 on LoCoMo.
- **Best at:** OS-style **paging/promotion** of memories between tiers by access heat.
- **We lack:** Tiered hot/warm/cold promotion (we have flat importance scoring + pruning, no tier movement).

### A-MEM (agiresearch, arXiv 2502.12110)
- **What it is:** "Agentic memory" — dynamic memory structuring without fixed operations.
- **Storage/retrieval:** **Zettelkasten** memory notes; each new note gets LLM-generated descriptors/keywords/tags and is **bidirectionally linked** to related notes; **memory evolution** — new notes can update the attributes of old ones.
- **Best at:** A self-organizing, continuously refining note network.
- **We lack:** Auto-linking between memories and **memory evolution** (revising existing memories when new ones arrive). Our consolidation merges duplicates but doesn't enrich/evolve survivors.

### Microsoft GraphRAG
- **What it is:** The reference graph-RAG framework (v1.0 Dec 2024; dynamic community selection Nov 2024).
- **Storage/retrieval:** Extract KG → cluster into **Leiden hierarchical communities** → LLM-summarize each community → **local** (entity-focused) and **global** (corpus-wide) search.
- **Best at:** **Global sensemaking** — "what are the major themes across this entire corpus?" — which chunk-level vector RAG fundamentally cannot answer.
- **We lack:** Hierarchical community detection and community-summary-based global queries.

### HippoRAG / HippoRAG 2 (OSU-NLP, NeurIPS'24)
- **What it is:** Neurobiologically inspired (hippocampal indexing) long-term memory for LLMs.
- **Storage/retrieval:** KG over entities+passages + **Personalized PageRank** for single-step multi-hop retrieval (neocortex=LLM, hippocampus=PPR index). HippoRAG 2 extends to passages.
- **Best at:** Cheap, fast **multi-hop** retrieval (+20% multi-hop vs SOTA; 10–20x cheaper, 6–13x faster than iterative IRCoT).
- **We lack:** Multi-hop reasoning via graph + Personalized PageRank.

### Official `@modelcontextprotocol/server-memory` (Anthropic/MCP)
- **What it is:** The canonical default MCP memory server.
- **Storage/retrieval:** A simple JSON-persisted **knowledge graph**: `entities` (nodes) + `relations` (directed, active-voice) + `observations` (facts per entity). Tools like `create_entities`, `create_relations`, `add_observations`, `read_graph`, `search_nodes`. **No embeddings**, no semantic search.
- **Best at:** Being the simple, official baseline; clean typed graph primitives for solo use. Noted to "break at scale."
- **We lack:** Their crisp **entity/relation/observation** modeling primitive — we have richer metadata but no first-class typed relations.

### 2026 research frontier (APEX-MEM, MemMachine, Hindsight)
- **APEX-MEM** (arXiv 2604.14362): agentic **semi-structured** memory with explicit temporal reasoning for long-term conversation.
- **MemMachine** (arXiv 2604.04853): **ground-truth-preserving** memory for personalized agents.
- **Hindsight** (arXiv 2512.12818): "retain, recall, reflect" — adds a **reflection** loop; 91.4% LongMemEval, ~89.6% LoCoMo.
- **We lack:** Reflection loops and ground-truth preservation guarantees.

---

## (a) Table-stakes — everyone has these in 2026

Per mem0's *State of AI Agent Memory 2026* and corroborated across systems, the baseline every serious memory system now ships:

1. **Semantic (vector) retrieval** + usually keyword/BM25 fusion. *(We have this — RRF hybrid.)*
2. **Metadata filtering / scoped queries** by project, time, user, type. *(We have this — strong: scope/namespace/department/access_level/tags/language.)*
3. **Multi-scope identity model** (user_id / agent_id / run_id / org_id). *(Partial — we have scope/namespace/department/team but no explicit per-actor agent_id/run_id.)*
4. **Async / non-blocking memory writes.** *(Gap — our store is synchronous in the request path; embedding is in-line.)*
5. **A reranking / scoring pass** before injection. *(We have confidence scoring + RRF, but no learned reranker.)*
6. **Timestamp accuracy for temporal ordering.** *(We have created/updated + temporal decay.)*
7. **Some temporal awareness** (time-aware ranking). *(We have decay + expiration; weakest among leaders here.)*
8. **MCP exposure** (the integration surface). *(We have this — full MCP server.)*

**Verdict:** We hit most table-stakes. Our two soft spots are (3) per-actor identity and (4) async writes; our (7) temporal is decay-only.

## (b) Differentiators — only 1–2 players have these

1. **Bi-temporal validity windows + fact invalidation** — **Zep/Graphiti** essentially alone. ("What was true on date X"; invalidate, don't delete.)
2. **LLM ADD/UPDATE/DELETE/NOOP reconciliation with entity linking** — **mem0** (and supermemory's contradiction handling) lead.
3. **Agent self-editing memory blocks (LLM-as-OS)** — **Letta**.
4. **Memory *evolution*** (new memories revise old ones) — **A-MEM** (research), edging into supermemory/mem0.
5. **Global community-summary sensemaking** — **GraphRAG** (and Cognee's ontology variant).
6. **Personalized-PageRank multi-hop** — **HippoRAG**.
7. **OS-level cross-app capture** — **Pieces** (uniquely outside-the-tool).
8. **Zero-effort auto-capture + AI compression of every tool call** — **claude-mem** (and byterover's curated tree).
9. **Auto-maintained user profiles + first-party connectors + multi-modal extraction** — **supermemory**.
10. **SQL-native, vector-free, ultra-cheap memory** — **Memori** (a deliberate anti-vector bet).

**Where *we* differentiate:** privacy-by-architecture (truly local, single SQLite file, zero telemetry, no cloud round-trip ever), an explicit **enterprise metadata + access-level** model spanning legal/finance/HR/sales (most rivals are user-chat-centric), and a transparent **self-improving "dream cycle"** (score→expire→prune→dedup→gaps) with knowledge-gap detection. Few local-first servers combine all three.

## (c) White-space — nobody has solved these well (our opportunity)

From mem0's 2026 gap analysis + cross-system synthesis:

1. **Temporal abstraction at scale** — everyone degrades ~25% going 1M→10M tokens; temporal queries remain the hardest category on every benchmark. *No clear winner.*
2. **Cross-session identity resolution** — every system assumes a stable `user_id`; anonymous sessions, multi-device, and mixed-auth users break memory. *Unsolved.*
3. **Memory staleness / confidently-wrong facts** — a heavily-retrieved fact ("works at Acme") silently becomes wrong when reality changes. Only Zep's invalidation partially addresses it; nobody does proactive staleness detection well.
4. **Privacy / consent / GDPR-grade deletion architecture** — "who can read it, how long is it kept, how does a user delete it" is punted to the application layer everywhere. **This is a natural moat for a local-first server like ours** (we already have access_level, single-file delete, version audit trail — we could own "compliant memory").
5. **Application-level / domain evaluation** — benchmarks measure generic recall; nobody offers per-domain (legal/healthcare/finance) eval harnesses. Our department model is a head start toward domain-tuned memory.
6. **Multi-agent shared memory with actor attribution** — tracking *which* agent wrote *which* memory in a multi-agent system is early; mem0/Memori gesture at it, nobody nails it.
7. **Cross-session structure evolution** — modeling *how* a user's circumstances change over time (not just overwriting) — A-MEM and Zep poke at it; broadly open.

---

## Strategic implications for `mcp-memory-server`

**Closest competitors (same niche — local-first MCP memory):** basic-memory, claude-mem, byterover, official MCP memory server. We out-feature all of them on metadata/enterprise/consolidation, but **claude-mem out-UXes us on zero-effort auto-capture**, **basic-memory out-integrates us on Obsidian write-back**, and **byterover beats us on benchmark scores + curated hierarchy**.

**Highest-leverage moves (ranked):**
1. **Add a typed-relation graph layer** (entities/relations on top of memories) — closes the gap to the official server, basic-memory, Cognee, and unlocks multi-hop. We already render a graph; make it queryable.
2. **Add bi-temporal validity + fact invalidation** (Graphiti's edge) — the single biggest "reasoning" differentiator; turns decay into real "what was true when."
3. **Upgrade extraction to inline LLM reconciliation** (mem0's ADD/UPDATE/DELETE/NOOP) — replace heuristic extraction with a real conflict/dedup-aware writer.
4. **Lean into the privacy/compliance white-space** — position as "the GDPR-grade, fully-local, audit-trailed memory server." We're uniquely placed (local + access_level + versions + single-file delete). No incumbent owns this.
5. **Zero-effort auto-capture** to match claude-mem's UX (PostToolUse capture + optional AI compression), keeping it opt-in for privacy.
6. **Obsidian bidirectional write-back** (already roadmapped) to match basic-memory.

---

## Citations (primary sources)

- mem0 — *State of AI Agent Memory 2026:* https://mem0.ai/blog/state-of-ai-agent-memory-2026
- mem0 — *AI Memory Benchmarks in 2026:* https://mem0.ai/blog/ai-memory-benchmarks-in-2026
- mem0 — GitHub README (April 2026 algorithm + benchmarks): https://github.com/mem0ai/mem0
- mem0 — *Graph-Based Memory Solutions Compared (Jan 2026):* https://mem0.ai/blog/graph-memory-solutions-ai-agents
- Letta — *Agent Memory:* https://www.letta.com/blog/agent-memory ; Docs: https://docs.letta.com/concepts/letta/
- Letta — *Rearchitecting Letta's Agent Loop:* https://www.letta.com/blog/letta-v1-agent
- Zep — *Temporal Knowledge Graph Architecture (arXiv 2501.13956):* https://arxiv.org/abs/2501.13956
- Graphiti — GitHub README: https://github.com/getzep/graphiti ; Neo4j writeup: https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/
- Zep platform: https://www.getzep.com/
- basic-memory — GitHub: https://github.com/basicmachines-co/basic-memory ; PulseMCP: https://www.pulsemcp.com/servers/basicmachines-memory
- Cognee — GitHub: https://github.com/topoteretes/cognee ; *How Cognee Builds AI Memory:* https://www.cognee.ai/blog/fundamentals/how-cognee-builds-ai-memory ; MCP: https://www.cognee.ai/blog/cognee-news/introducing-cognee-mcp
- byterover — https://www.byterover.dev/ ; *Benchmark (LoCoMo 92.2%):* https://www.byterover.dev/blog/benchmark-ai-agent-memory ; arXiv: https://arxiv.org/html/2604.01599v1
- supermemory — GitHub: https://github.com/supermemoryai/supermemory ; site: https://supermemory.ai/
- txtai — GitHub: https://github.com/neuml/txtai
- Memori — GitHub: https://github.com/GibsonAI/memori ; MarkTechPost: https://www.marktechpost.com/2025/09/08/gibsonai-releases-memori-an-open-source-sql-native-memory-engine-for-ai-agents/ ; Memori Cloud: https://www.opensourceforu.com/2026/03/open-source-memory-engine-from-memori-labs-goes-fully-hosted-with-memori-cloud/
- claude-mem — GitHub: https://github.com/thedotmack/claude-mem ; Docs: https://docs.claude-mem.ai/introduction
- Pieces — *LTM-2 announcement:* https://pieces.app/blog/what-is-new-ltm-2 ; Long-Term Memory: https://pieces.app/features/long-term-memory ; MCP: https://pieces.app/features/mcp
- MemoryOS — arXiv 2506.06326: https://arxiv.org/abs/2506.06326 ; GitHub: https://github.com/BAI-LAB/MemoryOS
- A-MEM — arXiv 2502.12110: https://arxiv.org/abs/2502.12110 ; GitHub: https://github.com/agiresearch/a-mem
- Microsoft GraphRAG — *From Local to Global (arXiv 2404.16130):* https://arxiv.org/abs/2404.16130 ; docs: https://microsoft.github.io/graphrag/ ; *Dynamic community selection:* https://www.microsoft.com/en-us/research/blog/graphrag-improving-global-search-via-dynamic-community-selection/
- HippoRAG — arXiv 2405.14831: https://arxiv.org/abs/2405.14831 ; GitHub: https://github.com/osu-nlp-group/hipporag
- Official MCP memory server — npm: https://www.npmjs.com/package/@modelcontextprotocol/server-memory ; src: https://github.com/modelcontextprotocol/servers/tree/main/src/memory
- 2026 research frontier — APEX-MEM: https://arxiv.org/html/2604.14362v1 ; MemMachine: https://arxiv.org/pdf/2604.04853 ; Hindsight: https://arxiv.org/pdf/2512.12818
- Cross-market overviews — Atlan *Best AI Agent Memory Frameworks 2026:* https://atlan.com/know/best-ai-agent-memory-frameworks-2026/ ; ChatForest *Best Memory MCP Servers:* https://chatforest.com/guides/best-memory-mcp-servers/ ; AwesomeClaude *Knowledge/Memory MCP rankings:* https://awesomeclaude.ai/mcp/knowledge-memory
