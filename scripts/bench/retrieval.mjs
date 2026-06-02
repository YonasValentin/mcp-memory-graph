// R0 — Reproducible local retrieval-quality benchmark (BATTLE-PLAN §3 R0, §6.D).
//
// Loads the REAL embedding model (TransformersEmbeddingProvider wrapped in
// CachedEmbeddingProvider) and the REAL production tool handlers — not the
// mock embedder, not a compiled copy — runs memory_search both WITH and
// WITHOUT the cross-encoder reranker over a fixed gold-set corpus, and reports
// precision@1, precision@3, MRR and store/search latency (avg + p95) as
// machine-readable JSON.
//
// No build step: a tiny esbuild-based loader (scripts/bench/ts-loader.mjs)
// runs the TypeScript sources directly. Everything is 100% local and
// $0/token — the framing the whole project is built on.
//
// Run:    npm run bench
// Scale:  BENCH_CORPUS_SCALE=40 npm run bench   (≈ 24*40 ≈ 1000 rows)
// File:   BENCH_DB=/tmp/bench.db npm run bench   (default is :memory:)

import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';

import { average, percentile, precisionAtK, mrr, summarizeRanks } from './metrics.mjs';

// Register the TypeScript loader before importing any .ts source.
register('./scripts/bench/ts-loader.mjs', pathToFileURL('./'));

const { createTestDb } = await import('../../src/testing/test-db.ts');
const { createDatabase } = await import('../../src/db/connection.ts');
const { initializeSchema } = await import('../../src/db/schema.ts');
const { runMigrations } = await import('../../src/db/migrations.ts');
const { TransformersEmbeddingProvider } = await import('../../src/embeddings/transformers.ts');
const { CachedEmbeddingProvider } = await import('../../src/embeddings/cache.ts');
const { handleStore } = await import('../../src/tools/store.ts');
const { handleSearch } = await import('../../src/tools/search.ts');

