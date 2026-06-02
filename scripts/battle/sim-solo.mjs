// REAL solo-developer simulation against a real SQLite file with the real
// embedding model and the real tool handlers. Measures retrieval QUALITY
// (precision@1, precision@3, MRR, latency) plus core memory operations.
import { rmSync, mkdirSync } from 'node:fs';
import { createDatabase } from '../../dist/db/connection.js';
import { initializeSchema } from '../../dist/db/schema.js';
import { runMigrations } from '../../dist/db/migrations.js';
import { TransformersEmbeddingProvider } from '../../dist/embeddings/transformers.js';
import { CachedEmbeddingProvider } from '../../dist/embeddings/cache.js';
import { handleStore } from '../../dist/tools/store.js';
import { handleSearch } from '../../dist/tools/search.js';
import { handleConsolidate } from '../../dist/tools/consolidate.js';
import { handleStats } from '../../dist/tools/stats.js';
import { handleGet } from '../../dist/tools/get.js';

const DB = '.battle/artifacts/solo.db';
mkdirSync('.battle/artifacts', { recursive: true });
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { rmSync(f); } catch {} }

function freshDb(path) {
  const db = createDatabase(path);
  initializeSchema(db);
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
  return db;
}

// ── Realistic project: "Helios" — a B2B billing SaaS ──────────────────────
// Each memory has a stable `key` so queries can name their gold-standard hit.
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

const db = freshDb(DB);
const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();

// ── Store the corpus ──────────────────────────────────────────────────────
const keyToId = new Map();
const storeLatencies = [];
for (const m of CORPUS) {
  const t = Date.now();
  const res = await handleStore(db, embedder, {
    content: m.content,
    document_type: m.document_type,
    scope: 'project',
    namespace: 'helios',
  });
  storeLatencies.push(Date.now() - t);
  keyToId.set(m.key, res.memory.id);
}

// ── Retrieval quality ───────────────────────────────────────────────────────
let p1 = 0, p3 = 0, rrSum = 0;
const searchLatencies = [];
const perQuery = [];
for (const { q, gold } of QUERIES) {
  const goldId = keyToId.get(gold);
  const t = Date.now();
  const res = await handleSearch(db, embedder, { query: q, limit: 10, detail_level: 'summary', rerank: process.env.RERANK === '1' });
  searchLatencies.push(Date.now() - t);
  const ids = res.results.map((r) => r.id);
  const rank = ids.indexOf(goldId); // 0-based, -1 if absent
  if (rank === 0) p1++;
  if (rank >= 0 && rank < 3) p3++;
  rrSum += rank >= 0 ? 1 / (rank + 1) : 0;
  perQuery.push({ q, gold, rank: rank < 0 ? 'MISS' : rank + 1, top: ids.slice(0, 3).map((id) => [...keyToId].find(([, v]) => v === id)?.[0] ?? '?') });
}
const n = QUERIES.length;

// ── Core ops sanity ─────────────────────────────────────────────────────────
// Near-duplicate dedup on store (default on_conflict='add' → NOOP if dup)
const dup = await handleStore(db, embedder, {
  content: 'We use JWT bearer tokens instead of session cookies for the API; tokens carry role claims and expire after 15 minutes.',
  document_type: 'decision', scope: 'project', namespace: 'helios',
});
// Supersede a fact
const sup = await handleStore(db, embedder, {
  content: 'Production deploys are now canary on Kubernetes (EKS), gradually shifting 5/25/50/100 percent of traffic, replacing the old blue-green ECS approach.',
  document_type: 'decision', scope: 'project', namespace: 'helios', on_conflict: 'supersede',
});
const stats = handleStats(db, { scope: 'project', namespace: 'helios' });
const consolidate = await handleConsolidate(db, embedder, { dry_run: true, namespace: 'helios', scope: 'project' });
const getOne = handleGet(db, { id: keyToId.get('auth-jwt') });

const pct = (x) => +(100 * x / n).toFixed(1);
const avg = (a) => +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1);
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.95)] ?? s.at(-1); };

console.log(JSON.stringify({
  corpusSize: CORPUS.length,
  rerank: process.env.RERANK === '1',
  retrieval: {
    queries: n,
    precision_at_1: `${p1}/${n} (${pct(p1)}%)`,
    precision_at_3: `${p3}/${n} (${pct(p3)}%)`,
    MRR: +(rrSum / n).toFixed(3),
  },
  latency_ms: {
    store_avg: avg(storeLatencies), store_p95: p95(storeLatencies),
    search_avg: avg(searchLatencies), search_p95: p95(searchLatencies),
  },
  coreOps: {
    dedup_on_duplicate_store: { operation: dup.operation, reused_existing: dup.memory.id === keyToId.get('auth-jwt') },
    supersede: { operation: sup.operation, reason: sup.operation_reason ?? null },
    stats_total_memories: stats.total_memories ?? stats.total_documents ?? null,
    consolidate_dryrun: { duplicates: consolidate.duplicates_found ?? consolidate.merged ?? null, errors: (consolidate.errors ?? []).length },
    get_has_links: Array.isArray(getOne.links),
  },
  misses: perQuery.filter((x) => x.rank === 'MISS' || (typeof x.rank === 'number' && x.rank > 3)),
}, null, 2));

db.close();
