// GAP 3 — Scale / latency verification with the REAL embedder.
//
// Stores synthetic-but-varied memories through the REAL production store
// handler (handleStore) — same path production uses, including the per-store
// vector KNN conflict scan + similarity-edge weave — and the REAL embedding
// model (Xenova/all-MiniLM-L6-v2), at increasing corpus sizes. Then measures:
//
//   • store throughput (rows/sec) at each size,
//   • search latency p50 / p95 / max WITHOUT rerank (the hot path), and
//   • a small sample WITH the cross-encoder reranker,
//
// to confirm the sqlite-vec KNN + RRF fusion stays sub-second at 10K rows.
//
// No mocks: the same TypeScript sources the MCP server runs are loaded directly
// via scripts/bench/ts-loader.mjs. File-backed DB by default (closer to a real
// deployment than :memory:).
//
// Run:    node scripts/battle/verify-scale.mjs
// Knobs:  SCALE_SIZES=1000,10000        comma list of corpus sizes to test
//         SCALE_DB=/tmp/scale.db        DB file (cleared first); :memory: also ok
//         SCALE_TIME_BUDGET_MS=300000   stop adding bigger sizes once exceeded
//         SCALE_SEARCH_ITERS=60         search queries timed per size (no rerank)
//         SCALE_RERANK_ITERS=10         search queries timed per size (with rerank)
//         SCALE_JSON=1                  emit machine-readable JSON only

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';

import { average, percentile } from '../bench/metrics.mjs';

register('./scripts/bench/ts-loader.mjs', pathToFileURL('./'));

const { createDatabase } = await import('../../src/db/connection.ts');
const { initializeSchema } = await import('../../src/db/schema.ts');
const { runMigrations } = await import('../../src/db/migrations.ts');
const { TransformersEmbeddingProvider } = await import('../../src/embeddings/transformers.ts');
const { CachedEmbeddingProvider } = await import('../../src/embeddings/cache.ts');
const { handleStore } = await import('../../src/tools/store.ts');
const { handleSearch } = await import('../../src/tools/search.ts');

const NAMESPACE = 'scale';
const SCALE_SIZES = (process.env.SCALE_SIZES ?? '1000,10000,50000')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0)
  .sort((a, b) => a - b);
const DB_PATH = process.env.SCALE_DB ?? '/tmp/mcp-scale-verify.db';
const TIME_BUDGET_MS = parseInt(process.env.SCALE_TIME_BUDGET_MS ?? '360000', 10);
const SEARCH_ITERS = parseInt(process.env.SCALE_SEARCH_ITERS ?? '60', 10);
const RERANK_ITERS = parseInt(process.env.SCALE_RERANK_ITERS ?? '10', 10);
const JSON_ONLY = process.env.SCALE_JSON === '1';

const log = (...args) => { if (!JSON_ONLY) console.error(...args); };

// ── Synthetic corpus generator ────────────────────────────────────────────
// Each memory is a plausible engineering-doc sentence built from varied tokens
// plus a unique numeric id, so every vector is distinct (no degenerate KNN
// where identical vectors collapse the index). Deterministic via a seeded LCG
// so runs are reproducible.
const SUBJECTS = [
  'The billing service', 'The auth gateway', 'The ingestion worker', 'The search API',
  'The notification pipeline', 'The reporting job', 'The webhook dispatcher', 'The cache layer',
  'The migration runner', 'The rate limiter', 'The scheduler', 'The export module',
  'The tenant router', 'The audit logger', 'The PDF renderer', 'The dunning processor',
];
const VERBS = [
  'was refactored to', 'now relies on', 'must always', 'should never', 'was migrated to',
  'currently batches', 'asynchronously processes', 'rejects', 'retries', 'validates',
  'encrypts', 'deduplicates', 'rate-limits', 'shards', 'streams',
];
const OBJECTS = [
  'invoice line items in integer cents', 'JWT bearer tokens with 15-minute expiry',
  'Stripe webhook events with idempotency keys', 'customer entitlement lookups via Redis',
  'PostgreSQL row-level security policies', 'dead-letter queues after three failures',
  'OpenTelemetry spans propagated through SQS', 'Argon2id password hashes',
  'envelope-encrypted PII using AWS KMS', 'blue-green ECS task sets',
  'expand-contract schema migrations', 'HMAC-SHA256 signed outbound payloads',
  'soft-deleted records with a deleted_at timestamp', 'token-bucket request quotas',
  'faceted OpenSearch invoice indexes', 'LaunchDarkly server-side feature flags',
];
const CLAUSES = [
  'because the mobile app and web SPA share one stateless path.',
  'to keep migrations and connection pooling manageable at scale.',
  'so a poison message never blocks the worker pool.',
  'because finance users need fuzzy matching across millions of rows.',
  'to prevent off-by-one-cent rounding errors at the presentation layer.',
  'since the receiver must verify the payload was not tampered with.',
  'so async work always links back to the originating API call.',
  'because legal requires us to retain billing history for seven years.',
];
const DOC_TYPES = ['decision', 'pattern', 'convention', 'error_fix'];

function makeLcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Pseudo-words give each row real lexical entropy. Without them, the ~30K-cell
// template space collapses under the store path's dedup/supersede logic (a
// vector-distance < 0.4 + keyword-overlap conflict scan), so 50K store calls
// fold into ~16K distinct vectors. Salting with unique invented identifiers per
// row keeps every vector distinct and survives dedup, so the index actually
// reaches the target size — the honest way to load the KNN at scale.
const SALT_CONSONANTS = 'bcdfghjklmnpqrstvwxz';
const SALT_VOWELS = 'aeiou';
function saltWord(rnd) {
  let w = '';
  const len = 4 + Math.floor(rnd() * 4);
  for (let i = 0; i < len; i++) {
    w += (i % 2 === 0 ? SALT_CONSONANTS : SALT_VOWELS)[
      Math.floor(rnd() * (i % 2 === 0 ? SALT_CONSONANTS.length : SALT_VOWELS.length))
    ];
  }
  return w;
}

function syntheticContent(i, rnd) {
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const salt = `${saltWord(rnd)} ${saltWord(rnd)} ${saltWord(rnd)}`;
  return `${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)} ${pick(CLAUSES)} ` +
    `Internal codename ${salt} tracks record #${i} on build ${1000 + i} in region ${pick(['eu-west-1', 'us-east-1', 'ap-south-1'])}.`;
}

// A handful of natural-language queries to time search with. They look like the
// synthetic corpus so the KNN does real work (non-empty candidate sets).
const QUERIES = [
  'how do we authenticate API requests with tokens',
  'how are stripe webhook events deduplicated',
  'how is customer data isolated between tenants',
  'how do we make entitlement checks fast',
  'how do we run schema migrations without downtime',
  'how are passwords hashed securely',
  'how do we retry failed background jobs',
  'how is sensitive PII protected at rest',
  'how do we deploy to production safely',
  'how do we sign outbound webhooks',
];

function freshDb() {
  if (DB_PATH === ':memory:') {
    const db = createDatabase(':memory:');
    initializeSchema(db);
    db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
    runMigrations(db);
    return db;
  }
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { rmSync(f); } catch { /* nothing to remove */ }
  }
  const db = createDatabase(DB_PATH);
  initializeSchema(db);
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
  return db;
}

const round = (x, d = 1) => +x.toFixed(d);

// Time a batch of searches, returning {p50, p95, max, avg} in ms.
// handleSearch loads the cross-encoder reranker internally (a singleton) when
// `rerank: true` — it takes no reranker argument, so we just flip the flag.
async function timeSearches(db, embedder, rerank, iters) {
  const lat = [];
  for (let i = 0; i < iters; i++) {
    const q = QUERIES[i % QUERIES.length];
    const t = performance.now();
    await handleSearch(db, embedder, {
      query: q,
      limit: 10,
      detail_level: 'summary',
      scope: 'project',
      namespace: NAMESPACE,
      rerank,
    });
    lat.push(performance.now() - t);
  }
  return {
    samples: lat.length,
    p50_ms: round(percentile(lat, 50)),
    p95_ms: round(percentile(lat, 95)),
    max_ms: round(Math.max(...lat)),
    avg_ms: round(average(lat)),
  };
}

// ── Main ────────────────────────────────────────────────────────────────
const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();

// Honest reranker-availability probe: handleSearch is fail-soft (a missing
// model just logs a warn and falls back to fused order), so timing a rerank
// search alone can't tell us whether the cross-encoder actually ran. Load the
// model directly once — if it throws (download needed but offline) we report
// the WITH-rerank columns as n/a rather than silently timing the fallback.
const { CrossEncoderReranker } = await import('../../src/search/reranker.ts');
let rerankerAvailable = true;
try {
  const probe = new CrossEncoderReranker();
  await probe.rerank('warmup query', [{ id: 'x', text: 'warmup document about tokens' }]);
} catch (err) {
  rerankerAvailable = false;
  log('Reranker model unavailable — WITH-rerank samples will be n/a:', err?.message ?? err);
}

const db = freshDb();
const startedAt = performance.now();
const results = [];
let rowsStored = 0;
const sizesAttempted = [];
let stoppedEarlyReason = null;

