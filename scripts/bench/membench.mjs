// MemBench retrieval benchmark (Tan et al., ACL 2025 Findings;
// github.com/import-myself/Membench, MemData/FirstAgent) run against THIS
// server's REAL production write + search handlers with the real local
// embedder. 100% local, $0/token, no network after the one-time ~506 MB
// download.
//
// Protocol mirrors github.com/MemPalace/mempalace benchmarks/membench_bench.py
// in its RAW mode (the parity ground truth): per item — fresh DB, one doc per
// turn `[time] [User] u [Assistant] a`, query with the bare question, hit when
// ANY target turn id appears in the top-K under the generous dual matching
// (stored sid/mid OR global positional index — FirstAgent mids are strings, so
// the global index is what actually fires). We are the UNTUNED production
// path; mempalace's published 80.3% is their TUNED hybrid mode.
//
// Run:    node scripts/bench/membench.mjs                  (full 8500-item slice)
//         node scripts/bench/membench.mjs --limit 3 --rerank off    (smoke)
// Flags:  --limit N            (items per category, default 0 = all)
//         --rerank off|on|both (default both)
//         --k N                (top-k scored, default 5)
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

import { turnText, flattenTurns, targetIds, isHit, fractionRecall } from "./membench-metrics.mjs";
import { ensureMembenchFile, FILES } from "./download-membench.mjs";

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
const LIMIT = parseInt(flag("limit", "0"), 10) || 0;
const RERANK = flag("rerank", "both");
const K = parseInt(flag("k", "5"), 10) || 5;
// Fixed candidate fetch like locomo.mjs (rerank pool = top 50 fused), scored
// lists sliced to K — avoids coupling the engine's limit*3 oversample to K.
const FETCH_LIMIT = Math.max(50, K);
const NAMESPACE = "membench";

const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();

const modes = RERANK === "both" ? ["off", "on"] : [RERANK];
const rows = {}; // rows[mode] = [{category, hit, frac}]
for (const m of modes) rows[m] = [];
const primaryMode = modes.includes("on") ? "on" : modes[0];

let totalItems = 0; // all loaded items (python overall denominator)
const loadedPerCategory = {};
let nonAddOps = 0;
let itemsNotIndexed = 0;
let done = 0;
const tStart = performance.now();

// One category file at a time: a single FirstAgent file is up to ~70 MB of
// JSON, and holding all ten parsed at once would cost gigabytes.
for (const file of FILES) {
  const path = await ensureMembenchFile(file.category);
  const raw = JSON.parse(readFileSync(path, "utf8"));

  // mempalace key filter (--topic movie): movie for topic-keyed files,
  // roles+events for role-keyed ones — insertion order preserved like python.
  let items = [];
  for (const [key, topicItems] of Object.entries(raw)) {
    if (!file.topics.includes(key)) continue;
    for (const item of topicItems) {
      const turns = item.message_list ?? [];
      const qa = item.QA ?? {};
      if (!Array.isArray(turns) || turns.length === 0) continue;
      if (typeof qa !== "object" || qa === null || Object.keys(qa).length === 0) continue;
      items.push({
        category: file.category,
        topic: key,
        question: qa.question ?? "",
        targets: targetIds(qa.target_step_id),
      });
      // keep the raw turns by reference; flattened lazily below
      items[items.length - 1].turns = turns;
    }
  }
  if (LIMIT > 0) items = items.slice(0, LIMIT);
  totalItems += items.length;
  loadedPerCategory[file.category] = items.length;
  console.error(`MemBench ${file.category}: ${items.length} items (k=${K})`);

  for (const item of items) {
    const db = createTestDb();
    const idToMeta = new Map();
    for (const row of flattenTurns(item.turns)) {
      const res = await handleStore(db, embedder, {
        content: turnText(row.turn),
        title: `turn_${row.globalIdx}`,
        document_type: "note",
        scope: "project",
        namespace: NAMESPACE,
      });
      if (res.operation === "ADD") idToMeta.set(res.memory.id, row);
      else nonAddOps++;
    }
    if (idToMeta.size === 0) {
      // python parity: skipped at indexing — still in the overall denominator,
      // absent from the per-category processed counts.
      itemsNotIndexed++;
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
      const metas = [];
      for (const hit of res.results) {
        const m = idToMeta.get(hit.id);
        if (m !== undefined) metas.push(m);
        if (metas.length >= K) break;
      }
      const sids = metas.map((m) => m.sid);
      const globals = metas.map((m) => m.globalIdx);
      rows[mode].push({
        category: item.category,
        hit: isHit(item.targets, sids, globals) ? 1 : 0,
        frac: fractionRecall(item.targets, sids, globals),
      });
    }
    db.close();
    done++;
    if (done % 25 === 0) {
      const recs = rows[primaryMode];
      const hitRate = recs.reduce((a, r) => a + r.hit, 0) / recs.length;
      const rate = ((performance.now() - tStart) / 1000 / done).toFixed(2);
      console.error(`  ${done} items, running R@${K}=${(hitRate * 100).toFixed(1)}% (${rate}s/item)`);
    }
  }
}

const round = (x) => +x.toFixed(3);

function summarize(records, denominator) {
  const processed = records.length;
  const hits = records.reduce((a, r) => a + r.hit, 0);
  const frac = processed === 0 ? 0 : records.reduce((a, r) => a + r.frac, 0) / processed;
  return {
    items: denominator,
    processed,
    hit_at_k: round(denominator === 0 ? 0 : hits / denominator),
    fraction_recall: round(frac),
  };
}

function block(mode) {
  const recs = rows[mode];
  const perCategory = {};
  for (const file of FILES) {
    perCategory[file.category] = summarize(
      recs.filter((r) => r.category === file.category),
      loadedPerCategory[file.category] ?? 0,
    );
  }
  return { overall: summarize(recs, totalItems), per_category: perCategory };
}

const report = {
  benchmark: `MemBench FirstAgent retrieval (hit@${K} = any target turn in top-${K}; RAW untuned production path)`,
  dataset: {
    files: FILES.length,
    items: totalItems,
    items_per_category: loadedPerCategory,
    slice: "topics movie + roles + events (mempalace --topic movie parity)",
    source: "github.com/import-myself/Membench MemData/FirstAgent (ACL 2025 Findings)",
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
    "mempalace membench_bench.py parity slice: topic-keyed files keep only the movie topic (food/book " +
    "excluded), role-keyed files keep roles+events; RecMultiSession.json excluded — mempalace's topic filter " +
    "matches none of its keys, zeroing it. hit@k uses mempalace's generous dual matching: a retrieved turn " +
    "matches a target_step_id[i][0] by its stored sid/mid OR its global positional index (FirstAgent mids " +
    "are strings, so the global index is what fires). mempalace's published 80.3% is their TUNED hybrid mode " +
    "(keyword rescoring); their RAW mode is the apples-to-apples comparator — ours is the untuned production " +
    "search path. fraction_recall@k (|retrieved∩targets|/|targets|) is the stricter official-style secondary " +
    "number.",
  results: Object.fromEntries(modes.map((m) => [`rerank_${m}`, block(m)])),
  ingest_integrity: { non_add_operations: nonAddOps, items_not_indexed: itemsNotIndexed },
  runtime_s: round((performance.now() - tStart) / 1000),
};

console.log(JSON.stringify(report, null, 2));
