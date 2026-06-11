# Retrieval benchmarks (R0)

A reproducible, fully-local retrieval-quality benchmark. It turns the privacy
story from a claim into a number: every result here is produced on the machine
running it, with the real embedding model and the real production handlers, at
**$0 per token** and **zero network egress**. Nothing is self-reported from a
cloud API — clone the repo and re-run it.

## What it measures

The harness builds a fixed gold-set corpus ("Helios", a 24-memory B2B billing
SaaS knowledge base) and a set of natural-language queries with a single known
best hit each. It stores every memory through the real `memory_store` handler
and runs `memory_search` over the gold queries **twice** — once with the
hybrid RRF ranker alone, and once with the local cross-encoder reranker as the
final stage — then reports:

| Metric | Meaning |
|---|---|
| `precision_at_1` | Fraction of queries whose gold hit is ranked #1. |
| `precision_at_3` | Fraction whose gold hit is in the top 3. |
| `mrr` | Mean Reciprocal Rank (mean of 1/rank, misses count 0). |
| `store_latency` | avg + p95 ms per `memory_store` call. |
| `search_latency` | avg + p95 ms per `memory_search` call (per mode). |
| `precision_at_1_lift` / `mrr_lift` | Reranker gain over the hybrid baseline. |

The metric math lives in a small dependency-free module,
[`scripts/bench/metrics.mjs`](../scripts/bench/metrics.mjs), and is covered by
a deterministic unit test (`src/__tests__/bench-metrics.test.ts`) so the
formulas can't silently drift.

## How it runs

The harness loads the **real** model — `TransformersEmbeddingProvider` wrapped
in `CachedEmbeddingProvider` (all-MiniLM-L6-v2, 384-dim) — and the real tool
handlers (`handleStore`, `handleSearch`), not the test mock. There is no build
step: a tiny esbuild-based loader ([`scripts/bench/ts-loader.mjs`](../scripts/bench/ts-loader.mjs))
runs the TypeScript sources directly, so the benchmark exercises exactly the
code that ships.

```bash
# Default: 24-row in-memory corpus, both ranking modes.
npm run bench

# Latency at scale: duplicate the corpus to ~1000 rows (24 * 42).
BENCH_CORPUS_SCALE=42 npm run bench

# On-disk SQLite instead of :memory: (clears the file first).
BENCH_DB=/tmp/bench.db npm run bench
```

Output is machine-readable JSON on stdout (model load logs go to stderr), so
it pipes straight into `jq` or a file:

```bash
npm run bench --silent > bench-result.json
```

At `BENCH_CORPUS_SCALE > 1` the corpus is duplicated with a distinct content
suffix so every row is a unique vector — this loads the index for latency
measurement without polluting the gold set; only the first, unsuffixed copy is
graded.

## Results

Run on the maintainer's local machine (Apple Silicon, CPU-only inference,
all-MiniLM-L6-v2 embedder + ms-marco-MiniLM-L-6-v2 reranker). Re-run with
`npm run bench` to reproduce; numbers vary slightly with hardware.

### Quality (24-row gold set, 16 queries)

| Mode | precision@1 | precision@3 | MRR | search avg / p95 (ms) |
|---|---|---|---|---|
| Hybrid (RRF) | 0.563 | 0.750 | 0.704 | ~3 / ~4 |
| + Cross-encoder rerank | **0.813** | **0.875** | **0.867** | ~120 / ~230 |
| **Reranker lift** | **+0.250** | **+0.125** | **+0.163** | — |

The reranker delivers a large precision-per-query win on the weak 384-dim
MiniLM base — consistent with Anthropic's published finding that reranking
materially reduces retrieval failures — while staying 100% local.

### Latency at scale (GAP 3 — measured 1K / 10K / 50K)