for (const target of SCALE_SIZES) {
  const elapsed = performance.now() - startedAt;
  if (elapsed > TIME_BUDGET_MS && rowsStored > 0) {
    stoppedEarlyReason = `time budget ${TIME_BUDGET_MS}ms exceeded before size ${target} (elapsed ${round(elapsed)}ms)`;
    log(stoppedEarlyReason);
    break;
  }
  sizesAttempted.push(target);

  // Incrementally store up to `target` total rows (corpus is cumulative, so we
  // only embed the delta — the index grows monotonically across sizes).
  const toAdd = target - rowsStored;
  log(`\n── Storing ${toAdd} rows to reach ${target} total ──`);
  const storeStart = performance.now();
  let lastTick = storeStart;
  for (let n = 0; n < toAdd; n++) {
    const globalIndex = rowsStored + n;
    // Per-row deterministic RNG keyed on the global index, so the same corpus
    // is regenerated identically on a re-run and every row is distinct.
    const rnd = makeLcg((globalIndex * 2654435761) >>> 0);
    await handleStore(db, embedder, {
      content: syntheticContent(globalIndex, rnd),
      document_type: DOC_TYPES[globalIndex % DOC_TYPES.length],
      scope: 'project',
      namespace: NAMESPACE,
    });
    if (!JSON_ONLY && performance.now() - lastTick > 5000) {
      const done = n + 1;
      const rate = done / ((performance.now() - storeStart) / 1000);
      log(`  …${rowsStored + done}/${target} (${round(rate)} rows/sec)`);
      lastTick = performance.now();
    }
  }
  const storeElapsed = performance.now() - storeStart;
  rowsStored = target;
  const throughput = toAdd / (storeElapsed / 1000);

  log(`  stored ${toAdd} rows in ${round(storeElapsed / 1000, 1)}s → ${round(throughput)} rows/sec`);

  // Search latency at this corpus size.
  log(`  timing ${SEARCH_ITERS} searches (no rerank)…`);
  const noRerank = await timeSearches(db, embedder, false, SEARCH_ITERS);
  let withRerank = null;
  if (rerankerAvailable) {
    log(`  timing ${RERANK_ITERS} searches (with rerank)…`);
    withRerank = await timeSearches(db, embedder, true, RERANK_ITERS);
  }

  // Sanity: a representative query returns a non-empty result set at this size.
  const probe = await handleSearch(db, embedder, {
    query: QUERIES[0], limit: 10, detail_level: 'summary',
    scope: 'project', namespace: NAMESPACE, rerank: false,
  });

  results.push({
    corpus_size: target,
    rows_added: toAdd,
    store_throughput_rows_per_sec: round(throughput),
    store_elapsed_s: round(storeElapsed / 1000, 1),
    search_no_rerank: noRerank,
    search_with_rerank: withRerank,
    probe_results: probe.results.length,
    sub_second_p95_no_rerank: noRerank.p95_ms < 1000,
  });
}

// Verify actual row count landed in the DB.
const actualRows = db.prepare(
  "SELECT COUNT(*) AS c FROM memories WHERE namespace = ? AND superseded_at IS NULL AND valid_to IS NULL",
).get(NAMESPACE).c;
const vecRows = db.prepare('SELECT COUNT(*) AS c FROM memories_vec').get().c;

db.close();

const report = {
  benchmark: 'mcp-memory scale/latency (GAP 3)',
  local: true,
  db: DB_PATH === ':memory:' ? 'memory' : 'file',
  model: { embedder: embedder.modelName, dimensions: embedder.dimensions },
  reranker_available: rerankerAvailable,
  sizes_requested: SCALE_SIZES,
  sizes_completed: sizesAttempted,
  stopped_early: stoppedEarlyReason,
  largest_completed: results.length ? results[results.length - 1].corpus_size : 0,
  actual_live_rows: actualRows,
  vec_index_rows: vecRows,
  search_iters_no_rerank: SEARCH_ITERS,
  search_iters_with_rerank: RERANK_ITERS,
  per_size: results,
};

console.log(JSON.stringify(report, null, 2));

if (!JSON_ONLY) {
  log('\n── Latency table (ms) ──');
  log('size      store_rows/s   noRR_p50  noRR_p95  noRR_max   RR_p50  RR_p95');
  for (const r of results) {
    const rr = r.search_with_rerank;
    log(
      String(r.corpus_size).padEnd(9),
      String(r.store_throughput_rows_per_sec).padEnd(13),
      String(r.search_no_rerank.p50_ms).padEnd(9),
      String(r.search_no_rerank.p95_ms).padEnd(9),
      String(r.search_no_rerank.max_ms).padEnd(10),
      rr ? String(rr.p50_ms).padEnd(7) : 'n/a'.padEnd(7),
      rr ? String(rr.p95_ms) : 'n/a',
    );
  }
}
