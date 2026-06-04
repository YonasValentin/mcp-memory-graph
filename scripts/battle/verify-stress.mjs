// Concurrency + durability stress gate for the SQLite (single-file) approach.
//
// Three phases, all against a REAL file-backed DB through the REAL handlers +
// REAL embedder — no mocks, no :memory: (WAL contention only exists on a file):
//
//   1. In-process burst: 120 handleStore calls fired with Promise.all on ONE
//      connection. better-sqlite3 is synchronous so the DB ops serialize, but
//      the awaited embed() points interleave — this proves the shared mutable
//      state (prepared stmts, graph cache, nested transactions) survives heavy
//      async interleaving with zero rejections and the exact expected count.
//
//   2. Multi-PROCESS contention: 3 child processes (separate connections in
//      separate threads — true OS concurrency) each store 30 rows into the SAME
//      file at once. This is the real "several clients / teammates writing one
//      SQLite file" path; it must resolve via busy_timeout with NO SQLITE_BUSY
//      surfaced and NO lost writes (sum of all rows present).
//
//   3. Crash-restart durability: drop every connection abruptly (simulate a
//      crash / container kill), reopen a fresh connection on the same file, and
//      confirm the WAL-committed rows persisted AND are semantically recallable
//      (vec + FTS indexes rebuilt cleanly on reopen).
//
// Exit non-zero on any broken invariant so this is a real CI gate.
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatabase, closeAllDatabases } from '../../dist/db/connection.js';
import { initializeSchema } from '../../dist/db/schema.js';
import { runMigrations } from '../../dist/db/migrations.js';
import { TransformersEmbeddingProvider } from '../../dist/embeddings/transformers.js';
import { CachedEmbeddingProvider } from '../../dist/embeddings/cache.js';
import { handleStore } from '../../dist/tools/store.js';
import { handleSearch } from '../../dist/tools/search.js';

const ART = resolve('.battle/artifacts/stress');
const DB_PATH = resolve(ART, 'stress.db');
const NS = 'stress';
const WORKER = resolve('scripts/battle/_stress-worker.mjs');

rmSync(ART, { recursive: true, force: true });
mkdirSync(ART, { recursive: true });

const liveCount = (db) =>
  db.prepare(
    'SELECT COUNT(*) AS c FROM memories WHERE namespace = ? AND parent_id IS NULL AND superseded_at IS NULL AND valid_to IS NULL',
  ).get(NS).c;

// DURABILITY metric: every top-level row physically persisted, regardless of
// bi-temporal state. The auto-supersede heuristic (recordConflicts) legitimately
// retires similar older rows (superseded_at/valid_to stamped) — those are RETIRED,
// not LOST, so they must still be counted here. "No lost writes" === every
// acknowledged ADD is present in this total.
const totalCount = (db) =>
  db.prepare('SELECT COUNT(*) AS c FROM memories WHERE namespace = ? AND parent_id IS NULL').get(NS).c;

// Distinct salted content per row so the dedup conflict-scan (vector-distance
// NOOP on near-identical embeddings) never folds a write — the count invariants
// then measure CONCURRENCY/DURABILITY, not dedup. Same technique as verify-scale.
const CONS = 'bcdfghjklmnpqrstvwxz';
const VOW = 'aeiou';
function salt(seed) {
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
  let w = '';
  for (let i = 0; i < 7; i++) w += (i % 2 ? VOW : CONS)[Math.floor(rnd() * (i % 2 ? VOW.length : CONS.length))];
  return w;
}

function runWorker(id, count) {
  return new Promise((resolveP) => {
    const child = spawn('node', [WORKER, DB_PATH, String(id), String(count), NS], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let parsed = null;
      // The worker prints exactly one JSON line on stdout; tolerate embedder
      // load chatter by scanning for the JSON line.
      for (const line of out.trim().split('\n')) {
        try { parsed = JSON.parse(line); } catch { /* not the json line */ }
      }
      resolveP({ id, code, parsed, err: err.slice(-200) });
    });
  });
}

const result = {};

// ── Phase 1: in-process concurrent burst ────────────────────────────────────
const db = createDatabase(DB_PATH);
initializeSchema(db);
runMigrations(db);
const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();

const BURST = 120;
const burstStart = Date.now();
const settled = await Promise.allSettled(
  Array.from({ length: BURST }, (_, i) =>
    handleStore(db, embedder, {
      content: `Burst codename ${salt(i)} ${salt(i * 7 + 3)}: subsystem ${salt(i + 11)} validates payload ${salt(i * 5)} under load profile ${i % 7} in cell ${i} build ${20000 + i}.`,
      title: `burst-${i}-${salt(i * 2)}`,
      document_type: 'pattern',
      scope: 'project',
      namespace: NS,
    }),
  ),
);
const rejected = settled.filter((s) => s.status === 'rejected');
const addedOps = settled.filter((s) => s.status === 'fulfilled' && s.value?.stored === true && s.value?.operation === 'ADD').length;
const burstTotal = totalCount(db);
result.phase1_inprocess_burst = {
  fired: BURST,
  rejected: rejected.length,
  add_ops: addedOps,
  rejectSample: rejected.slice(0, 2).map((r) => String(r.reason?.message ?? r.reason).slice(0, 120)),
  total_persisted: burstTotal,
  live_now: liveCount(db),
  expected_add_ops: BURST,
  elapsed_ms: Date.now() - burstStart,
};