Measured by `scripts/battle/verify-scale.mjs` with the REAL embedder
(`Xenova/all-MiniLM-L6-v2`, 384-dim) through the REAL production `handleStore` /
`handleSearch` handlers on a file-backed SQLite DB. Each row is a distinct
synthetic engineering-doc sentence with per-row lexical salt, so every vector is
unique and the index actually reaches the target size (no dedup folding). The
50K run landed **49,931 vectors** in the `memories_vec` table. Hardware: Apple
Silicon laptop (CPU-only inference). Search latency is over 60 queries (no
rerank) / 10 queries (with rerank).

| Vectors | store rows/sec | search p50 / p95 / max (ms, **no rerank**) | search p50 / p95 (ms, **+rerank**) | sub-second @ p95? |
|---|---|---|---|---|
| 1,000 | 96 | 0.9 / 3.7 / 8.5 | 202 / 297 | ✅ |
| 10,000 | 61 | 4.4 / 9.1 / 26.1 | 199 / 258 | ✅ |
| 50,000 | 26 | 20.1 / 30.2 / 37.4 | 207 / 223 | ✅ |

**The sqlite-vec KNN + RRF hot path stays sub-second well past the 10K goal:**
p95 is **9.1 ms at 10K** and still only **30.2 ms at 50K** — a ~100–1000× margin
under the 1-second target. The cross-encoder reranker adds a roughly **constant**
~200 ms (it scores a fixed top-50 candidate set, so it does not grow with the
corpus) and stays comfortably sub-second at every size.

**Where it degrades — two O(n) hotspots, both inherent to sqlite-vec's
brute-force KNN (no ANN/HNSW index):**

1. **Search** scales ~linearly with corpus size (p50 0.9 → 4.4 → 20.1 ms across
   1K/10K/50K) because each query's `embedding MATCH ? AND k = ?` is a full
   linear scan of the vec index. In C this is fast — 50K × 384-dim is ~30 ms —
   so it is nowhere near the sub-second budget, but it is genuinely O(n) and
   would cross 1 s somewhere in the low-millions of rows.
2. **Store throughput** drops from 96 → 26 rows/sec (1K → 50K) because every
   store runs **two** brute-force KNN scans on the growing index — the
   `detectConflicts` dedup scan (`k=10`) and `buildSimilarityEdges`'
   `findNearDuplicates` scan (`k=7`) — plus the embed. Both scans are O(n), so
   per-store cost rises with the live row count. This is a write-path cost, not
   the retrieval hot path GAP 3 targets; it is acceptable for a personal/team
   memory store (tens of thousands of rows) but would dominate a bulk import of
   hundreds of thousands of rows. The fix is architectural (an ANN index such as
   HNSW, or skipping the similarity-edge weave during bulk ingest) rather than a
   small local patch, so it is documented here rather than changed.

> Regenerate on the target hardware with `node scripts/battle/verify-scale.mjs`
> (knobs: `SCALE_SIZES`, `SCALE_DB`, `SCALE_SEARCH_ITERS`, `SCALE_TIME_BUDGET_MS`).
> A companion run that lets the store path's dedup/supersede logic fold
> near-identical synthetic rows collapsed 50K store *calls* into a ~16.4K-vector
> index and showed the same sub-second profile (p95 11.9 ms no-rerank) — i.e. the
> conflict resolver also caps index growth under repetitive writes.

## Framing vs. competitors

Every memory-layer competitor (mem0 / Zep / Letta / Cognee / Supermemory) and
every native memory (ChatGPT / Claude) leads with self-reported, cloud-hosted
benchmark numbers and bills per token. This harness is the opposite by
construction:

- **Local** — the model, the index, and the data never leave the machine.
- **$0 per token** — no API, no metering; cost is CPU time you already own.
- **Reproducible** — committed corpus + committed runner; clone and re-run.
- **Honest** — the gold set and the misses are printed, not hidden.

Even mid-pack accuracy wins the framing: comparable retrieval quality at **0%
cloud exposure and $0/token**. The reranker lift above is the kind of
measured, not asserted, gain the rest of the roadmap is held to.

