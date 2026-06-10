// LOCOMO retrieval benchmark (Maharana et al., ACL 2024) run against THIS
// server's REAL production write + search handlers with the real local
// embedder. 100% local, $0/token, no network after the one-time download.
//
// Reports recall@k at session AND turn granularity from the same run, so the
// number that's comparable to MemPalace's published 88.9% (session-level R@10,
// all categories) sits next to the harder turn-level number it doesn't lead with.
//
//   recall = per-question fraction of evidence covered, averaged over questions
//            (empty-evidence questions = 1.0, matching locomo_bench.py)
//
// Run:    node scripts/bench/locomo.mjs                 (all 10 conversations)
//         node scripts/bench/locomo.mjs --limit 2       (first 2, smoke)
//         node scripts/bench/locomo.mjs --rerank on
// Flags:  --limit N (first N conversations), --rerank off|on|both (default both)
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

import { evidenceToSessionIds, recallCoverage, aggregateRecall } from "./locomo-metrics.mjs";
import { ensureLocomo } from "./download-locomo.mjs";

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
const KS = [1, 5, 10, 50];
const FETCH_LIMIT = 50; // search limit cap is 100; 50 covers the max k
const NAMESPACE = "locomo";

const path = await ensureLocomo();
let conversations = JSON.parse(readFileSync(path, "utf8"));
if (LIMIT > 0) conversations = conversations.slice(0, LIMIT);
const totalQa = conversations.reduce((n, c) => n + (c.qa?.length ?? 0), 0);
console.error(`LOCOMO: ${conversations.length} conversations, ${totalQa} questions`);

const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();

const modes = RERANK === "both" ? ["off", "on"] : [RERANK];
// rows[mode][granularity] = array of per-question recall values
const rows = {};
for (const m of modes) rows[m] = { session: [], turn: [] };
const perTypeAt10 = {}; // perTypeAt10[category] = { session: [], turn: [] } for rerank-on (or single mode)
const primaryMode = modes.includes("on") ? "on" : modes[0];

let qDone = 0;
const tStart = performance.now();

for (let ci = 0; ci < conversations.length; ci++) {
  const conv = conversations[ci];
  const c = conv.conversation;
  const db = createTestDb();

  // Build two corpora from one ingest pass: one doc per SESSION (mempalace's
  // headline granularity) and one doc per TURN (the harder, turn-level number).
  const sessionDocIds = new Map(); // memory.id -> session_{n}
  const turnDocIds = new Map(); // memory.id -> dia_id
  let n = 1;
  while (c[`session_${n}`]) {
    const turns = c[`session_${n}`];
    const speakerLines = turns
      .filter((t) => typeof t.text === "string")
      .map((t) => `${t.speaker} said, "${t.text}"`);
    if (speakerLines.length > 0) {
      const sres = await handleStore(db, embedder, {
        content: speakerLines.join("\n"),
        title: `session_${n}`,
        document_type: "note",
        scope: "project",
        namespace: NAMESPACE,
        tags: ["session"],
      });
      if (sres.operation === "ADD") sessionDocIds.set(sres.memory.id, `session_${n}`);
    }
    for (const t of turns) {
      if (typeof t.text !== "string" || !t.dia_id) continue;
      const tres = await handleStore(db, embedder, {
        content: `${t.speaker} said, "${t.text}"`,
        title: t.dia_id,
        document_type: "note",
        scope: "project",
        namespace: NAMESPACE,
        tags: ["turn"],
      });
      if (tres.operation === "ADD") turnDocIds.set(tres.memory.id, t.dia_id);
    }
    n++;
  }

  for (const qa of conv.qa ?? []) {
    const evidence = Array.isArray(qa.evidence) ? qa.evidence : [];
    const sessionEvidence = evidenceToSessionIds(evidence);
    const turnEvidence = evidence;
    const category = qa.category ?? 0;

    for (const mode of modes) {
      // Session granularity: search only the session docs (tag filter).
      const sRes = await handleSearch(db, embedder, {
        query: qa.question,
        limit: FETCH_LIMIT,
        detail_level: "summary",
        scope: "project",
        namespace: NAMESPACE,
        tags: ["session"],
        rerank: mode === "on",
      });
      const sRanked = [];
      for (const hit of sRes.results) {
        const sid = sessionDocIds.get(hit.id);
        if (sid && !sRanked.includes(sid)) sRanked.push(sid);
      }
      // Turn granularity: search only the turn docs.
      const tRes = await handleSearch(db, embedder, {
        query: qa.question,
        limit: FETCH_LIMIT,
        detail_level: "summary",
        scope: "project",
        namespace: NAMESPACE,
        tags: ["turn"],
        rerank: mode === "on",
      });
      const tRanked = [];
      for (const hit of tRes.results) {
        const did = turnDocIds.get(hit.id);
        if (did && !tRanked.includes(did)) tRanked.push(did);
      }

      // We report at multiple k; store the ranked lists once and slice per k below.
      rows[mode].session.push({ ranked: sRanked, evidence: sessionEvidence, category });
      rows[mode].turn.push({ ranked: tRanked, evidence: turnEvidence, category });
    }
    qDone++;
    if (qDone % 100 === 0) {
      const rate = ((performance.now() - tStart) / 1000 / qDone).toFixed(2);
      console.error(`  ${qDone}/${totalQa} (${rate}s/question)`);
    }
  }
  db.close();
}

const round = (x) => +x.toFixed(3);

function recallAtK(records, k) {
  const per = records.map((r) => recallCoverage(r.evidence, new Set(r.ranked.slice(0, k))));
  return round(aggregateRecall(per).recall);
}

function block(mode) {
  const out = {};
  for (const gran of ["session", "turn"]) {
    out[gran] = {};
    for (const k of KS) out[gran][`@${k}`] = recallAtK(rows[mode][gran], k);
  }
  return out;
}

function perTypeBlock(mode, gran, k) {
  const recs = rows[mode][gran];
  const cats = [...new Set(recs.map((r) => r.category))].sort((a, b) => a - b);
  const out = {};
  for (const cat of cats) {
    const subset = recs.filter((r) => r.category === cat);
    out[`category_${cat}`] = { questions: subset.length, recall: recallAtK(subset, k) };
  }
  return out;
}

const report = {
  benchmark: "LOCOMO retrieval (recall = evidence-coverage fraction; session + turn granularity)",
  dataset: { conversations: conversations.length, questions: totalQa, source: "snap-research/locomo locomo10.json (ACL 2024)" },
  engine: {
    store: "handleStore (production write path)",
    search: "handleSearch (production hybrid RRF; rerank = cross-encoder when on)",
    embedder: embedder.modelName,
    dimensions: embedder.dimensions,
    local: true,
    cost_per_token_usd: 0,
  },
  note:
    "All categories scored incl. adversarial (cat 5), empty-evidence = 1.0 — matches MemPalace locomo_bench.py. " +
    "MemPalace's published headline is SESSION-level R@10 (88.9%) / R@5 (83.7%); their turn-level is far lower (~48%).",
  results: Object.fromEntries(modes.map((m) => [`rerank_${m}`, block(m)])),
  per_category_session_at_10: perTypeBlock(primaryMode, "session", 10),
  runtime_s: round((performance.now() - tStart) / 1000),
};

console.log(JSON.stringify(report, null, 2));
