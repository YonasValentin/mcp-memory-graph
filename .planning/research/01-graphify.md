# Graphify — Deep Research Report

**Subject:** `safishamsi/graphify` (PyPI: `graphifyy` v0.8.23) — YC S26, "The Memory Layer"
**Site:** graphifylabs.ai (product: **Penpax**)
**Researched:** 2026-05-29 from a shallow clone of the public repo (default branch; active dev on `v8`) + web sources
**Why we care:** We are building an MCP memory server. Graphify is the most credible "code/knowledge → queryable graph → MCP" implementation in the wild, with a real extraction pipeline, an honest confidence model, and a query layer designed specifically to feed AI coding agents cheaply. This report extracts exactly what is novel and what we should steal.

---

## 1. One-paragraph summary

Graphify is a Python library + cross-assistant skill that turns any folder (code, docs, PDFs, images, audio/video, SQL, MCP configs) into a single NetworkX knowledge graph you query instead of grepping. It runs a deterministic, local, three-pass pipeline: (1) tree-sitter AST extraction of ~33 languages with no API calls, producing entities + call/import/contains edges plus a separate "rationale" node type harvested from `# NOTE:`/`# WHY:`/`# HACK:` comments and docstrings; (2) local faster-whisper transcription of audio/video, seeded with the top "god nodes" already found in the code graph; (3) LLM ("Claude subagent") semantic extraction over docs/PDFs/images/transcripts only. Every edge is tagged `EXTRACTED` / `INFERRED` / `AMBIGUOUS` with a discrete confidence score, giving an honest audit trail. Leiden community detection (Louvain fallback) clusters the graph with **no embeddings and no vector DB** — the LLM-emitted `semantically_similar_to` edges *are* the similarity signal. It then computes god nodes (degree), "surprising connections" (a composite cross-file/cross-community/cross-language surprise score), and auto-generated questions. The graph is exposed to agents via an MCP stdio server (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `god_nodes`, `graph_stats`, `get_community`, `list_prs`, `get_pr_impact`, `triage_prs`) and a CLI (`query`/`path`/`explain`). It installs as a `/graphify` skill into 20+ assistants and uses a git post-commit hook + a custom **git merge driver** that union-merges `graph.json` so the graph is a committable, conflict-free team artifact. Penpax is the commercial extension: the same engine applied continuously and on-device to meetings/browser/email/files/code — "build once, patch forever, no cloud."

---

## 2. Architecture

### 2.1 Pipeline (one function per stage, stateless dicts between them)

```
detect()  →  extract()  →  build_graph()  →  cluster()  →  analyze()  →  report()  →  export()
```

Modules communicate only through plain dicts and NetworkX graphs — no shared state, no side effects outside `graphify-out/`. Key module map (from `ARCHITECTURE.md` + source):

| Module | Responsibility | Notable size |
|---|---|---|
| `detect.py` | file collection + `.graphifyignore` (gitignore syntax + `!` negation), extension→category maps | 1,188 LOC |
| `extract.py` | tree-sitter AST extraction, one `extract_<lang>()` per language, rationale post-pass, parallel/sequential drivers | **10,127 LOC** (the heart) |
| `build.py` | merge extraction dicts → `nx.Graph`/`DiGraph`, 3-layer node dedup, edge ID reconciliation | 431 |
| `cluster.py` | Leiden (graspologic) → Louvain fallback, oversized + low-cohesion community splitting | 267 |
| `analyze.py` | god nodes, surprising-connection scoring, suggested questions, graph diff | 608 |
| `dedup.py` | entity dedup: normalize → entropy gate → MinHash/LSH → Jaro-Winkler → union-find | 425 |
| `symbol_resolution.py` | deterministic cross-file call resolution (the INFERRED `calls` second pass) | 528 |
| `serve.py` | MCP stdio server + IDF-weighted BFS/DFS query engine | 993 |
| `prs.py` | graph-aware PR dashboard (CI/review/worktree/blast-radius) | 748 |
| `global_graph.py` | cross-project graph in `~/.graphify/global-graph.json` | 159 |
| `hooks.py` + `__main__ merge-driver` | git post-commit/post-checkout auto-rebuild + union merge driver | 335 |
| `export.py` / `callflow_html.py` / `tree_html.py` / `wiki.py` | HTML, SVG, GraphML, Neo4j cypher, Obsidian vault, Mermaid callflow, agent-crawlable wiki | 1,373 / 2,020 / 582 / 282 |
| `cache.py` | SHA256 content-hash semantic cache | 329 |
| `scip_ingest.py` / `mcp_ingest.py` | ingest SCIP indexes and MCP server configs as nodes | 363 / 392 |

