// LongMemEval retrieval benchmark (Wu et al., ICLR 2025) run against THIS
// server's REAL production write + search handlers — the same code path every
// MCP store/search request takes — with the real local embedder. 100% local,
// $0/token, no network after the one-time dataset download.
//
// Two aggregations are reported from the SAME per-question rankings:
//
//   • `mempalace_comparable` — copies github.com/MemPalace/mempalace's
//     published methodology exactly so the numbers are apples-to-apples with
//     their headline "Recall@5": ALL 500 questions (abstention + assistant-
//     evidence included), session granularity over user-turns-only documents,
//     per-question isolated corpus, hit = ANY id from `answer_session_ids` in
//     the top-k distinct sessions (recall_any).
//
//   • `official_style` — follows the official LongMemEval retrieval eval
//     (src/retrieval/eval_utils.py + run_retrieval.py): skips the 30 `_abs`
//     abstention questions AND questions whose evidence never appears in a
//     user turn (`has_answer`), demotes evidence sessions whose evidence is
//     assistant-only, and reports the official headline recall_all@k +
//     binary NDCG@k.
//
// Run:    node scripts/bench/longmemeval.mjs               (full S, both modes)
//         node scripts/bench/longmemeval.mjs --dataset oracle --limit 50
//         node scripts/bench/longmemeval.mjs --rerank on
// Flags:  --dataset s|oracle   (default s; downloads to ~/.cache/mcp-memory-bench)
//         --limit N            (first N questions; default all)
//         --rerank off|on|both (default both)
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

import { evaluateRetrieval, aggregate } from './lme-metrics.mjs';
import { ensureDataset } from './download-longmemeval.mjs';

register('./scripts/bench/ts-loader.mjs', pathToFileURL('./'));

const { createTestDb } = await import('../../src/testing/test-db.ts');
const { TransformersEmbeddingProvider } = await import('../../src/embeddings/transformers.ts');
const { CachedEmbeddingProvider } = await import('../../src/embeddings/cache.ts');
const { handleStore } = await import('../../src/tools/store.ts');
const { handleSearch } = await import('../../src/tools/search.ts');

// ── CLI args ───────────────────────────────────────────────────────────────
function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DATASET = flag('dataset', 's');
const LIMIT = parseInt(flag('limit', '0'), 10) || 0;
const RERANK = flag('rerank', 'both'); // off | on | both
const KS = [1, 3, 5, 10, 50];
const FETCH_LIMIT = 50;
const NAMESPACE = 'longmemeval';

// ── Load dataset ───────────────────────────────────────────────────────────
const path = await ensureDataset(DATASET);
let questions = JSON.parse(readFileSync(path, 'utf8'));
if (LIMIT > 0) questions = questions.slice(0, LIMIT);
console.error(`LongMemEval-${DATASET}: ${questions.length} questions`);

// ── Shared embedder: the cache makes repeated haystack sessions embed once ──
const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();

/** User-turns-only session document, the granularity both the official eval
 * and mempalace index. Returns null for sessions with no user content. */
function sessionDoc(session) {
  const text = session
    .filter((t) => t.role === 'user' && typeof t.content === 'string')
    .map((t) => t.content)
    .join('\n');
  return text.trim().length > 0 ? text : null;
}

/** Official-eval label demotion: an evidence session only counts as a correct
 * doc when at least one USER turn in it carries `has_answer: true`. */
function userTurnEvidenceIds(q) {
  const ids = new Set();
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const sid = q.haystack_session_ids[i];
    if (!q.answer_session_ids.includes(sid)) continue;
    const hasUserEvidence = q.haystack_sessions[i].some(
      (t) => t.role === 'user' && t.has_answer === true,
    );
    if (hasUserEvidence) ids.add(sid);
  }
  return ids;
}

// ── Per-question: isolated corpus → production store → production search ───
const perQuestion = [];
let nonAddOps = 0;
const tStart = performance.now();

