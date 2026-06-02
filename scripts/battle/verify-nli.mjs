// GAP 1 — R3 NLI write-gate REAL-runtime verification.
//
// The unit suite (src/__tests__/tools/store-nli-write-gate.test.ts) proves the
// gate logic with a DETERMINISTIC StubNli + a synthetic ProximityEmbedder. This
// harness proves the PRODUCTION path end-to-end: a real on-disk SQLite DB (the
// same createDatabase + initializeSchema + runMigrations the server uses), the
// real CachedEmbeddingProvider(TransformersEmbeddingProvider) (all-MiniLM-L6-v2),
// and the real CrossEncoderNli cross-encoder (Xenova/nli-deberta-v3-xsmall) —
// the exact classifier server.ts's getNli() constructs — injected into the real
// handleStore.
//
// It asserts the canonical self-correcting scenario from the R3 fix:
//   1. store "The API runs on port 3000."        (on_conflict default 'add')
//   2. store "The API does NOT run on port 3000; it runs on port 8080."
// → the negation is detected as a CONTRADICTION (not swallowed as a duplicate
//   NOOP): the new memory is ADDED, the old one is bi-temporally invalidated
//   (valid_to set, row retained), and the conflict is recorded in
//   memory_conflicts. Two control stores (an unrelated fact + a true paraphrase)
//   confirm NO false contradictions.
//
// Measures: NLI model load time and per-store added latency when the shortlist
// is non-empty (the case where classify() actually runs).
//
// Run after `npm run build`:  node scripts/battle/verify-nli.mjs
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createDatabase } from '../../dist/db/connection.js';
import { initializeSchema } from '../../dist/db/schema.js';
import { runMigrations } from '../../dist/db/migrations.js';
import { CachedEmbeddingProvider } from '../../dist/embeddings/cache.js';
import { TransformersEmbeddingProvider } from '../../dist/embeddings/transformers.js';
import { CrossEncoderNli } from '../../dist/graph/contradiction.js';
import { handleStore } from '../../dist/tools/store.js';
import { findNearDuplicates } from '../../dist/db/repository.js';

const failures = [];
function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures.push(name + (detail ? `: ${detail}` : ''));
  return ok;
}

function validToOf(db, id) {
  return db.prepare('SELECT valid_to FROM memories WHERE id = ?').get(id)?.valid_to ?? null;
}
function rowExists(db, id) {
  return !!db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
}
function memCount(db) {
  return db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
}
function conflictRows(db) {
  // memory_conflicts: old_memory_id = the superseded/contradicted (existing) fact,
  // new_memory_id = the memory that triggered the conflict.
  return db.prepare('SELECT old_memory_id, new_memory_id, conflict_type, description FROM memory_conflicts').all();
}

// ── Real DB (on-disk temp file — the production connection.ts uses a file, not
//    :memory:; this exercises the same WAL + sqlite-vec + FK pragmas). ──
const dbPath = path.join(os.tmpdir(), `verify-nli-${process.pid}-${Date.now()}.db`);
const db = createDatabase(dbPath);
initializeSchema(db);
runMigrations(db);

// ── Real cached transformers embedder (the production stack). ──
const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
const tEmb0 = Date.now();
let embedderLoadMs = null;
try {
  await embedder.initialize();
  embedderLoadMs = Date.now() - tEmb0;
} catch (err) {
  console.log(JSON.stringify({ status: 'PARTIAL', reason: 'embedder load failed', error: String(err?.message ?? err) }));
  process.exit(2);
}

// ── Real production NLI classifier (exactly what server.ts getNli() builds). ──
const nli = new CrossEncoderNli();
console.log(`NLI model: ${nli.modelName}`);

// Force-load the model up front so we can measure load time in isolation and
// catch an offline/no-cache failure cleanly (PARTIAL, not a crash). The gate is
// supposed to fail-soft, but we want a clean signal here.
let nliLoadMs = null;
{
  const t0 = Date.now();
  try {
    // classify() lazy-loads on first call; a trivial pair triggers the download/load.
    await nli.classify('warm up premise', 'warm up hypothesis');
    nliLoadMs = Date.now() - t0;
    check('NLI model loads (real cross-encoder)', nli.isReady(), `${nli.modelName}, load ${nliLoadMs}ms`);
  } catch (err) {
    const msg = String(err?.message ?? err);
    console.log(JSON.stringify({
      status: 'PARTIAL',
      reason: 'NLI model could not load (likely no cache + offline)',
      modelName: nli.modelName,
      error: msg,
    }, null, 2));
    // Confirm the gate fails-soft: handleStore must NOT throw when classify() throws.
    try {
      await handleStore(db, embedder, { content: 'Fail-soft probe A' }, nli);
      await handleStore(db, embedder, { content: 'Fail-soft probe A revised' }, nli);
      console.log('FAIL-SOFT CONFIRMED: handleStore did not throw despite NLI load failure.');
    } catch (e2) {
      console.log('FAIL-SOFT VIOLATION: handleStore threw on NLI load failure: ' + String(e2?.message ?? e2));
    }
    process.exit(2);
  }
}