### 2.2 Graph data model (NetworkX node-link JSON)

**Node:** `id` (stable, NFKC-normalized), `label`, `file_type` ∈ {`code`,`document`,`paper`,`image`,`rationale`,`concept`}, `source_file`, `source_location` (e.g. `L42`), `community` (int), `norm_label` (search cache).

**Edge:** `source`, `target`, `relation` (verb: `calls`/`imports`/`uses`/`implements`/`semantically_similar_to`/`rationale_for`/…), `confidence` ∈ {`EXTRACTED`,`INFERRED`,`AMBIGUOUS`}, `confidence_score` (float, INFERRED only), `source_file`, plus `_src`/`_tgt` direction-preserving attrs.

**Hyperedges:** group relationships connecting 3+ nodes live in `G.graph["hyperedges"]`.

`validate.py` enforces this schema before `build_graph()` consumes it; the model can emit junk `file_type` values which `build.py` maps via `_FILE_TYPE_SYNONYMS` (e.g. `markdown→document`, `framework→concept`) rather than rejecting.

---

## 3. The extraction pipeline (in detail)

### Pass 1 — Code structure (local, free, no API calls)
- tree-sitter parses each code file → classes, functions, imports, call graph, plus a **rationale post-pass** (`_extract_python_rationale` etc.) that turns `# NOTE:`, `# IMPORTANT:`, `# HACK:`, `# WHY:`, `# RATIONALE:`, `# TODO:`, `# FIXME:` comments and docstrings into **separate `rationale` nodes** linked to the code they explain via `rationale_for` edges. This is how Graphify captures "the why."
- SQL gets deterministic special handling: tables, views, foreign keys, JOIN relationships.
- If a corpus is *only* code, Pass 3 (LLM) is skipped entirely — semantic extraction is reserved for non-code.
- Parallelism: `ProcessPoolExecutor` bypasses the GIL for true multiprocessing (~1.66x faster than sequential on 84 files).
- A **deterministic second pass** (`symbol_resolution.py`) resolves cross-file calls by building a `label → node-id` index (only `file_type=="code"` nodes are eligible callees) and emitting `INFERRED` `calls` edges. Cross-language phantom calls (same short name `render`/`parse` across language families) are dropped both here and in `build.py`.

### Pass 2 — Video/audio (local, free)
- faster-whisper transcribes locally; nothing leaves the machine.
- **Clever:** the transcription prompt is **seeded with the current top god nodes** from the code graph, biasing Whisper toward project-domain vocabulary. Transcripts are cached.

### Pass 3 — Docs / papers / images / transcripts (LLM, costs tokens)
- "Claude subagents" run in parallel batches; each emits a JSON fragment `{nodes, edges, hyperedges}` merged into the graph.
- Optional converters first turn `.docx`/`.xlsx`/Google Workspace shortcuts into Markdown sidecars under `graphify-out/converted/`.
- INFERRED edges use a **discrete confidence rubric**: 0.95 near-certain, 0.85 strong, 0.75 reasonable, 0.65 weak (naming only), 0.55 speculative. EXTRACTED is always 1.0.

### Caching & incremental
- Every file fingerprinted by SHA256; re-runs skip unchanged files.
- `build_merge()` **never replaces, only grows** the graph (prunes only via explicit `prune_sources`), and refuses to silently shrink the node count unless dedup/prune is active.
- `--update` / `graphify update` re-extracts only changed files (AST is free, so the git hook does this on every commit at zero API cost).

---

## 4. Graph construction, dedup, clustering, analysis

### 4.1 Node dedup — 3 layers (`build.py` comment block)
1. **Within a file (AST):** `seen_ids` set per extractor.
2. **Between files (build):** NetworkX `add_node` is idempotent; semantic nodes are added after AST nodes so richer semantic labels win, AST loses (intentional).
3. **Semantic merge (skill):** explicit `seen` set keyed on `node["id"]` before build.

