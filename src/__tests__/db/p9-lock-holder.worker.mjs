/**
 * P9-begin-immediate test fixture — a write-lock holder that runs in its OWN
 * worker thread so it can release the lock on a timer WHILE the main thread is
 * synchronously busy-waiting inside a contended repository call. (A same-process
 * timer could never fire, because better-sqlite3 blocks the event loop while it
 * waits out busy_timeout.)
 *
 * Plain .mjs (no TypeScript): it only opens a raw better-sqlite3 connection and
 * issues SQL, so it needs no transpile step. It posts 'locked' once the write
 * lock is held, holds it for `holdMs`, commits, then posts 'released' and exits.
 */
import { workerData, parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const { dbPath, holdMs } = workerData;

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Acquire the WAL write lock at BEGIN and make a real write so it is genuinely held.
db.prepare('BEGIN IMMEDIATE').run();
db.prepare("INSERT INTO schema_meta(key, value) VALUES ('p9_probe', '1')").run();
parentPort.postMessage('locked');

// Hold for holdMs on this worker's own thread (does not block the main thread).
setTimeout(() => {
  db.prepare('COMMIT').run();
  db.close();
  parentPort.postMessage('released');
}, holdMs);
