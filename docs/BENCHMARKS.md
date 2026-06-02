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

## Roadmap (BATTLE-PLAN §6.D)

This R0 harness is the foundation. Planned additions, each gated on measured
numbers committed here:

- LOCOMO + LongMemEval-S runners (full multi-session benchmarks).
- Bigger held-out gold set; before/after numbers for each retrieval change.
- ~~Latency dashboard at 1K / 10K / 100K vectors.~~ Done at 1K / 10K / 50K —
  see "Latency at scale" above (`scripts/battle/verify-scale.mjs`). 100K is
  bounded by the documented O(n) write-path cost, not the sub-second retrieval
  goal.