### 4.2 Entity dedup pipeline (`dedup.py`) — genuinely sophisticated
`exact normalization → entropy gate → MinHash/LSH blocking → Jaro-Winkler verification → same-community boost → union-find merge`
- MinHash (128 perm) over 3-gram character shingles (spaces stripped so "graph extractor" == "graphextractor") for cheap candidate blocking via LSH.
- Jaro-Winkler verifies candidate pairs; a **variant-suffix guard** blocks merging sibling SKU/model variants (`M1` vs `M1 Pro`, `cranel` vs `cranelr`) and short-label insert/delete pairs that score high only due to the JW prefix bonus.
- Optional `--dedup-llm` tiebreaker for the ambiguous 75–92 JW score zone.

### 4.3 Clustering (`cluster.py`) — Leiden, no embeddings
- Tries `graspologic.partition.leiden` (random_seed=42, deterministic); **falls back to NetworkX Louvain** if graspologic isn't installed (it's Python<3.13 only). Output suppressed to avoid ANSI corrupting PowerShell buffers.
- Edge order and node order are **sorted before partitioning** for reproducibility (Louvain iterates hash-randomized sets → community churn; `PYTHONHASHSEED=0` is also exported in the hook).
- **Oversized communities** (>25% of graph, min 10 nodes) get re-split by a second Leiden pass.
- **Low-cohesion second pass:** communities with cohesion `< 0.05` and ≥50 nodes are re-split — this specifically targets doc-hub nodes (e.g. a `CLAUDE.md` connected to everything) that bridge unrelated subsystems.
- `cohesion_score` = actual intra-community edges / max possible. `remap_communities_to_previous` keeps community IDs stable across runs via greedy intersection matching (important for a committed artifact).
- `--exclude-hubs <percentile>`: utility super-hubs are pulled out of partitioning and reattached by majority-vote neighbor community afterward, so they don't drag unrelated subsystems together or inflate god-node rankings.

### 4.4 Analysis (`analyze.py`)
- **God nodes:** top-N by degree, but filtering out synthetic file-level hubs, AST method stubs (`.method()`), JSON noise keys, and concept nodes — so they represent real architectural abstractions, not mechanical import accumulators.
- **Surprising connections:** a **composite surprise score**, not just confidence. Points for: AMBIGUOUS(3)/INFERRED(2)/EXTRACTED(1), crossing file types (code↔paper, code↔image), crossing repos/top-level dirs, bridging Leiden communities, `semantically_similar_to` (×1.5), and peripheral→hub edges (low-degree node unexpectedly reaching a god node). It also *suppresses* structural bonuses for INFERRED code↔doc / cross-language `calls`/`uses` edges (resolver pollution). Each result carries a human-readable `why`.
- **Suggested questions:** generated from AMBIGUOUS edges, high-betweenness bridge nodes, god nodes with ≥2 INFERRED edges (verification prompts), isolated nodes (doc-gap detection), and low-cohesion communities ("should this be split?").
- **`graph_diff(G_old, G_new)`:** structured added/removed nodes+edges — a built-in "what changed" primitive.

---

## 5. Query model — what an agent can actually ask

### 5.1 CLI / skill commands
- `graphify query "<question>"` — IDF-weighted keyword match → seed nodes → **BFS** (broad context); `--dfs` traces a specific path; `--budget N` caps output tokens.
- `graphify path "A" "B"` — shortest path between two concepts.
- `graphify explain "Node"` — plain-language explanation of one node.
- `graphify add <url|youtube|arxiv>` — fetch+ingest a paper/video into the graph.