// ── Realistic project: "Helios" — a B2B billing SaaS ──────────────────────
// Each memory has a stable `key` so queries can name their gold-standard hit.
// (Reused/extended from scripts/battle/sim-solo.mjs so results are comparable.)
const CORPUS = [
  { key: 'auth-jwt', document_type: 'decision', content: 'We chose JWT bearer tokens over session cookies for the API because the mobile app and the web SPA share one stateless auth path; tokens carry role claims and expire after 15 minutes with a refresh token.' },
  { key: 'db-postgres', document_type: 'decision', content: 'Primary datastore is PostgreSQL 16 on RDS. We rejected DynamoDB because our billing queries are heavily relational (invoices join line-items join customers) and we need ACID transactions for charge reconciliation.' },
  { key: 'stripe-webhooks', document_type: 'pattern', content: 'Stripe webhook handlers must be idempotent: we store the Stripe event id in a processed_events table and short-circuit duplicates, because Stripe retries webhooks and can deliver the same event multiple times.' },
  { key: 'rate-limit', document_type: 'convention', content: 'All public API endpoints are rate limited with a token bucket: 100 requests per minute per API key, returning HTTP 429 with a Retry-After header when exceeded.' },
  { key: 'invoice-rounding-bug', document_type: 'error_fix', content: 'Fixed a money rounding bug: invoice totals were computed in floating point dollars causing off-by-one-cent errors. We now store and compute everything in integer cents and only format to dollars at the presentation layer.' },
  { key: 'timezone-bug', document_type: 'error_fix', content: 'Bug fix: subscription renewal dates drifted by a day for customers in negative UTC offsets because we used local server time. All renewal math now runs in UTC and converts to the customer timezone only for display.' },
  { key: 'tenant-isolation', document_type: 'decision', content: 'Multi-tenancy uses a shared database with a tenant_id column and PostgreSQL row-level security policies, not a database-per-tenant model, to keep migrations and connection pooling manageable at our scale.' },
  { key: 'cache-redis', document_type: 'pattern', content: 'We cache customer entitlement lookups in Redis with a 60-second TTL and bust the key on any subscription change event, because entitlement is read on every API request and must be fast.' },
  { key: 'deploy-bluegreen', document_type: 'convention', content: 'Production deploys are blue-green on ECS: the new task set takes traffic only after health checks pass, and we keep the old set warm for 10 minutes for instant rollback.' },
  { key: 'pii-encryption', document_type: 'decision', content: 'Customer PII (tax IDs, bank account numbers) is encrypted at rest with envelope encryption using AWS KMS; the data key is rotated quarterly and we never log decrypted PII.' },
  { key: 'search-elastic', document_type: 'decision', content: 'Full-text invoice search is powered by OpenSearch, not Postgres full-text, because finance users need fuzzy matching on customer names and faceted filters across millions of invoices.' },
  { key: 'queue-sqs', document_type: 'pattern', content: 'Asynchronous jobs (PDF invoice generation, dunning emails) go through SQS with a dead-letter queue after 3 failed attempts, so a poison message never blocks the worker pool.' },
  { key: 'graphql-rejected', document_type: 'decision', content: 'We evaluated GraphQL for the public API and rejected it in favor of REST with OpenAPI, because our enterprise customers wanted stable, versioned, easily-cacheable endpoints and most had no GraphQL tooling.' },
  { key: 'feature-flags', document_type: 'pattern', content: 'Feature flags are evaluated server-side via LaunchDarkly and the flag state is included in the bootstrap payload so the frontend never flickers between flag states on load.' },
  { key: 'n-plus-one-fix', document_type: 'error_fix', content: 'Performance fix: the invoice list endpoint had an N+1 query loading each line item separately. We added a single batched join with DataLoader-style aggregation, cutting p95 latency from 1.8s to 140ms.' },
  { key: 'password-hash', document_type: 'convention', content: 'Passwords are hashed with Argon2id (memory 64MB, iterations 3). We migrated off bcrypt because Argon2 is more resistant to GPU cracking and is the current OWASP recommendation.' },
  { key: 'cors-policy', document_type: 'convention', content: 'CORS allows only our first-party web origins; the API rejects wildcard origins and credentials are only sent to allowlisted domains to prevent token theft from malicious sites.' },
  { key: 'observability', document_type: 'decision', content: 'Observability stack is OpenTelemetry traces to Honeycomb plus structured JSON logs to Datadog. Every request carries a trace id propagated through SQS so async work links back to the originating API call.' },
  { key: 'dunning-flow', document_type: 'pattern', content: 'Dunning: when a card is declined we retry the charge on days 1, 3, 5, and 7, sending escalating emails, and downgrade the account to read-only on day 8 rather than deleting data.' },
  { key: 'migration-zero-downtime', document_type: 'convention', content: 'Schema migrations are expand-contract: add nullable columns, backfill in batches, switch reads, then drop old columns in a later deploy — never a blocking ALTER on a hot table.' },
  { key: 'webhook-signing', document_type: 'pattern', content: 'Outbound webhooks to customers are signed with an HMAC-SHA256 signature in the header so the receiver can verify the payload came from us and was not tampered with.' },
  { key: 'soft-delete', document_type: 'convention', content: 'Customer records are soft-deleted with a deleted_at timestamp and excluded from default queries, because finance and legal require us to retain billing history for seven years.' },
  { key: 'load-test', document_type: 'decision', content: 'We load test with k6 before every major release, targeting 5x current peak traffic; the gate is p99 under 500ms and zero 5xx errors over a 30 minute soak.' },
  { key: 'secret-rotation', document_type: 'convention', content: 'Application secrets live in AWS Secrets Manager and are rotated automatically every 30 days; the app reloads credentials without a restart by re-reading on a cache miss.' },
];

// Natural-language queries a developer would actually ask, each mapped to the
// single best-matching memory. This is the relevance gold standard.
const QUERIES = [
  { q: 'How do we authenticate API requests?', gold: 'auth-jwt' },
  { q: 'Why did we pick our database?', gold: 'db-postgres' },
  { q: 'How do we avoid processing the same Stripe event twice?', gold: 'stripe-webhooks' },
  { q: 'What happens when a customer hits the API too often?', gold: 'rate-limit' },
  { q: 'How did we fix the money rounding problem on invoices?', gold: 'invoice-rounding-bug' },
  { q: 'subscription renewal date off by one day', gold: 'timezone-bug' },
  { q: 'how is data separated between customers', gold: 'tenant-isolation' },
  { q: 'how do we make entitlement checks fast', gold: 'cache-redis' },
  { q: 'how do we roll out new versions to production safely', gold: 'deploy-bluegreen' },
  { q: 'how do we protect sensitive customer data at rest', gold: 'pii-encryption' },
  { q: 'why not GraphQL for the public API', gold: 'graphql-rejected' },
  { q: 'the invoice list page was slow, what did we do', gold: 'n-plus-one-fix' },
  { q: 'what algorithm do we use for passwords', gold: 'password-hash' },
  { q: 'how do we retry failed card charges', gold: 'dunning-flow' },
  { q: 'how do we run database migrations without downtime', gold: 'migration-zero-downtime' },
  { q: 'how long do we keep deleted customers', gold: 'soft-delete' },
];

