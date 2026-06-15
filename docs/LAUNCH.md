# Launch copy

Drafts for posting. Not committed advice — edit to your own voice before you post. Post from your own accounts.

---

## Show HN

**Title**

```
Show HN: Local-first memory for Claude Code – one SQLite file, $0/token
```

**Body**

```
I kept re-explaining the same decisions to Claude Code every session. The bug I
fixed last week, why we picked Postgres, the auth convention — all gone the
moment the conversation ended. The cloud memory services fix that, but they want
my codebase decisions sitting on someone else's server, metered per token.

So I built the version I wanted: an MCP server that gives Claude a permanent,
searchable memory living in one SQLite file on my own machine. The embedding
model runs in Node (no Python, no GPU, no API key), search is hybrid vector +
keyword with a local cross-encoder reranker, and there's a bi-temporal knowledge
graph on top so it can answer multi-hop questions. Nothing leaves the machine and
nothing is metered.

I didn't want to hand-wave the retrieval quality, so the benchmarks are committed
in the repo and reproducible locally (real embedder, real handlers, no network).
On four public memory benchmarks it matches or beats MemPalace untuned —
LongMemEval-S 97.8% R@5, ConvoMem 93.5% R@10, LOCOMO and MemBench in the README
with the honest notes about where the reranker helps and where it hurts.

Setup is one command in Claude Code (`npx mcp-memory-graph init`): it registers
the server, installs the capture/recall hooks and a usage skill, and schedules a
nightly cleanup pass.

Honest limits: it's a single-process SQLite server, so vector search is an exact
scan — fast into the low hundreds of thousands of vectors, then you'd want a real
ANN index it doesn't have yet. The default model is English-first. And the license
is source-available, free for noncommercial use, paid for commercial — I'd rather
say that up front than bury it.

Repo: https://github.com/YonasValentin/mcp-memory-graph
npm: npm i -g mcp-memory-graph

Happy to get torn apart on the retrieval design or the SQLite ceiling.
```

---

## r/LocalLLaMA

**Title**

```
Local-first memory for Claude/Cursor/Codex: hybrid search + knowledge graph in one SQLite file, embeddings run on-device, $0/token
```

**Body**

```
Built an MCP memory server that runs entirely on your machine. The point was no
cloud and no per-token cost: local MiniLM embeddings via Transformers.js, sqlite-vec
for vector search, FTS5 for keyword, fused with RRF, then a local ms-marco
cross-encoder reranker. A HippoRAG-style Personalized PageRank pass over the entity
graph handles multi-hop recall.

Benchmarks are in-repo and reproducible (no network, real handlers): LongMemEval-S
97.8% R@5, ConvoMem 93.5% R@10, LOCOMO session R@10 82.2%, MemBench hit@5 78.7%,
untuned with the stock embedder. The reranker is the biggest single lever; the
README documents the one benchmark where it actually hurts.

Storage is one SQLite file with bi-temporal validity (updates invalidate instead
of overwriting, so history survives). 49 MCP tools, an Obsidian vault round-trip,
GDPR-style forget, signed provenance. Swappable embedding model via env var if you
want something multilingual.

Ceiling: exact vector scan, so comfortable to the low hundreds of thousands of
vectors before you'd want a dedicated ANN index. Fair trade for zero infra IMO.

https://github.com/YonasValentin/mcp-memory-graph
```

---

## r/ClaudeAI

**Title**

```
I gave Claude Code a permanent memory that lives on my machine (one command to set up)
```

**Body**

```
If you use Claude Code daily, you've felt it forget everything between sessions.
This is an MCP server that fixes that without sending anything to the cloud.

`npx mcp-memory-graph init` wires up the whole thing: it registers the server,
installs hooks that quietly capture decisions during a session and recall them in
later ones, drops in a skill that teaches Claude which of the tools to use, and
schedules a nightly cleanup. Memory lives in a single SQLite file. No API key, no
per-token cost.

Then you just talk. "Remember we use Postgres for the payment service, decided in
ADR-042." Next week: "what database did we pick for payments and why?" and it
comes back with the decision and the reasoning.

Free for personal use. Repo and a 5-minute quick start:
https://github.com/YonasValentin/mcp-memory-graph
```