### 5.2 The query engine internals (`serve.py`) — worth copying
- **Term scoring is IDF-weighted** (`_compute_idf`, cached on the graph object): common terms like "error"/"exception" that hit hundreds of nodes get low weight; rare identifiers like `FooBarService` get high weight.
- **Three-tier precedence per term:** exact (×1000) > prefix (×100) > substring (×1) > source-file match (×0.5), strongest tier only (no double counting).
- **Seed selection with a gap cutoff** (`_pick_seeds`): max 3 seeds, stop when a candidate scores <20% of the top — prevents noise terms from stealing seed slots from a dominant identifier match.
- **Hub-avoiding traversal:** BFS/DFS will not *expand through* nodes above the p99 degree (floored at 50) unless they're a seed — stops a single super-hub from exploding the result set.
- **Token-budgeted rendering** (`_subgraph_to_text`, ~3 chars/token): seeds first, then degree-sorted; truncates with an actionable hint ("narrow with context_filter=['call'] or use get_node").
- **Context filters** (`call`/`import`/`field`/`parameter_type`/`return_type`/`generic_arg`): explicitly passed or **inferred from the question wording** ("what calls X?" → filter to `call` edges) by filtering the traversal subgraph before BFS.
- **CJK-aware:** jieba segmentation for Chinese queries, diacritic stripping for everything else.

### 5.3 MCP server surface (`python -m graphify.serve graph.json`)
Tools: `query_graph`, `get_node`, `get_neighbors` (+relation_filter), `get_community`, `god_nodes`, `graph_stats`, `shortest_path`, **`list_prs`**, **`get_pr_impact`**, **`triage_prs`**.
MCP **Resources** (read-only, addressable): `graphify://report`, `graphify://stats`, `graphify://god-nodes`, `graphify://surprises`, `graphify://audit`, `graphify://questions`.
- **Hot reload:** `_maybe_reload()` stats the graph file by (mtime_ns, size) on every tool call and reloads if it changed — so a background `graphify watch` / git-hook rebuild is picked up live without restarting the server.
- **Security hardening on output:** every LLM-derived field passes `sanitize_label()` before entering MCP tool output (strips control/ANSI chars, caps 256, HTML-escapes) — explicitly to stop a poisoned corpus doc from injecting prompt-injection or fake log lines into the model's context.

---

## 6. Install model across 20+ assistants (the distribution play)

- `pip/uv/pipx install graphifyy` then `graphify install` registers the `/graphify` skill.
- Targets (each with its own tailored skill file, ~50–68 KB markdown each): Claude Code, Codex (`$graphify`, needs `multi_agent=true`), OpenCode, Cursor, Gemini CLI, GitHub Copilot CLI, VS Code Copilot Chat, Aider, Amp, OpenClaw, Factory Droid, Trae/Trae-CN, Hermes, Kimi Code, Kiro, Pi, Devin CLI, Google Antigravity.
- `--project` flag installs into the repo (`.claude/skills/graphify/SKILL.md` etc.) and prints a `git add` hint, vs the default user-profile install.
- **"Always use the graph" enforcement, two tiers:**
  1. On payload-bearing-hook platforms (Claude Code, Gemini CLI), a **hook fires before search-style tool calls** and nudges the agent toward `graphify query` instead of grep/read.
  2. On the rest, **persistent instruction files** (`AGENTS.md`, `.cursor/rules/`) carry the same "query-first" guidance.
- The skill's own front-matter is the key behavioral trick: *"especially if graphify-out/ exists, treat the question as a /graphify query"* — and a **fast path** that, if `graphify-out/graph.json` exists and the user asks a natural-language codebase question, **skips file detection/size gating entirely and runs `graphify query` immediately.**

### Team / git integration (the "committable artifact" insight)
- `graphify-out/` is meant to be **committed to git** so the whole team starts with a map.
- `graphify hook install` adds post-commit + post-checkout hooks that rebuild the AST graph for free, **and installs a git merge driver** (`graphify merge-driver %O %A %B`) that **union-merges `graph.json`** so two devs committing in parallel never get conflict markers — their graphs merge automatically.
- Recommended `.gitignore`: ignore `manifest.json` (mtime-based, breaks after clone) and `cost.json` (local), optionally commit the cache.

---

## 7. Cross-project / global graph + PR intelligence

- **Global graph** (`~/.graphify/global-graph.json`): `graphify global add <graph.json> <tag>` prefixes all node IDs with `tag::`, dedups external-library nodes by label across repos, tracks each repo by source SHA so unchanged graphs are skipped. `global list/remove/path`. This is a cross-repo memory across your whole machine.
- **Graph-aware PR dashboard** (`graphify prs`): pulls open PRs via `gh`, classifies them (WRONG-BASE / CI-FAIL / CHANGES-REQ / DRAFT / STALE / PENDING / APPROVED / READY), maps worktrees→branch→PR, and computes **graph blast radius** ("N nodes / C communities touched") by intersecting changed files with graph communities. `--conflicts` finds PRs that share communities (merge-order risk); `--triage` lets an LLM rank the review queue using the graph-impact data. Exposed via MCP so an agent can ask "what should I review?" with structural context.

