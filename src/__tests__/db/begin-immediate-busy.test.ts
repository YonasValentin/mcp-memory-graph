/**
 * P9-begin-immediate (battle-v3 — deferred-txn write-upgrade SQLITE_BUSY).
 *
 * better-sqlite3's `db.transaction(fn)` issues a DEFAULT-DEFERRED `BEGIN`: the
 * write lock is acquired lazily on the FIRST write statement, not at BEGIN.
 * When a read-then-write txn (SELECT … then UPDATE/DELETE) runs while another
 * connection holds the write lock, the deferred → write UPGRADE throws
 * SQLITE_BUSY IMMEDIATELY — `busy_timeout = 5000` (set in createDatabase) is
 * NOT honored on a lock UPGRADE, only on a fresh lock acquisition. Result:
 * consolidate's prune/expire/dedup stages (deleteMemory / updateMemory) swallow
 * the SQLITE_BUSY into report.errors and SILENTLY UNDER-PRUNE under concurrent
 * writers.
 *
 * Fix: invoke the read-then-write repository txns via the `.immediate` variant
 * (BEGIN IMMEDIATE acquires the write lock at BEGIN, so busy_timeout applies and
 * the txn WAITS for the holder instead of throwing). Read-only txns
 * (findNearDuplicates) and write-first INSERTs are left DEFERRED.
 *
 * These tests use a real file-backed createDatabase connection plus a SECOND
 * connection in a worker thread that holds the WAL write lock briefly. The
 * worker releases the lock on a timer running on ITS OWN thread — the main
 * thread is synchronously busy-waiting inside the contended repository call, so
 * a same-process timer could never fire. The contended call must WAIT then
 * SUCCEED rather than throw SQLITE_BUSY.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from '../../db/connection.js';
import { initializeSchema } from '../../db/schema.js';
import { runMigrations } from '../../db/migrations.js';
import { MockEmbeddingProvider } from '../../testing/mock-embedder.js';
import { handleStore } from '../../tools/store.js';
import { deleteMemory, updateMemory, getMemoryById } from '../../db/repository.js';

const embedder = new MockEmbeddingProvider();
const HOLDER_WORKER = fileURLToPath(new URL('./p9-lock-holder.worker.mjs', import.meta.url));

let dir: string;
let dbPath: string;
let actor: Database.Database; // the connection running the contended repository fn

function makeFileDb(path: string): Database.Database {
  const db = createDatabase(path);
  initializeSchema(db);
  db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'schema_version'").run();
  runMigrations(db);
  return db;
}

/**
 * Spawn a worker that holds the WAL write lock for `holdMs`. Resolves once the
 * lock is confirmed held, handing back a `released` promise that resolves when
 * the worker has committed and exited.
 */
function holdWriteLockInWorker(holdMs: number): Promise<{ released: Promise<void> }> {
  const worker = new Worker(HOLDER_WORKER, { workerData: { dbPath, holdMs } });
  const released = new Promise<void>((resolve, reject) => {
    worker.on('error', reject);
    worker.on('exit', () => resolve());
  });
  return new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (m: string) => {
      if (m === 'locked') resolve({ released });
    });
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-p9-'));
  dbPath = join(dir, 'memory.db');
  actor = makeFileDb(dbPath);
});

afterEach(() => {
  if (actor.open) actor.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('P9-begin-immediate — read-then-write txns honor busy_timeout under contention', () => {
  it('deleteMemory WAITS for a held write lock and SUCCEEDS (does not throw SQLITE_BUSY)', async () => {
    const { memory } = await handleStore(actor, embedder, { content: 'P9 delete-under-contention fact.' });

    const { released } = await holdWriteLockInWorker(250);

    const t0 = Date.now();
    // DEFERRED form: throws SQLITE_BUSY ("database is locked") in ~0ms (RED).
    // BEGIN IMMEDIATE: blocks on busy_timeout until the worker commits (GREEN).
    const ok = deleteMemory(actor, memory.id);
    const waited = Date.now() - t0;

    await released;

    expect(ok).toBe(true);
    // It actually WAITED for the holder rather than failing instantly.
    expect(waited).toBeGreaterThan(100);
    // The row is really gone — the delete committed.
    expect(getMemoryById(actor, memory.id)).toBeNull();
  });

  it('updateMemory WAITS for a held write lock and SUCCEEDS (does not throw SQLITE_BUSY)', async () => {
    const { memory } = await handleStore(actor, embedder, { content: 'P9 update-under-contention fact.' });

    const { released } = await holdWriteLockInWorker(250);

    const t0 = Date.now();
    const updated = updateMemory(actor, memory.id, { title: 'P9 updated title' });
    const waited = Date.now() - t0;

    await released;

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('P9 updated title');
    expect(waited).toBeGreaterThan(100);
  });
});