// Sanity-check the real classifier on a hand-labeled pair so we know the model
// (not just the load) actually discriminates — and that id2label maps right.
// NOTE on the unrelated pair: MNLI cross-encoders (this DeBERTa included)
// notoriously over-predict `contradiction` on UNRELATED sentence pairs — there
// is no real entailment/contradiction relation, but the 3-way softmax still
// picks one. That is exactly WHY the production gate only feeds NLI candidates
// from the vector shortlist (≤0.7 L2): an unrelated fact embeds FAR away
// (verified below at ~1.3 L2) and never reaches the classifier, so the
// over-prediction can never cause a false retire on the store path. We assert
// the model discriminates the IN-WINDOW pairs (negation vs. paraphrase) and
// separately assert the shortlist is the safety net for the unrelated pair.
{
  const contra = await nli.classify('The API runs on port 3000.', 'The API does not run on port 3000; it runs on port 8080.');
  const entail = await nli.classify('The API runs on port 3000.', 'The service listens on port 3000.');
  const unrelated = await nli.classify('The API runs on port 3000.', 'The marketing team meets on Tuesdays.');
  console.log(`  raw NLI: contra=${JSON.stringify(contra)} entail=${JSON.stringify(entail)} unrelated=${JSON.stringify(unrelated)}`);
  check('real NLI labels the negation pair "contradiction"', contra.label === 'contradiction',
    `label=${contra.label} score=${contra.score.toFixed(3)}`);
  check('real NLI does NOT call the in-window paraphrase a contradiction', entail.label !== 'contradiction',
    `label=${entail.label} score=${entail.score.toFixed(3)}`);
  // Documented model behavior, not a code assertion: the unrelated pair often
  // scores contradiction. We log it and rely on the shortlist guard (asserted
  // below) — NOT on the raw model — to prevent a false store-path retire.
  console.log(`  (note) raw NLI on UNRELATED pair => ${unrelated.label} (${unrelated.score.toFixed(3)}); shortlist guard prevents this reaching the store gate`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENARIO — the canonical self-correcting store.
// ─────────────────────────────────────────────────────────────────────────────

// 1. Original fact (default on_conflict = 'add').
const orig = await handleStore(db, embedder, { content: 'The API runs on port 3000.' }, nli);
check('original fact stored', orig.stored && orig.operation === 'ADD', `op=${orig.operation}`);
check('original fact currently valid (valid_to null)', validToOf(db, orig.memory.id) === null);

// Diagnostic: confirm the negation actually lands in the NLI shortlist window
// (≤0.7 L2). If it didn't, the real path could never reach classify() and the
// test would be vacuous.
const negEmbedding = await embedder.embed('The API does NOT run on port 3000; it runs on port 8080.');
const shortlist = findNearDuplicates(db, negEmbedding, 0.7, 10);
check('negation lands within NLI shortlist window (≤0.7 L2)', shortlist.length > 0,
  `shortlist=${shortlist.length}, nearest L2=${shortlist[0]?.distance?.toFixed(4) ?? 'none'}`);

const beforeNeg = memCount(db);

// 2. The negation — default on_conflict, real NLI injected. THIS is the path
//    that previously dropped the correction as a duplicate/NOOP.
const tNeg0 = Date.now();
const neg = await handleStore(db, embedder, { content: 'The API does NOT run on port 3000; it runs on port 8080.' }, nli);
const negStoreMs = Date.now() - tNeg0; // includes embed + NLI classify over the shortlist

check('negation NOT swallowed as duplicate/NOOP (stored=true)', neg.stored === true, `stored=${neg.stored}`);
check('negation reported as DELETE (self-correction)', neg.operation === 'DELETE', `op=${neg.operation}`);
check('both facts retained — new one added', memCount(db) === beforeNeg + 1,
  `count ${beforeNeg} -> ${memCount(db)}`);
check('superseded fact is INVALIDATED (valid_to set), not duplicate-NOOPed',
  validToOf(db, orig.memory.id) !== null, `valid_to=${validToOf(db, orig.memory.id)}`);
check('superseded fact ROW still present (bi-temporal retire, not hard delete)',
  rowExists(db, orig.memory.id));
check('operation_reason mentions contradiction', /contradiction/i.test(neg.operation_reason),
  neg.operation_reason);

// memory_conflicts audit row recorded against the original fact.
const conflicts = conflictRows(db);
const contraRow = conflicts.find((c) => c.old_memory_id === orig.memory.id);
check('contradiction recorded in memory_conflicts', conflicts.length > 0, `rows=${conflicts.length}`);
check('recorded conflict references the original fact (old_memory_id) and is typed contradicted',
  !!contraRow && /contradict/i.test(contraRow.conflict_type),
  contraRow ? `old=${contraRow.old_memory_id.slice(0,8)} new=${contraRow.new_memory_id.slice(0,8)} type=${contraRow.conflict_type}` : 'no row referencing original');
check('response conflicts never mislabel the correction a duplicate',
  (neg.conflicts ?? []).every((c) => c.type !== 'duplicate'),
  JSON.stringify((neg.conflicts ?? []).map((c) => c.type)));

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLS — no false contradictions.
// ─────────────────────────────────────────────────────────────────────────────

// (a) Unrelated fact — must be a clean ADD, must not retire anything. First
//     prove the shortlist GUARD holds: the unrelated content embeds OUTSIDE the
//     0.7 L2 window, so NLI never even sees it (this is what insulates the gate
//     from the model's unrelated-pair over-prediction noted above).
const unrelContent = 'The marketing team meets every Tuesday at 10am.';
const unrelEmbedding = await embedder.embed(unrelContent);
const unrelShortlist = findNearDuplicates(db, unrelEmbedding, 0.7, 10);
check('SAFETY NET: unrelated fact is OUTSIDE the NLI shortlist window (never reaches classify)',
  unrelShortlist.length === 0,
  `shortlist=${unrelShortlist.length} (unrelated content does not vector-match any stored fact)`);
const beforeUnrel = memCount(db);
const validBefore8080 = validToOf(db, neg.memory.id);
const unrel = await handleStore(db, embedder, { content: unrelContent }, nli);
check('unrelated fact is a clean ADD (no false contradiction)', unrel.operation === 'ADD', `op=${unrel.operation}`);
check('unrelated store retired nothing', memCount(db) === beforeUnrel + 1 && validToOf(db, neg.memory.id) === validBefore8080);

// (b) True paraphrase of the CURRENT (8080) fact — semantically agrees, so the
//     NLI must NOT flag a contradiction. (It may be heuristic-deduped or added;
//     the only requirement is it does not get reported as a `contradicted`
//     conflict and does not retire the current 8080 fact via NLI.)
const conflictsBeforePara = conflictRows(db).length;
const para = await handleStore(db, embedder, { content: 'Port 8080 is where the API listens.' }, nli);
const newContraConflicts = conflictRows(db)
  .slice(conflictsBeforePara)
  .filter((c) => /contradict/i.test(c.conflict_type));
check('true paraphrase produces NO new contradiction conflict', newContraConflicts.length === 0,
  `new contradiction rows=${newContraConflicts.length}, op=${para.operation}`);
check('paraphrase did not NLI-retire the current 8080 fact',
  // The 8080 fact is the still-valid neg.memory; a paraphrase agreeing with it
  // must not flip its operation to a contradiction-DELETE of that same fact.
  !(para.operation === 'DELETE' && /contradiction/i.test(para.operation_reason) &&
    new RegExp(neg.memory.id).test(para.operation_reason)),
  `op=${para.operation} reason="${para.operation_reason}"`);

// ─────────────────────────────────────────────────────────────────────────────
// LATENCY — per-store added latency when the shortlist is non-empty (classify
// runs). Re-run the negation-style store a few times against a populated DB.
// ─────────────────────────────────────────────────────────────────────────────
const latencies = [];
const variants = [
  'The database does NOT use connection pooling in staging.',
  'We do NOT deploy on Fridays anymore.',
  'The cache TTL is NOT 60 seconds; it is 300 seconds.',
];
// Seed premises so each variant has a near neighbor (non-empty shortlist).
await handleStore(db, embedder, { content: 'The database uses connection pooling in staging.' }, nli);
await handleStore(db, embedder, { content: 'We deploy on Fridays.' }, nli);
await handleStore(db, embedder, { content: 'The cache TTL is 60 seconds.' }, nli);
for (const v of variants) {
  const t = Date.now();
  await handleStore(db, embedder, { content: v }, nli);
  latencies.push(Date.now() - t);
}
latencies.sort((a, b) => a - b);
const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);

console.log('\n=== MEASUREMENTS ===');
console.log(JSON.stringify({
  embedderLoadMs,
  nliModel: nli.modelName,
  nliLoadMs,
  negationStoreMs: negStoreMs,
  perStoreWithNonEmptyShortlist: { samples: latencies, avgMs: avg, minMs: latencies[0], maxMs: latencies[latencies.length - 1] },
  totalMemories: memCount(db),
  totalConflicts: conflictRows(db).length,
}, null, 2));

db.close();
try { fs.unlinkSync(dbPath); fs.rmSync(dbPath + '-wal', { force: true }); fs.rmSync(dbPath + '-shm', { force: true }); } catch {}

console.log(`\n=== ${failures.length === 0 ? 'ALL CHECKS PASSED' : failures.length + ' CHECK(S) FAILED'} ===`);
if (failures.length > 0) for (const f of failures) console.log('  FAIL: ' + f);
// Set the exit code and let the process drain naturally. We deliberately do NOT
// call process.exit() here: the onnxruntime-node worker threads behind the NLI
// model crash with `std::system_error: mutex lock failed` if the process is
// hard-exited mid-teardown (reproducible; probe-embedder.mjs, which never calls
// process.exit, exits cleanly). Natural drain lets ORT finish unwinding.
process.exitCode = failures.length > 0 ? 1 : 0;