## LongMemEval-S (public benchmark)

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) (Wu et al., ICLR 2025,
MIT) measures long-term conversational memory: 500 questions, each over a
~115k-token haystack of 38–62 chat sessions. We run the **retrieval** stage —
the part a memory server owns — against this server's REAL production handlers
(`handleStore` → `handleSearch`, hybrid RRF, optional local cross-encoder
rerank) with the stock embedder (`Xenova/all-MiniLM-L6-v2`, 384-dim). One doc
per session (user turns only), per-question isolated corpus, query = the raw
question string. **Zero LongMemEval-specific tuning** — production defaults.

```bash
npm run bench:longmemeval                       # full S (downloads ~277 MB once)
npm run bench:longmemeval -- --dataset oracle --limit 50   # quick smoke
```

Two aggregations from the same run (2026-06-10, Apple Silicon, ~5s/question
for both modes; full report JSON printed by the runner):

**MemPalace-comparable** — methodology copied from
[MemPalace's published benchmark](https://github.com/MemPalace/mempalace)
(all 500 questions incl. the 30 abstention items, session-level
**recall_any@k**: ≥1 evidence session in the top-k):

| System | R@1 | R@3 | R@5 | R@10 |
|---|---|---|---|---|
| MemPalace "raw" (their headline, same MiniLM embedder) | — | — | 96.6% | — |
| MemPalace "hybrid v4" (450-q held-out; benchmark-specific boosts) | — | — | 98.4% | 99.8% |
| **mcp-memory hybrid (no rerank)** | 60.0% | 92.0% | 95.2% | 98.8% |
| **mcp-memory hybrid + local rerank** | **92.2%** | **97.4%** | **97.8%** | **98.8%** |

Per-type recall_any@5 (rerank on): knowledge-update 100%, multi-session 100%,
single-session-user 98.6%, single-session-assistant 98.2%,
temporal-reasoning 97.0%, single-session-preference 83.3%.

**Official-style** — the official `eval_utils.py` aggregation (skips
abstention + assistant-only-evidence questions → 419 questions; headline =
**recall_all@k**, every evidence session retrieved, + binary NDCG):

| Mode | recall_all@5 | NDCG@5 | recall_all@10 | NDCG@10 |
|---|---|---|---|---|
| hybrid (no rerank) | 83.8% | 0.772 | 94.3% | 0.798 |
| hybrid + local rerank | **92.8%** | **0.930** | **97.1%** | **0.939** |

Honest notes:

- The two aggregations are NOT interchangeable: recall_any@5 over 500 is the
  number comparable to MemPalace's 96.6%; recall_all@5 over 419 is the number
  comparable to the LongMemEval paper's baselines. The runner prints both.
- MemPalace's 98.4% "hybrid v4" adds keyword/temporal/preference-regex boosts
  developed against this benchmark family (their own docs flag the tuning
  risk and use a held-out split). Our pipeline has no benchmark-specific
  logic; 97.8% is the same production path every MCP request takes.
- 14 of ~23,850 session stores (0.06%) were dropped by the production
  exact-duplicate gate (`ingest_integrity.non_add_operations`) — this can only
  *lower* our score, never inflate it.
- Retrieval recall is not end-to-end QA accuracy; no LLM reader is involved.

## LOCOMO (public benchmark)

[LOCOMO](https://github.com/snap-research/locomo) (Maharana et al., ACL 2024)
measures very-long-term conversational memory: 10 conversations of up to ~35
sessions / ~26k tokens each, ~2,000 questions across 5 categories
(multi-hop, temporal, open-domain, single-hop, adversarial). Same setup as
LongMemEval above: REAL production handlers, stock MiniLM embedder, **zero
LOCOMO-specific tuning**.

```bash
npm run bench:locomo                 # full 10 conversations (downloads once)
npm run bench:locomo -- --limit 2    # quick smoke
```

The runner reports recall at **session** granularity (≥ coverage of the
evidence sessions — the level MemPalace publishes) AND the harder **turn**
granularity from the same run. Full run 2026-06-11, Apple Silicon, ~131 min,
hybrid + local rerank (the production MCP default):

| Granularity | R@1 | R@5 | R@10 | R@50 |
|---|---|---|---|---|
| session | 52.3% | 73.3% | **82.2%** | **100%** |
| turn | 39.4% | 57.0% | 61.0% | 68.1% |

Per-category session R@10: temporal 85.5%, single-hop 84.4%, adversarial
86.1%, multi-hop 72.3%, open-domain 62.4%.

Honest notes:

- MemPalace publishes session R@10 = 60.3% for their baseline and **88.9%**
  for their "hybrid v5" — which adds keyword/temporal-regex boosts developed
  against this benchmark family. Our untuned production path lands at 82.2%:
  22 points above their baseline, 6.7 below their benchmark-tuned pipeline.
- R@50 = 100%: every evidence session is always in the top-50 — the misses at
  k=10 are ranking, not recall, failures.
- **Reranker A/B (2026-06-11):** because R@50 = 100%, the lever is the final
  reranker, not retrieval. We replayed the LOCOMO candidate set through three
  latency-viable local cross-encoders. The shipping model wins:

  | Reranker (local, $0/token) | session R@10 | ~latency / 50 docs |
  |---|---|---|
  | **ms-marco-MiniLM-L-6-v2 (shipping)** | **82.2%** | ~0.5 s |
  | ms-marco-MiniLM-L-12-v2 | 81.0% | ~1.0 s |
  | jina-reranker-v1-turbo-en | 80.2% | ~0.6 s |

  Heavier rerankers (bge-reranker-base, mxbai-rerank-\*) were excluded up front
  on latency (2–4 s per query — a 4–8× regression for no recall gain). No
  swap improves the untuned number, so **82.2% is the ceiling of this
  production path**; the gap to MemPalace's 88.9% is their benchmark-specific
  tuning, which we don't do.
- Retrieval recall is not end-to-end QA accuracy; no LLM reader is involved.

## ConvoMem (public benchmark)

[ConvoMem](https://huggingface.co/datasets/Salesforce/ConvoMem) (Pakhomov et al.,
Salesforce, arXiv 2511.10523) is a 75k-question conversational-memory benchmark.
We run the **retrieval** slice MemPalace publishes against — the `1_evidence`
single-message-evidence files, 5 categories × 50 items, one document per message
of each item's own conversations, scored hit@10 by bidirectional substring match
(exactly mirroring MemPalace's `convomem_bench.py`). Same setup as above: REAL
production handlers, stock MiniLM embedder, **zero tuning**.

```bash
npm run bench:convomem                 # 50 items × 5 categories
npm run bench:convomem -- --limit 3    # quick smoke
```

| Mode | overall recall | user | assistant-facts | abstention | preference | implicit-connection |
|---|---|---|---|---|---|---|
| **hybrid (no rerank)** | **93.5%** | 98% | 100% | 98% | 86% | 86% |
| hybrid + local rerank | 86.2% | 98% | 100% | 91% | 76% | 66% |

Honest notes:

- **93.5% (hybrid) beats MemPalace's published 92.9%** on the same slice + same
  embedder, untuned. The no-rerank number is the apples-to-apples comparator
  (MemPalace runs raw ChromaDB vector search, no reranker).
- The cross-encoder reranker **hurts** here (−7.3 pts): these are very short
  single-message corpora scored by exact-substring presence, where the
  reranker's semantic-relevance reordering can demote the literal evidence
  message. It's a real, honest property of this easy-slice benchmark — the
  reranker's win shows on the harder LongMemEval / LOCOMO sets above.
- This is the `1_evidence` parity slice MemPalace reports, not the full 75k-item
  benchmark; `changing_evidence` has no `1_evidence` split upstream and is
  skipped (as MemPalace does).

## MemBench (public benchmark)

[MemBench](https://github.com/import-myself/Membench) (Tan et al., Findings of
ACL 2025) is an agent-memory benchmark. We run MemPalace's parity slice — the
FirstAgent `movie`/`roles`/`events` topics (8,500 items), one document per turn,
scored hit@5 with their generous dual id-matching — through the **untuned
production** search path.

```bash
npm run bench:membench                 # full 8,500-item slice
npm run bench:membench -- --limit 3    # quick smoke
```

| Mode | overall hit@5 | strong categories | designed-hard categories |
|---|---|---|---|
| **hybrid (no rerank), untuned** | **78.7%** | simple 97% · comparative 99% · aggregative 99% · lowlevel-rec 100% | noisy 38% · conditional 50% · post-processing 50% |

Honest notes:

- MemPalace publishes **80.3%**, which is their **tuned** `hybrid` mode
  (over-retrieve 3× + keyword predicate-overlap rescoring developed against this
  benchmark). Our 78.7% is the **untuned** production path — within 1.6 pts of
  their tuned number with no benchmark-specific logic.
- Our production store **deduplicated 8,115 of the turn writes** (near-identical
  turns within an item fold to one row). Unlike MemPalace's ChromaDB (which
  indexes every turn), a folded target turn becomes unretrievable — so 78.7% is a
  **conservative floor**; an un-deduplicated index scores higher.
- The per-category profile matches MemPalace's published shape (their hardest
  cases — noisy, conditional, post-processing — are ours too), a sanity check
  that the harness measures the same thing.

## Roadmap (BATTLE-PLAN §6.D)

This R0 harness is the foundation. Planned additions, each gated on measured
numbers committed here:

- ~~LongMemEval-S runner~~ Done — see above (`scripts/bench/longmemeval.mjs`).
- ~~LOCOMO runner~~ Done — see above (`scripts/bench/locomo.mjs`).
- ~~ConvoMem runner~~ Done — see above (`scripts/bench/convomem.mjs`).
- ~~MemBench runner~~ Done — see above (`scripts/bench/membench.mjs`). **4/4
  public-benchmark parity with MemPalace.**
- Bigger held-out gold set; before/after numbers for each retrieval change.
- ~~Latency dashboard at 1K / 10K / 100K vectors.~~ Done at 1K / 10K / 50K —
  see "Latency at scale" above (`scripts/battle/verify-scale.mjs`). 100K is
  bounded by the documented O(n) write-path cost, not the sub-second retrieval
  goal.

## Benchmark integrity

Aggregate claims are only as good as their auditability:

- **Committed per-question artifacts.** Every public-benchmark runner accepts
  `--out <path>` and writes the full report PLUS per-question rows.
  Committed artifacts live in [`benchmarks/results/`](../benchmarks/results/)
  (currently the full LOCOMO run — session R@10 = 0.822 rerank-on / 0.742
  rerank-off, R@50 = 1.0 — reproducing the published headline; the other three
  suites regenerate with `npm run bench:<name> -- --out …`).
- **Zero benchmark-specific tuning.** All numbers come from the production
  `handleStore`/`handleSearch` handlers with the stock MiniLM embedder —
  the same code path every user runs. There is no bench-only flag anywhere in
  the pipeline: the query sanitizer's verbatim gate (512 code points) sits
  ABOVE the longest genuine benchmark question (466 cp, MemBench), so the
  published numbers hold by construction, not by special-casing.
- **Hermetic gates.** The bench/battle harnesses pin the config loader to a
  no-config baseline so a developer machine's personal `~/.mcp-memory/config.json`
  (whose `defaults` now affect store scope/namespace and the embedding
  context prefix) cannot move the numbers.
- **Honest deltas.** Where a competitor's tuned number beats ours untuned, the
  tables above say so (MemBench 78.7 untuned vs 80.3 tuned; LongMemEval-S
  97.8 vs their held-out tuned 98.4).