---

## 8. Benchmarks & claims (with honesty caveats)

- Token reduction per query vs reading raw files: **71.5x** on a 52-file mixed corpus (Karpathy repos + 5 papers + 4 images), **5.4x** on 4 files, **~1x** on 6 files. The docs are honest that small corpora that already fit in context gain *structural clarity*, not compression. `worked/` folders ship raw inputs + actual outputs so claims are reproducible.
- ~1.66x faster parallel AST extraction on 84 files.
- graphifylabs.ai marketing figures: 38k+ GitHub stars, 550k+ downloads (treat as marketing; PyPI badge pulls live ClickPy numbers).
- Privacy: code + audio/video never leave the machine; only docs/PDFs/images hit an LLM. No telemetry.

---

## 9. Penpax (graphifylabs.ai) — the commercial vision

Penpax is "the always-on layer built on top of graphify," applying the same graph engine to your **entire working life**: meetings, browser history, emails, files, and code, updating **continuously in the background, fully on-device, no cloud**. Positioning from the site:
- *"Build once. Patch forever."* — explicitly contrasted with RAG pipelines that re-embed everything on change: "When a file changes, only affected nodes and edges update… even at millions of files." (Marketing comparison: competitors "re-embed 500k docs… 4h 12m"; Penpax "patch affected nodes only… 0.8s, 498,752 nodes intact.")
- Framed as a **persistent memory engine / on-device digital twin of your knowledge** ("AI tools forget… no cloud, no forgetting," Mnemosyne/Turing-Bombe branding).
- Deployment modes: open-source local/air-gapped (MIT) vs managed cloud for teams.
- Author Safi Shamsi is writing a book, *The Memory Layer*, on building persistent KG-backed memory for AI agents.

---

## 10. What is genuinely novel (ranked)

1. **No embeddings, no vector DB — the graph structure *is* the similarity index.** LLM-emitted `semantically_similar_to` edges feed Leiden directly. This sidesteps the entire embed/re-embed/index-rebuild cost that kills incremental RAG. This is their core technical bet and the whole Penpax pitch.
2. **Confidence as a first-class, honest audit trail** (`EXTRACTED`/`INFERRED`/`AMBIGUOUS` + discrete 0.55–0.95 rubric). The agent always knows what was found vs guessed, and AMBIGUOUS edges drive the "questions to ask" feature.
3. **The graph as a committable, conflict-free git artifact** via a custom union merge driver + free AST rebuild hook. Memory that lives in the repo and survives clone/pull/parallel commits.
4. **Hub-avoiding, IDF-weighted, token-budgeted traversal** purpose-built so an LLM gets a tight, relevant subgraph instead of a context-blowing hairball — with question-inferred edge-context filters.
5. **"The why" as graph nodes** — rationale comments/docstrings become `rationale_for` nodes, so design intent is queryable, not just structure.
6. **Surprise scoring** — a real, multi-factor heuristic for *non-obvious* cross-cutting links, with suppression of known resolver-pollution patterns.
7. **Incremental-only, never-shrink graph** with SHA256 caching, prune-on-explicit-request, and stable community IDs across runs.
8. **Cross-project global graph** + **graph-aware PR blast-radius** — memory that spans repos and informs workflow decisions.
9. **Local-first multimodal extraction** (tree-sitter for 33 langs + faster-whisper) with the LLM reserved only for the genuinely-semantic non-code surface — and Whisper prompts seeded by code god-nodes.
10. **Distribution as a behavioral skill into 20+ assistants** with a "query-first" hook and a fast-path that intercepts codebase questions before the agent grabs for grep.

---

## 11. What an MCP memory server should steal (concrete)

