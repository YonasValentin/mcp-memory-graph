// Authenticated REST server load + security gate.
//
// Boots the REAL compiled server (`node dist/index.js serve`) as a separate
// process — the exact production entrypoint — with bearer auth + rate limiting
// ENABLED, bound to loopback, against a seeded file DB. Then drives it over real
// HTTP to prove the things the in-process buildApp unit tests and verify-web
// (which runs auth-DISABLED) do not:
//
//   Phase 1 (small rate-limit bucket): auth enforcement (401 no/!wrong token,
//     200 correct; /health + /live exempt; /metrics bearer-gated) and the
//     rate-limit path (a burst returns a mix of 200/429, every 429 carries a
//     Retry-After, and the bucket RECOVERS after refill).
//
//   Phase 2 (generous bucket): concurrent-load correctness — hundreds of
//     simultaneous authed requests (list + embedding-backed search) all succeed
//     with zero 5xx, the server stays healthy, and malformed / oversized bodies
//     get structured 400/413 envelopes (not an HTML stack trace).
//
// Exits non-zero on any broken invariant.
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase } from '../../dist/db/connection.js';
import { initializeSchema } from '../../dist/db/schema.js';
import { runMigrations } from '../../dist/db/migrations.js';
import { TransformersEmbeddingProvider } from '../../dist/embeddings/transformers.js';
import { CachedEmbeddingProvider } from '../../dist/embeddings/cache.js';
import { handleStore } from '../../dist/tools/store.js';

