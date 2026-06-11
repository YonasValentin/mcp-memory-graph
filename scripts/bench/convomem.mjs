// ConvoMem retrieval benchmark (Salesforce/ConvoMem, HuggingFace) run against
// THIS server's REAL production write + search handlers with the real local
// embedder. 100% local, $0/token, no network after the one-time download.
//
// Protocol mirrors github.com/MemPalace/mempalace benchmarks/convomem_bench.py
// (the parity ground truth): per item — fresh DB, ONE memory per message of the
// item's own conversations (bare message text, exactly what mempalace indexes;
// speaker only as metadata there, so not embedded here either), query with the
// bare question, score the top-K against the item's evidence messages by
// bidirectional lowercased/stripped substring containment. Per-item recall =
// fraction of unique evidence texts found (the 1_evidence parity slice has one
// evidence per item, so this is hit@K); final = mean over items.
//
// Run:    node scripts/bench/convomem.mjs                  (50 items × 5 categories)
//         node scripts/bench/convomem.mjs --limit 3 --rerank off    (smoke)
// Flags:  --limit N            (items per category, default 50)
//         --rerank off|on|both (default both)
//         --k N                (top-k scored, default 10)
import { register } from "node:module";
import { pathToFileURL } from "node:url";

import { itemScore } from "./convomem-metrics.mjs";
import { loadConvomemItems } from "./download-convomem.mjs";

register("./scripts/bench/ts-loader.mjs", pathToFileURL("./"));

const { createTestDb } = await import("../../src/testing/test-db.ts");
const { TransformersEmbeddingProvider } = await import("../../src/embeddings/transformers.ts");
const { CachedEmbeddingProvider } = await import("../../src/embeddings/cache.ts");
const { handleStore } = await import("../../src/tools/store.ts");
const { handleSearch } = await import("../../src/tools/search.ts");

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const LIMIT = parseInt(flag("limit", "50"), 10) || 50;
const RERANK = flag("rerank", "both");
const K = parseInt(flag("k", "10"), 10) || 10;
// Fixed candidate fetch like locomo.mjs (rerank pool = top 50 fused), scored
// lists sliced to K — avoids coupling the engine's limit*3 oversample to K.
const FETCH_LIMIT = Math.max(50, K);
const NAMESPACE = "convomem";

const byCategory = await loadConvomemItems(LIMIT);
const totalItems = byCategory.reduce((n, c) => n + c.items.length, 0);
console.error(`ConvoMem: ${byCategory.length} categories, ${totalItems} items (k=${K})`);

const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();

const modes = RERANK === "both" ? ["off", "on"] : [RERANK];
const rows = {}; // rows[mode] = [{category, score}]
for (const m of modes) rows[m] = [];
const primaryMode = modes.includes("on") ? "on" : modes[0];

let nonAddOps = 0;
let skippedMessages = 0;
let emptyCorpusItems = 0;
let done = 0;
const tStart = performance.now();

for (const { category, items } of byCategory) {
  for (const item of items) {
    const db = createTestDb();
    // id → stored FULL content: search hit snippets may truncate, so evidence
    // matching always runs against the content we actually stored.
    const idToContent = new Map();
    let mi = 0;
    for (const conv of item.conversations ?? []) {
      for (const msg of conv.messages ?? []) {
        if (typeof msg.text !== "string" || msg.text.trim().length === 0) {
          skippedMessages++;
          continue;
        }
        const res = await handleStore(db, embedder, {
          content: msg.text,
          title: `msg_${mi}`,
          document_type: "note",
          scope: "project",
          namespace: NAMESPACE,
        });
        if (res.operation === "ADD") idToContent.set(res.memory.id, msg.text);
        else nonAddOps++;
        mi++;
      }
    }

    const evidences = (item.message_evidences ?? []).map((e) => e.text);
    if (idToContent.size === 0) {
      // python parity: empty corpus scores 0.0
      emptyCorpusItems++;
      for (const mode of modes) rows[mode].push({ category, score: 0 });
      db.close();
      done++;
      continue;
    }

    for (const mode of modes) {
      const res = await handleSearch(db, embedder, {
        query: item.question,
        limit: FETCH_LIMIT,
        detail_level: "summary",
        scope: "project",
        namespace: NAMESPACE,
        rerank: mode === "on",
      });
      const topK = [];
      for (const hit of res.results) {
        const content = idToContent.get(hit.id);
        if (content !== undefined) topK.push(content);
        if (topK.length >= K) break;
      }
      rows[mode].push({ category, score: itemScore(evidences, topK) });
    }
    db.close();
    done++;
    if (done % 10 === 0 || done === totalItems) {
      const scores = rows[primaryMode].map((r) => r.score);
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      const rate = ((performance.now() - tStart) / 1000 / done).toFixed(2);
      console.error(`  ${done}/${totalItems} avg_recall=${avg.toFixed(3)} (${rate}s/item)`);
    }
  }
}

const round = (x) => +x.toFixed(3);

function summarize(records) {
  const n = records.length;
  const recall = n === 0 ? 0 : records.reduce((a, r) => a + r.score, 0) / n;
  const perfect = records.filter((r) => r.score >= 1).length;
  return { items: n, recall: round(recall), perfect };
}

function block(mode) {
  const recs = rows[mode];
  const perCategory = {};
  for (const { category } of byCategory) {
    perCategory[category] = summarize(recs.filter((r) => r.category === category));
  }
  return { overall: summarize(recs), per_category: perCategory };
}

const report = {
  benchmark: `ConvoMem retrieval (1_evidence parity slice; per-item recall = fraction of evidence messages in top-${K})`,
  dataset: {
    categories: byCategory.length,
    items: totalItems,
    items_per_category: Object.fromEntries(byCategory.map((c) => [c.category, c.items.length])),
    source: "Salesforce/ConvoMem (HuggingFace) core_benchmark/evidence_questions/*/1_evidence",
  },
  engine: {
    store: "handleStore (production write path)",
    search: "handleSearch (production hybrid RRF; rerank = cross-encoder when on)",
    embedder: embedder.modelName,
    dimensions: embedder.dimensions,
    local: true,
    cost_per_token_usd: 0,
  },
  k: K,
  note:
    "mempalace convomem_bench.py parity: first N items per category from the alphabetically-first 1_evidence " +
    "files, one doc per message (bare message text), match = bidirectional lowercased/stripped substring " +
    "containment against stored full content. Every slice item carries exactly one evidence message, so " +
    "avg recall = hit@k. changing_evidence has NO 1_evidence split upstream — mempalace silently skips it " +
    "and so do we. Slice ≠ the full 75K-item benchmark.",
  results: Object.fromEntries(modes.map((m) => [`rerank_${m}`, block(m)])),
  ingest_integrity: {
    non_add_operations: nonAddOps,
    skipped_empty_messages: skippedMessages,
    empty_corpus_items: emptyCorpusItems,
  },
  runtime_s: round((performance.now() - tStart) / 1000),
};

console.log(JSON.stringify(report, null, 2));