- **Confidence-tagged edges/memories.** Every stored relationship/memory gets `EXTRACTED|INFERRED|AMBIGUOUS` + a discrete score. Surface AMBIGUOUS items as "verify this" prompts. This single idea makes memory trustworthy and self-auditing.
- **MCP tool shape that mirrors graphify's.** Offer `query` (token-budgeted subgraph traversal), `get_node`, `get_neighbors`, `shortest_path`, `stats`, plus read-only **MCP Resources** (`memory://report`, `memory://stats`, `memory://audit`, `memory://questions`). The split of "tools for traversal, resources for digests" is a clean, copyable design.
- **IDF-weighted + three-tier (exact/prefix/substring) seed selection, hub-avoiding BFS/DFS, and a hard token budget with an actionable truncation hint.** This is the difference between a memory server that helps an agent and one that floods its context. Copy `_compute_idf`, `_pick_seeds` (gap cutoff), `_bfs` (p99 hub threshold), `_subgraph_to_text` almost verbatim.
- **Question-inferred context filters.** Parse the query for verbs ("calls", "imports", "returns") and pre-filter the traversal subgraph by edge type before searching.
- **Hot-reload by (mtime_ns, size).** Let a background writer update the store and have the MCP server pick it up live without restart.
- **Sanitize every stored/LLM-derived string before it enters MCP output** (control/ANSI strip, length cap, HTML-escape) — memory servers ingest untrusted content and are a prime prompt-injection vector. Graphify treats this as a named threat (F-010).
- **Incremental, never-shrink, content-hashed store** with explicit prune. SHA256 each source; only re-process changes; refuse silent shrink. This is what makes "build once, patch forever" real.
- **Make the memory a committable artifact** with a **git union merge driver** so a team shares memory through the repo and parallel writers don't conflict. For a *per-user* MCP memory server, the same union-merge logic prevents corruption across concurrent sessions/devices.
- **Stable IDs across rebuilds** (NFKC normalization + `remap_communities_to_previous`-style greedy matching) so memory references don't churn.
- **Structure as the index, not embeddings (or hybrid).** At minimum, store explicit relationship edges so retrieval can traverse rather than only nearest-neighbor — cheaper to update incrementally and gives explainable paths (`shortest_path`/`explain`). Consider keeping embeddings only as one edge-source feeding the graph, exactly as graphify keeps `semantically_similar_to` as just another edge.
- **"What changed" + "questions to ask" primitives.** A `diff(old,new)` tool and an auto-generated "open questions / gaps" digest turn a passive store into an active memory that prompts the agent.
- **god-node / blast-radius style ranking** to answer "what matters most" and "what does touching X affect" from the memory graph.

### Caveats / where graphify is weaker (our opportunity)
- It has **no temporal model** — see issue #152 ("integrate agentmemory for temporal memory + graphify for structural knowledge"). A memory server's killer feature is *time* (recency, decay, supersession). Graphify is structural-only; we can own temporal + structural.
- The semantic Pass-3 quality is only as good as the one-shot LLM JSON extraction; no cross-document reconciliation beyond dedup. A memory server can add reflection/consolidation passes.
- Code-only corpora skip semantics entirely — fine for code, but a general memory server needs the semantic layer always-on.

---

## 12. Citations (primary sources)

- Repo (cloned): https://github.com/safishamsi/graphify — `README.md`, `ARCHITECTURE.md`, `AGENTS.md`, `pyproject.toml`, `docs/how-it-works.md`, and source: `graphify/{extract,build,cluster,analyze,dedup,symbol_resolution,serve,prs,global_graph,hooks,cache}.py`, `graphify/skill.md`
- How it works: https://github.com/safishamsi/graphify/blob/v8/docs/how-it-works.md
- README (v8): https://github.com/safishamsi/graphify/blob/v8/README.md
- PyPI package: https://pypi.org/project/graphifyy/
- Product site (Penpax / Graphify Labs): https://graphifylabs.ai (scraped via crawlux 2026-05-29)
- YC company page: https://www.ycombinator.com/companies/graphify
- Temporal-memory integration discussion: https://github.com/safishamsi/graphify/issues/152
- Author: https://github.com/safishamsi ; book "The Memory Layer": https://safishamsi.gumroad.com/l/qetvlo
- Secondary write-ups: https://knightli.com/en/2026/05/21/safishamsi-graphify-ai-code-knowledge-graph/ ; https://medium.com/data-science-in-your-pocket/andrej-karparthys-llm-wiki-codes-graphify-b73bec5d87ea ; https://emelia.io/hub/knowledge-graph-graphify-guide