const ART = resolve('.battle/artifacts/load');
const DB = resolve(ART, 'load.db');
const ENTRY = resolve('dist/index.js');
const TOKEN = `tok_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
const WRONG = `tok_${Math.random().toString(36).slice(2)}wrongwrong`;
const PORT = 38500 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
};

// ── Seed a file DB the server will serve ────────────────────────────────────
rmSync(ART, { recursive: true, force: true });
mkdirSync(ART, { recursive: true });
const seedDb = createDatabase(DB);
initializeSchema(seedDb);
runMigrations(seedDb);
const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();
const SEED = [
  'We authenticate API requests with JWT bearer tokens that expire after 15 minutes.',
  'The primary datastore is PostgreSQL 16 with row-level security for tenant isolation.',
  'Stripe webhooks are made idempotent by storing the event id before processing.',
  'Passwords are hashed with Argon2id at 64MB memory cost and three iterations.',
  'Production deploys are blue-green on ECS with a ten-minute rollback window.',
  'Customer PII is encrypted at rest with AWS KMS envelope encryption.',
  'Background jobs retry with exponential backoff and a dead-letter queue after three failures.',
  'Search latency is kept under 200ms at the p95 via a hybrid vector and BM25 index.',
  'Feature flags are evaluated server-side via LaunchDarkly in the bootstrap payload.',
  'Rate limiting uses a token-bucket of 30 with a refill of six per second.',
  'Outbound webhooks are signed with HMAC-SHA256 and a per-tenant secret.',
  'Schema migrations follow the expand-contract pattern to avoid downtime.',
];
let seeded = 0;
for (const content of SEED) {
  const r = await handleStore(seedDb, embedder, { content, document_type: 'decision', scope: 'project', namespace: 'load' });
  if (r?.stored) seeded++;
}
const seededId = seedDb.prepare("SELECT id FROM memories WHERE namespace='load' AND parent_id IS NULL LIMIT 1").get()?.id;
seedDb.close();

// ── Server lifecycle ────────────────────────────────────────────────────────
function bootServer(extraEnv) {
  const child = spawn('node', [ENTRY, 'serve'], {
    env: { ...process.env, MCP_AUTH_TOKEN: TOKEN, MCP_PORT: String(PORT), MCP_BIND: '127.0.0.1', MCP_MEMORY_DB_PATH: DB, MCP_METRICS_ENABLED: '1', MCP_LOG_LEVEL: 'warn', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  child.stdout.on('data', () => {});
  child.getErr = () => err.slice(-400);
  return child;
}
async function waitHealthy(timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}
function killServer(child) {
  return new Promise((r) => {
    child.on('close', () => r());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 4000);
  });
}
async function req(path, { token, method = 'GET', body, rawBody } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
  const t = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, retryAfter: res.headers.get('retry-after'), reqId: res.headers.get('x-request-id'), ms: performance.now() - t, text };
}

const result = {};

// ════════════════ PHASE 1 — auth + rate limiting (small bucket) ════════════════
let s1 = bootServer({ MCP_RATELIMIT_CAPACITY: '20', MCP_RATELIMIT_REFILL_PER_SEC: '5' });
const up1 = await waitHealthy();
// Natural drain on the error path (P14): no process.exit() while the real
// embedder's onnxruntime workers are live (a hard exit can abort 134, masking
// the result). exitCode + throw fails loudly without the abrupt exit.
if (!up1) { console.error('server (phase1) failed to come up:', s1.getErr()); await killServer(s1); process.exitCode = 1; throw new Error('phase1 server failed to come up'); }

// Auth matrix (bucket is full: well under 20 requests here).
const noTok = await req('/api/stats', { token: undefined });
const badTok = await req('/api/stats', { token: WRONG });
const goodTok = await req('/api/stats', { token: TOKEN });
const health = await req('/health', {});
const live = await req('/live', {});
const metricsGood = await req('/metrics', { token: TOKEN });
const metricsBad = await req('/metrics', { token: WRONG });
result.auth = {
  no_token_401: noTok.status,
  wrong_token_401: badTok.status,
  correct_token_200: goodTok.status,
  health_exempt_200: health.status,
  live_exempt_200: live.status,
  metrics_bearer_200: metricsGood.status,
  metrics_wrong_401: metricsBad.status,
  reqId_present: !!goodTok.reqId,
};

// Let the bucket refill to full, then burst it.
await sleep(4500);
const BURST = 80;
const burst = await Promise.all(Array.from({ length: BURST }, () => req('/api/stats', { token: TOKEN })));
const ok200 = burst.filter((b) => b.status === 200).length;
const got429 = burst.filter((b) => b.status === 429);
const all429HaveRetry = got429.length > 0 && got429.every((b) => b.retryAfter && Number(b.retryAfter) >= 1);
// Recover after refill.
await sleep(4500);
const recovered = await req('/api/stats', { token: TOKEN });
result.rate_limit = {
  burst: BURST,
  ok_200: ok200,
  rejected_429: got429.length,
  every_429_has_retry_after: all429HaveRetry,
  recovered_after_refill_200: recovered.status,
};
await killServer(s1);
await sleep(500);

// ════════════════ PHASE 2 — concurrent load correctness (generous bucket) ═══════
let s2 = bootServer({ MCP_RATELIMIT_CAPACITY: '1000000', MCP_RATELIMIT_REFILL_PER_SEC: '1000000' });
const up2 = await waitHealthy();
if (!up2) { console.error('server (phase2) failed to come up:', s2.getErr()); await killServer(s2); process.exitCode = 1; throw new Error('phase2 server failed to come up'); }

// Warm the server's embedder so the concurrent search phase isn't all paying the
// one-time model load.
const ready = await req('/ready', {});

const CONC_LIST = 300;
const listResp = await Promise.all(Array.from({ length: CONC_LIST }, () => req('/api/memories?namespace=load&limit=5', { token: TOKEN })));
const listNon200 = listResp.filter((r) => r.status !== 200);
const list5xx = listResp.filter((r) => r.status >= 500);

const CONC_SEARCH = 80;
const queries = ['how do we authenticate requests', 'tenant data isolation', 'how are passwords hashed', 'webhook idempotency', 'deploy rollback strategy'];
const searchResp = await Promise.all(
  Array.from({ length: CONC_SEARCH }, (_, i) => req(`/api/search?q=${encodeURIComponent(queries[i % queries.length])}&namespace=load&limit=5`, { token: TOKEN })),
);
const searchNon200 = searchResp.filter((r) => r.status !== 200);
const search5xx = searchResp.filter((r) => r.status >= 500);
let searchHadResults = false;
try { searchHadResults = searchResp.some((r) => (JSON.parse(r.text).results ?? []).length > 0); } catch { /* parse */ }

// Robustness: malformed + oversized bodies → structured envelopes, not HTML/500.
const malformed = await req(`/api/memories/${seededId}`, { token: TOKEN, method: 'PATCH', rawBody: '{ not valid json ' });
const huge = await req(`/api/memories/${seededId}`, { token: TOKEN, method: 'PATCH', rawBody: JSON.stringify({ content: 'x'.repeat(300 * 1024) }) });

const healthAfter = await req('/health', {});

result.concurrency = {
  embedder_ready_200: ready.status,
  list_concurrent: CONC_LIST,
  list_non_200: listNon200.length,
  list_5xx: list5xx.length,
  list_latency_p50_ms: pct(listResp.map((r) => r.ms), 50),
  list_latency_p95_ms: pct(listResp.map((r) => r.ms), 95),
  search_concurrent: CONC_SEARCH,
  search_non_200: searchNon200.length,
  search_5xx: search5xx.length,
  search_had_results: searchHadResults,
  search_latency_p95_ms: pct(searchResp.map((r) => r.ms), 95),
  malformed_json_status: malformed.status,
  malformed_json_is_400: malformed.status === 400,
  oversized_body_status: huge.status,
  oversized_body_is_413: huge.status === 413,
  healthy_after_load_200: healthAfter.status,
};
await killServer(s2);

console.log(JSON.stringify({ seeded, port: PORT, ...result }, null, 2));

// ── GATE ────────────────────────────────────────────────────────────────────
const a = result.auth, rl = result.rate_limit, c = result.concurrency;
const checks = {
  seeded_data: seeded === SEED.length,
  auth_no_token_rejected: a.no_token_401 === 401,
  auth_wrong_token_rejected: a.wrong_token_401 === 401,
  auth_correct_token_ok: a.correct_token_200 === 200,
  health_exempt: a.health_exempt_200 === 200,
  live_exempt: a.live_exempt_200 === 200,
  metrics_bearer_ok: a.metrics_bearer_200 === 200,
  metrics_wrong_rejected: a.metrics_wrong_401 === 401,
  request_id_header: a.reqId_present === true,
  rate_limit_allows_some: rl.ok_200 > 0,
  rate_limit_blocks_some: rl.rejected_429 > 0,
  rate_limit_retry_after: rl.every_429_has_retry_after === true,
  rate_limit_recovers: rl.recovered_after_refill_200 === 200,
  embedder_ready: c.embedder_ready_200 === 200,
  concurrent_list_all_ok: c.list_non_200 === 0,
  concurrent_list_no_5xx: c.list_5xx === 0,
  concurrent_search_all_ok: c.search_non_200 === 0,
  concurrent_search_no_5xx: c.search_5xx === 0,
  concurrent_search_results: c.search_had_results === true,
  malformed_json_400: c.malformed_json_is_400 === true,
  oversized_body_413: c.oversized_body_is_413 === true,
  healthy_after_load: c.healthy_after_load_200 === 200,
};
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
if (failed.length) {
  console.error(`\nVERIFY-LOAD FAIL — ${failed.length} invariant(s) broken: ${failed.join(', ')}`);
  process.exitCode = 1;
} else {
  console.error('\nVERIFY-LOAD OK — bearer auth, rate limiting, and concurrent-load correctness all held on the real server.');
}
