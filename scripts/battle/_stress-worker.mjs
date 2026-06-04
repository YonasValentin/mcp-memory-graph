// Child worker for verify-stress.mjs — a SEPARATE OS process (hence a separate
// SQLite connection in its own thread) that hammers the SHARED file DB through
// the REAL production store handler. This is the faithful "multiple clients /
// teammates writing one SQLite file at once" path: true cross-process WAL
// contention resolved by busy_timeout, not the single-thread interleave a
// Promise.all gives. Prints one JSON line: { worker, stored, errors, busyErrors }.
import { createDatabase } from '../../dist/db/connection.js';
import { initializeSchema } from '../../dist/db/schema.js';
import { runMigrations } from '../../dist/db/migrations.js';
import { TransformersEmbeddingProvider } from '../../dist/embeddings/transformers.js';
import { CachedEmbeddingProvider } from '../../dist/embeddings/cache.js';
import { handleStore } from '../../dist/tools/store.js';

const [dbPath, workerId, countStr, namespace] = process.argv.slice(2);
const count = parseInt(countStr, 10);

// Distinct content per row so the semantic dedup conflict-scan (vector-distance
// NOOP on near-identical embeddings) never folds a write — every store must be a
// genuine ADD that contends for the write lock. Salted pseudo-words give each row
// real lexical + vector entropy (same technique as verify-scale.mjs).
const CONS = 'bcdfghjklmnpqrstvwxz';
const VOW = 'aeiou';
function salt(seed) {
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0x100000000);
  let w = '';
  for (let i = 0; i < 7; i++) w += (i % 2 ? VOW : CONS)[Math.floor(rnd() * (i % 2 ? VOW.length : CONS.length))];
  return w;
}

const db = createDatabase(dbPath);
// Schema/migrations are idempotent; the parent created them first, but a worker
// that races in still finds a ready schema (CREATE IF NOT EXISTS + version gate).
initializeSchema(db);
runMigrations(db);

const embedder = new CachedEmbeddingProvider(new TransformersEmbeddingProvider());
await embedder.initialize();

let stored = 0;
let errors = 0;
let busyErrors = 0;
const errSamples = [];

for (let i = 0; i < count; i++) {
  try {
    const r = await handleStore(db, embedder, {
      // Unique salted tokens per (worker,i) so dedup never folds a row — every
      // write is a genuine ADD that must contend for the write lock.
      content: `Worker ${workerId} codename ${salt(workerId * 1000 + i)} ${salt(i * 31 + workerId)}: subsystem ${salt(i + 7)} routes ${salt(i * 13)} via channel ${salt(workerId + i * 17)} for tenant ${workerId} row ${i} build ${10000 + workerId * 1000 + i}.`,
      title: `w${workerId}-row${i}-${salt(i)}`,
      document_type: 'decision',
      scope: 'project',
      namespace,
    });
    // Count ONLY genuine inserts: a NOOP (semantic duplicate) returns stored:false
    // with the EXISTING row's id, so checking memory.id would over-count.
    if (r?.stored === true && r?.operation === 'ADD') stored++;
  } catch (e) {
    errors++;
    const msg = String(e?.message ?? e);
    if (/SQLITE_BUSY|database is locked/i.test(msg)) busyErrors++;
    if (errSamples.length < 3) errSamples.push(msg.slice(0, 120));
  }
}

db.close();
// Natural drain — no process.exit() (the real embedder's ONNX worker aborts 134
// on a hard exit; see developing.md P14). Print result for the parent to parse.
console.log(JSON.stringify({ worker: workerId, stored, errors, busyErrors, errSamples }));