for (let qi = 0; qi < questions.length; qi++) {
  const q = questions[qi];
  const db = createTestDb();

  const idToSession = new Map();
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const doc = sessionDoc(q.haystack_sessions[i]);
    if (doc === null) continue; // no user turns — not indexable (both methodologies)
    const res = await handleStore(db, embedder, {
      content: doc,
      title: q.haystack_session_ids[i],
      document_type: 'note',
      scope: 'project',
      namespace: NAMESPACE,
    });
    if (res.operation !== 'ADD') {
      nonAddOps++;
      continue; // corpus-integrity counter; reported below
    }
    idToSession.set(res.memory.id, q.haystack_session_ids[i]);
  }

  const rankingsByMode = {};
  for (const mode of RERANK === 'both' ? ['off', 'on'] : [RERANK]) {
    const res = await handleSearch(db, embedder, {
      query: q.question,
      limit: FETCH_LIMIT,
      detail_level: 'summary',
      scope: 'project',
      namespace: NAMESPACE,
      rerank: mode === 'on',
    });
    const ranked = [];
    for (const hit of res.results) {
      const sid = idToSession.get(hit.id);
      if (sid && !ranked.includes(sid)) ranked.push(sid);
    }
    rankingsByMode[mode] = ranked;
  }

  db.close();
  perQuestion.push({
    question_id: q.question_id,
    question_type: q.question_type,
    abstention: q.question_id.endsWith('_abs'),
    answer_ids: new Set(q.answer_session_ids),
    official_ids: userTurnEvidenceIds(q),
    rankings: rankingsByMode,
  });

  if ((qi + 1) % 25 === 0 || qi === questions.length - 1) {
    const rate = ((performance.now() - tStart) / 1000 / (qi + 1)).toFixed(2);
    console.error(`  ${qi + 1}/${questions.length} (${rate}s/question)`);
  }
}

// ── Aggregations ───────────────────────────────────────────────────────────
const round = (x) => +x.toFixed(3);

function metricsAt(rows, mode, correctKey, k) {
  const per = rows.map((r) => evaluateRetrieval(r.rankings[mode], r[correctKey], k));
  const a = aggregate(per);
  return { recall_any: round(a.recall_any), recall_all: round(a.recall_all), ndcg: round(a.ndcg) };
}

function block(rows, mode, correctKey) {
  const out = {};
  for (const k of KS) out[`@${k}`] = metricsAt(rows, mode, correctKey, k);
  return out;
}

function perType(rows, mode, correctKey, k) {
  const types = [...new Set(rows.map((r) => r.question_type))].sort();
  const out = {};
  for (const t of types) {
    const subset = rows.filter((r) => r.question_type === t);
    out[t] = { questions: subset.length, ...metricsAt(subset, mode, correctKey, k) };
  }
  return out;
}

const modes = RERANK === 'both' ? ['off', 'on'] : [RERANK];

// mempalace-comparable population: every question, answer_session_ids verbatim.
const mp = {};
// official population: no abstention, and ≥1 user-turn evidence session.
const officialRows = perQuestion.filter((r) => !r.abstention && r.official_ids.size > 0);
const off = {};
for (const mode of modes) {
  mp[`rerank_${mode}`] = {
    ...block(perQuestion, mode, 'answer_ids'),
    per_type_at_5: perType(perQuestion, mode, 'answer_ids', 5),
  };
  off[`rerank_${mode}`] = block(officialRows, mode, 'official_ids');
}

const report = {
  benchmark: `LongMemEval-${DATASET} retrieval (session-level, user-turns-only, per-question isolated corpus)`,
  dataset: { variant: DATASET, questions: perQuestion.length, source: 'xiaowu0162/longmemeval-cleaned (MIT)' },
  engine: {
    store: 'handleStore (production write path)',
    search: 'handleSearch (production hybrid RRF; rerank = cross-encoder when on)',
    embedder: embedder.modelName,
    dimensions: embedder.dimensions,
    local: true,
    cost_per_token_usd: 0,
  },
  ingest_integrity: { non_add_operations: nonAddOps },
  mempalace_comparable: {
    note: 'all questions, recall_any, answer_session_ids verbatim — comparable to MemPalace published Recall@5',
    ...mp,
  },
  official_style: {
    note: 'skips _abs + assistant-only-evidence questions; official headline = recall_all + binary NDCG',
    questions: officialRows.length,
    ...off,
  },
  runtime_s: round((performance.now() - tStart) / 1000),
};

console.log(JSON.stringify(report, null, 2));

// --out <path>: also write the report + per-question rows as a committable
// artifact (benchmark-integrity: aggregate claims stay independently checkable).
const outIdx = process.argv.indexOf('--out');
if (outIdx !== -1 && process.argv[outIdx + 1]) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const p = process.argv[outIdx + 1];
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // perQuestion/officialRows carry answer_ids/official_ids as Sets, which
  // JSON.stringify silently turns into {} — wiping the gold labels an auditor
  // needs to re-derive recall from the rankings (fix-breaker S18). Serialize
  // Sets as arrays so the artifact is actually independently checkable.
  const setReplacer = (_k, v) => (v instanceof Set ? [...v] : v);
  fs.writeFileSync(
    p,
    JSON.stringify({ ...report, per_question: perQuestion, official_rows: officialRows }, setReplacer, 2),
  );
  console.error(`Per-question artifact → ${p}`);
}