const NAMESPACE = 'helios';
const SCALE = Math.max(1, parseInt(process.env.BENCH_CORPUS_SCALE ?? '1', 10) || 1);
const DB_PATH = process.env.BENCH_DB ?? ':memory:';

/**
 * Fresh database with the full schema + migrations. In-memory by default;
 * BENCH_DB=path uses a real file (cleared first) to exercise on-disk latency.
 */
function freshDb() {
  if (DB_PATH === ':memory:') return createTestDb();
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try { rmSync(f); } catch { /* nothing to remove */ }
  }
  const db = createDatabase(DB_PATH);
  initializeSchema(db);
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
  return db;
}

// ── Store the corpus ──────────────────────────────────────────────────────
// At SCALE > 1 we duplicate the corpus with distinct content (a numeric suffix)
// so every row is a unique vector — this loads the index for latency-at-scale
// without polluting the gold set (only the first, unsuffixed copy is graded).
const db = freshDb();
const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();

const keyToId = new Map();
const storeLatencies = [];
for (let copy = 0; copy < SCALE; copy++) {
  for (const m of CORPUS) {
    const content = copy === 0 ? m.content : `${m.content} (variant ${copy})`;
    const t = performance.now();
    const res = await handleStore(db, embedder, {
      content,
      document_type: m.document_type,
      scope: 'project',
      namespace: NAMESPACE,
    });
    storeLatencies.push(performance.now() - t);
    if (copy === 0) keyToId.set(m.key, res.memory.id);
  }
}

const totalRows = CORPUS.length * SCALE;

// ── Retrieval quality, with and without the cross-encoder reranker ─────────
async function runQueries(rerank) {
  const ranks = [];
  const latencies = [];
  const misses = [];
  for (const { q, gold } of QUERIES) {
    const goldId = keyToId.get(gold);
    const t = performance.now();
    const res = await handleSearch(db, embedder, {
      query: q,
      limit: 10,
      detail_level: 'summary',
      scope: 'project',
      namespace: NAMESPACE,
      rerank,
    });
    latencies.push(performance.now() - t);
    const ids = res.results.map((r) => r.id);
    const idx = ids.indexOf(goldId); // 0-based, -1 if absent
    const rank = idx < 0 ? null : idx + 1; // 1-based, null = miss
    ranks.push(rank);
    if (rank === null || rank > 3) {
      misses.push({ q, gold, rank: rank ?? 'MISS' });
    }
  }
  return { ranks, latencies, misses };
}

const round = (x, d = 1) => +x.toFixed(d);
function latencyBlock(samples) {
  return { avg_ms: round(average(samples)), p95_ms: round(percentile(samples, 95)) };
}
function qualityBlock({ ranks, latencies, misses }) {
  const s = summarizeRanks(ranks);
  return {
    queries: s.queries,
    precision_at_1: round(s.precision_at_1, 3),
    precision_at_3: round(s.precision_at_3, 3),
    mrr: round(s.mrr, 3),
    search_latency: latencyBlock(latencies),
    misses,
  };
}

const noRerank = await runQueries(false);
const withRerank = await runQueries(true);

db.close();

const report = {
  benchmark: 'mcp-memory retrieval (R0)',
  local: true,
  cost_per_token_usd: 0,
  model: {
    embedder: embedder.modelName,
    dimensions: embedder.dimensions,
    reranker: 'Xenova/ms-marco-MiniLM-L-6-v2',
  },
  corpus: {
    gold_set_size: CORPUS.length,
    scale: SCALE,
    total_rows: totalRows,
    db: DB_PATH === ':memory:' ? 'memory' : 'file',
  },
  store_latency: latencyBlock(storeLatencies),
  no_rerank: qualityBlock(noRerank),
  rerank: qualityBlock(withRerank),
  precision_at_1_lift: round(
    summarizeRanks(withRerank.ranks).precision_at_1 -
      summarizeRanks(noRerank.ranks).precision_at_1,
    3,
  ),
  mrr_lift: round(
    summarizeRanks(withRerank.ranks).mrr - summarizeRanks(noRerank.ranks).mrr,
    3,
  ),
};

// Machine-readable JSON on stdout — pipe to a file or jq.
console.log(JSON.stringify(report, null, 2));