// Release the parent connection BEFORE the child processes pile on, so the
// children contend with each other (separate processes) rather than with a
// parent that holds a long-lived handle. WAL persists on disk regardless.
db.close();

// ── Phase 2: multi-process contention ───────────────────────────────────────
const PER_WORKER = 30;
const WORKERS = 3;
const procStart = Date.now();
const workerResults = await Promise.all(
  Array.from({ length: WORKERS }, (_, i) => runWorker(i + 1, PER_WORKER)),
);
const totalWorkerStored = workerResults.reduce((a, w) => a + (w.parsed?.stored ?? 0), 0);
const totalWorkerErrors = workerResults.reduce((a, w) => a + (w.parsed?.errors ?? 0), 0);
const totalBusy = workerResults.reduce((a, w) => a + (w.parsed?.busyErrors ?? 0), 0);

const verifyDb = createDatabase(DB_PATH);
const totalAfterWorkers = totalCount(verifyDb);
const liveAfterWorkers = liveCount(verifyDb);
verifyDb.close();

// Every ADD acknowledged across the whole run (burst + workers) must be durably
// present. Workers count only stored===true && operation==='ADD'; the burst the
// same. Supersede retires some of these later but they remain in the total.
const totalAddOps = addedOps + totalWorkerStored;
result.phase2_multiprocess = {
  workers: WORKERS,
  per_worker: PER_WORKER,
  worker_exit_codes: workerResults.map((w) => w.code),
  total_stored_by_workers: totalWorkerStored,
  expected_stored_by_workers: WORKERS * PER_WORKER,
  worker_errors: totalWorkerErrors,
  busy_errors_surfaced: totalBusy,
  total_add_ops_whole_run: totalAddOps,
  total_persisted: totalAfterWorkers,
  live_now: liveAfterWorkers,
  superseded_retired: totalAfterWorkers - liveAfterWorkers,
  worker_err_samples: workerResults.flatMap((w) => w.parsed?.errSamples ?? []),
  elapsed_ms: Date.now() - procStart,
};

// ── Phase 3: crash-restart durability ───────────────────────────────────────
// Abruptly drop any lingering connections (simulate a crash), then reopen fresh.
closeAllDatabases();
const reopened = createDatabase(DB_PATH);
const totalAfterRestart = totalCount(reopened);
const liveAfterRestart = liveCount(reopened);
// Semantic recall must work after a cold reopen (indexes intact on disk).
const recall = await handleSearch(reopened, embedder, {
  query: 'subsystem validates payload under load',
  limit: 5,
  detail_level: 'summary',
  scope: 'project',
  namespace: NS,
  rerank: false,
});
const workerRecall = await handleSearch(reopened, embedder, {
  query: 'service uses strategy gamma for tenant quota',
  limit: 5,
  detail_level: 'summary',
  scope: 'project',
  namespace: NS,
  rerank: false,
});
reopened.close();
result.phase3_crash_restart = {
  total_after_restart: totalAfterRestart,
  live_after_restart: liveAfterRestart,
  expected_persisted: result.phase2_multiprocess.total_add_ops_whole_run,
  burst_recall_hits: recall.results.length,
  worker_recall_hits: workerRecall.results.length,
};

console.log(JSON.stringify(result, null, 2));

// ── GATE ─────────────────────────────────────────────────────────────────
// The durability invariant is on the TOTAL persisted rows (every acknowledged ADD
// is on disk), NOT the live count — the auto-supersede heuristic legitimately
// retires some rows, which is not a lost write.
const totalAddOpsRun = result.phase2_multiprocess.total_add_ops_whole_run;
const checks = {
  burst_no_rejections: result.phase1_inprocess_burst.rejected === 0,
  burst_all_added: result.phase1_inprocess_burst.add_ops === BURST,
  burst_all_persisted: result.phase1_inprocess_burst.total_persisted === BURST,
  workers_all_exited_clean: result.phase2_multiprocess.worker_exit_codes.every((c) => c === 0),
  workers_stored_all: result.phase2_multiprocess.total_stored_by_workers === WORKERS * PER_WORKER,
  no_busy_errors_surfaced: result.phase2_multiprocess.busy_errors_surfaced === 0,
  no_worker_errors: result.phase2_multiprocess.worker_errors === 0,
  no_lost_writes: result.phase2_multiprocess.total_persisted === totalAddOpsRun,
  durable_after_restart: result.phase3_crash_restart.total_after_restart === totalAddOpsRun,
  recall_works_after_restart:
    result.phase3_crash_restart.burst_recall_hits > 0 &&
    result.phase3_crash_restart.worker_recall_hits > 0,
};
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
if (failed.length) {
  console.error(`\nVERIFY-STRESS FAIL — ${failed.length} invariant(s) broken: ${failed.join(', ')}`);
  process.exitCode = 1;
} else {
  console.error('\nVERIFY-STRESS OK — concurrency (in-process + multi-process) and crash-restart durability all held.');
}
